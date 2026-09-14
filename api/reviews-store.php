<?php
/**
 * Очередь отзывов и её публикация.
 *
 * Отзыв приходит с сайта в очередь (папка выше публичной) со статусом
 * pending и лежит там, пока его не прочтёт человек. Опубликованным он
 * становится только со статусом approved.
 *
 * Публикация — это live/reviews.json рядом с ценами. Витрина читает его
 * тем же кодом, что цену и наличие, поэтому решение модератора видно
 * сразу, без пересборки каталога.
 *
 * ТОТ ЖЕ формат собирает tools/build-catalog.mjs из той же очереди.
 * Две реализации существуют потому, что сборка идёт на Node, а модерация
 * на сервере; расхождение между ними ловит тест «PHP и сборка дают
 * одинаковый live/reviews.json».
 */

declare(strict_types=1);

/*
  Файл подключается из api/index.php и сам по себе не запускается.

  Прямой запрос («/api/admin.php») исполнил бы его без настроек и без
  проверки прав, а сообщение об ошибке показало бы путь к файлам на
  сервере. Запрет в .htaccess — первая преграда, эта проверка — вторая:
  она держится и там, где .htaccess не читается.
*/
if (!defined('HB_API')) {
    http_response_code(404);
    exit;
}

/*
  Папка очереди — соседняя с папкой заказов.

  Путь собирается через dirname, а не дописыванием «/../reviews». Разница
  не косметическая: glob() не проходит через «..», если промежуточной
  папки ещё нет. На свежем сервере, где заказов пока не было и var/orders
  не создана, публикация молча находила бы ноль отзывов — и одобренный
  отзыв не появлялся бы на сайте без единой ошибки в логе.
*/
function reviews_dir(array $config): string
{
    return dirname(rtrim((string) $config['orders_dir'], '/')) . '/reviews';
}

/** Одна запись очереди в том виде, в каком её показывают покупателю. */
function reviews_public(array $rv): ?array
{
    $rate = (int) ($rv['rate'] ?? 0);
    $text = trim((string) ($rv['text'] ?? ''));
    if ($rate < 1 || $rate > 5 || mb_strlen($text) < 20) {
        return null;
    }
    $ts = strtotime((string) ($rv['createdAt'] ?? '')) ?: 0;
    /*
      Поля перечислены поимённо, а не копируются целиком. Адрес автора и
      его IP лежат в той же записи, и «скопировать всё, кроме пары полей»
      однажды пропустило бы новое поле на витрину.
    */
    $out = [
        'name' => trim((string) ($rv['name'] ?? '')) !== '' ? trim((string) $rv['name']) : 'Покупатель',
        'rate' => $rate,
        'text' => $text,
        'date' => $ts ? gmdate('d.m.Y', $ts) : '',
        'verified' => ($rv['verified'] ?? false) === true,
    ];
    foreach (['city', 'printer', 'plus', 'minus'] as $k) {
        $v = trim((string) ($rv[$k] ?? ''));
        if ($v !== '') {
            $out[$k] = $v;
        }
    }
    $reply = is_array($rv['reply'] ?? null)
        ? trim((string) ($rv['reply']['text'] ?? ''))
        : trim((string) ($rv['reply'] ?? ''));
    if ($reply !== '') {
        $out['reply'] = $reply;
    }
    return $out + ['__at' => $ts];
}

/**
 * Пересобрать live/reviews.json из очереди.
 *
 * Пишем через временный файл и rename: посетитель, попавший на сайт в
 * этот момент, получит либо старую версию файла, либо новую, но никогда
 * половину.
 *
 * @param string[] $ids идентификаторы товаров витрины; отзывы об ушедших
 *                      позициях не публикуются
 */
function reviews_publish(array $config, string $liveFile, ?array $ids = null): array
{
    $dir = reviews_dir($config);
    $byProduct = [];
    $stats = ['published' => 0, 'pending' => 0, 'rejected' => 0, 'orphan' => 0, 'broken' => 0];
    foreach (glob($dir . '/*.json') ?: [] as $file) {
        $rv = json_decode((string) @file_get_contents($file), true);
        if (!is_array($rv)) {
            ++$stats['broken'];
            continue;
        }
        $status = (string) ($rv['status'] ?? '');
        if ($status === 'rejected') {
            ++$stats['rejected'];
            continue;
        }
        if ($status !== 'approved') {
            ++$stats['pending'];
            continue;
        }
        $public = reviews_public($rv);
        if ($public === null) {
            ++$stats['broken'];
            continue;
        }
        $product = (string) ($rv['product'] ?? '');
        if ($ids !== null && !in_array($product, $ids, true)) {
            ++$stats['orphan'];
            continue;
        }
        $byProduct[$product][] = $public;
        ++$stats['published'];
    }
    $items = [];
    foreach ($byProduct as $product => $list) {
        /* Новые сверху. При равном времени порядок задаёт текст — иначе
           две записи одной секунды меняются местами от запуска к запуску. */
        usort($list, static function (array $a, array $b): int {
            return $b['__at'] <=> $a['__at'] ?: strcmp($a['text'], $b['text']);
        });
        $sum = 0;
        foreach ($list as $r) {
            $sum += $r['rate'];
        }
        $items[$product] = [
            'count' => count($list),
            /* Средняя считается один раз и здесь: витрина и микроразметка
               берут готовое число, поэтому разойтись им негде. */
            'rate' => round($sum / count($list), 1),
            'list' => array_map(static function (array $r): array {
                unset($r['__at']);
                return $r;
            }, $list),
        ];
    }
    ksort($items);
    $payload = json_encode(
        ['updatedAt' => gmdate('c'), 'items' => (object) $items],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
    $tmp = $liveFile . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (@file_put_contents($tmp, $payload, LOCK_EX) === false || !@rename($tmp, $liveFile)) {
        @unlink($tmp);
        throw new RuntimeException('не удалось записать ' . basename($liveFile));
    }
    @chmod($liveFile, 0644);
    return $stats;
}
