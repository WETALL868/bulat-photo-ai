<?php
/**
 * Админка: модерация отзывов.
 *
 * Вход по паролю. Хеш пароля лежит в закрытом конфиге ВЫШЕ публичной
 * папки (ключ admin_password_hash) — в репозиторий он не попадает и в
 * ответах не появляется. Пока хеш не задан, админка выключена целиком:
 * это надёжнее, чем пароль по умолчанию, который забудут сменить.
 *
 * Здесь видны адреса покупателей, поэтому:
 *   • все ответы no-store, чтобы их не осел кэш;
 *   • cookie сессии HttpOnly + SameSite=Strict, срок 12 часов;
 *   • на изменяющие запросы нужен CSRF-токен в заголовке;
 *   • у входа лимит попыток по IP;
 *   • сессии лежат вне публичной папки, в файлах с правами 0600.
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

const ADMIN_COOKIE = 'hb_admin';
const ADMIN_TTL = 43200;          // 12 часов
const ADMIN_TRIES = 10;           // попыток входа с одного адреса в час

/* Соседняя с заказами папка; про «..» см. reviews_dir(). */
function admin_dir(array $config): string
{
    return dirname(rtrim((string) $config['orders_dir'], '/')) . '/admin';
}

function admin_ensure_dir(string $dir): void
{
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        error_log('[hi-black] нет папки админки: ' . $dir);
        fail(503, 'Админка недоступна. Проверьте права на папку.');
    }
}

/** Файл сессии по токену. Имя — хеш, сам токен на диск не пишется. */
function admin_session_file(string $dir, string $token): string
{
    return $dir . '/s-' . hash('sha256', $token) . '.json';
}

/** Текущая сессия или null. Просроченная удаляется на месте. */
function admin_session(array $config): ?array
{
    $token = (string) ($_COOKIE[ADMIN_COOKIE] ?? '');
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
        return null;
    }
    $file = admin_session_file(admin_dir($config), $token);
    if (!is_file($file)) {
        return null;
    }
    $s = json_decode((string) file_get_contents($file), true);
    if (!is_array($s) || ($s['expiresAt'] ?? 0) < time()) {
        @unlink($file);
        return null;
    }
    return $s + ['file' => $file];
}

function admin_require(array $config): array
{
    $s = admin_session($config);
    if ($s === null) {
        fail(401, 'Нужен вход');
    }
    return $s;
}

/**
 * Проверка CSRF на изменяющих запросах.
 *
 * SameSite=Strict уже не даёт браузеру отправить cookie с чужого сайта,
 * но токен в заголовке — вторая независимая преграда: она держится, даже
 * если однажды cookie придётся ослабить.
 */
function admin_check_csrf(array $session): void
{
    $sent = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    if ($sent === '' || !hash_equals((string) ($session['csrf'] ?? ''), $sent)) {
        fail(403, 'Сессия устарела, войдите заново');
    }
}

/** Лимит попыток входа: пароль подбирать по одной попытке в минуту скучно. */
function admin_rate_limit(string $dir): void
{
    $file = $dir . '/.login-' . hash('sha256', (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
    $fh = fopen($file, 'c+');
    if ($fh === false || !flock($fh, LOCK_EX)) {
        fail(503, 'Не удалось проверить попытки входа');
    }
    $times = json_decode((string) stream_get_contents($fh), true);
    $times = is_array($times)
        ? array_values(array_filter($times, static fn ($t) => is_int($t) && $t > time() - 3600))
        : [];
    if (count($times) >= ADMIN_TRIES) {
        flock($fh, LOCK_UN);
        fclose($fh);
        fail(429, 'Слишком много попыток входа. Попробуйте через час.');
    }
    $times[] = time();
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, (string) json_encode($times));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    @chmod($file, 0600);
}

/** Запись очереди по имени файла. Имя приходит снаружи — проверяем строго. */
function admin_review_file(array $config, string $name): string
{
    if (!preg_match('/^[A-Za-z0-9_.-]{1,180}\.json$/', $name) || str_contains($name, '..')) {
        fail(422, 'Неизвестный отзыв');
    }
    $file = reviews_dir($config) . '/' . $name;
    if (!is_file($file)) {
        fail(404, 'Отзыв не найден');
    }
    return $file;
}

function admin_live_file(): string
{
    return __DIR__ . '/../live/reviews.json';
}

/** Идентификаторы товаров витрины: отзыв об ушедшей позиции не публикуем. */
function admin_product_ids(): ?array
{
    $file = __DIR__ . '/../data/catalog/index.json';
    if (!is_file($file)) {
        return null;
    }
    $idx = json_decode((string) file_get_contents($file), true);
    $ids = [];
    foreach (($idx['rows'] ?? []) as $row) {
        if (is_array($row) && isset($row[0])) {
            $ids[] = (string) $row[0];
        }
    }
    return $ids ?: null;
}

/* ------------------------------------------------------------ маршруты */

$config = settings();
$hash = (string) ($config['admin_password_hash'] ?? '');
$dir = admin_dir($config);

if ($adminRoute === 'login') {
    if ($method !== 'POST') {
        header('Allow: POST');
        fail(405, 'Вход отправляется методом POST');
    }
    if ($hash === '') {
        /* Сообщение намеренно не говорит «пароль не задан» тому, кто просто
           постучался: настройка это дело владельца, а не гостя. Подробность
           уходит в лог сервера. */
        error_log('[hi-black] в конфиге нет admin_password_hash — админка выключена');
        fail(503, 'Админка не настроена');
    }
    admin_ensure_dir($dir);
    admin_rate_limit($dir);
    $in = json_decode((string) file_get_contents('php://input', false, null, 0, 4096), true);
    $password = is_array($in) ? (string) ($in['password'] ?? '') : '';
    /* Проверяем всегда, даже когда пароль пуст: одинаковое время ответа
       не даёт отличить «пусто» от «неверно». */
    if (!password_verify($password, $hash)) {
        usleep(random_int(150000, 350000));
        fail(401, 'Неверный пароль');
    }
    $token = bin2hex(random_bytes(32));
    $csrf = bin2hex(random_bytes(32));
    $file = admin_session_file($dir, $token);
    $ok = @file_put_contents($file, (string) json_encode([
        'csrf' => $csrf,
        'createdAt' => time(),
        'expiresAt' => time() + ADMIN_TTL,
    ]), LOCK_EX);
    if ($ok === false) {
        fail(503, 'Не удалось открыть сессию');
    }
    @chmod($file, 0600);
    /* Просроченные сессии подчищаем здесь же: отдельного планировщика под
       это заводить не из-за чего. */
    foreach (glob($dir . '/s-*.json') ?: [] as $old) {
        $s = json_decode((string) @file_get_contents($old), true);
        if (!is_array($s) || ($s['expiresAt'] ?? 0) < time()) {
            @unlink($old);
        }
    }
    $https = ($_SERVER['HTTPS'] ?? '') === 'on'
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    setcookie(ADMIN_COOKIE, $token, [
        'expires' => time() + ADMIN_TTL,
        'path' => '/',
        'secure' => $https,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    echo json_encode(['ok' => true, 'csrf' => $csrf], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($adminRoute === 'logout') {
    $s = admin_session($config);
    if ($s !== null) {
        @unlink($s['file']);
    }
    setcookie(ADMIN_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($adminRoute === 'session') {
    $s = admin_session($config);
    echo json_encode($s === null
        ? ['ok' => false, 'configured' => $hash !== '']
        : ['ok' => true, 'csrf' => $s['csrf']], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($adminRoute === 'reviews') {
    $s = admin_require($config);
    $want = (string) ($_GET['status'] ?? 'pending');
    $rows = [];
    $counts = ['pending' => 0, 'approved' => 0, 'rejected' => 0];
    foreach (glob(reviews_dir($config) . '/*.json') ?: [] as $file) {
        $rv = json_decode((string) @file_get_contents($file), true);
        if (!is_array($rv)) {
            continue;
        }
        $status = (string) ($rv['status'] ?? 'pending');
        if (isset($counts[$status])) {
            ++$counts[$status];
        }
        if ($want !== 'all' && $status !== $want) {
            continue;
        }
        /*
          Адрес автора уходит модератору: по нему он уточняет отзыв и
          сверяет покупку с заказом. Это единственное место, где адрес
          вообще покидает очередь, и ответ помечен no-store.
        */
        $rows[] = [
            'file' => basename($file),
            'status' => $status,
            'product' => (string) ($rv['product'] ?? ''),
            'name' => (string) ($rv['name'] ?? ''),
            'email' => (string) ($rv['email'] ?? ''),
            'rate' => (int) ($rv['rate'] ?? 0),
            'printer' => (string) ($rv['printer'] ?? ''),
            'text' => (string) ($rv['text'] ?? ''),
            'reply' => is_array($rv['reply'] ?? null) ? (string) ($rv['reply']['text'] ?? '') : (string) ($rv['reply'] ?? ''),
            'verified' => ($rv['verified'] ?? false) === true,
            'createdAt' => (string) ($rv['createdAt'] ?? ''),
            'moderatorNote' => (string) ($rv['moderatorNote'] ?? ''),
        ];
    }
    usort($rows, static fn (array $a, array $b): int => strcmp($b['createdAt'], $a['createdAt']));
    echo json_encode(['ok' => true, 'counts' => $counts, 'reviews' => $rows], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($adminRoute === 'review') {
    $s = admin_require($config);
    if ($method !== 'POST') {
        header('Allow: POST');
        fail(405, 'Решение отправляется методом POST');
    }
    admin_check_csrf($s);
    $in = json_decode((string) file_get_contents('php://input', false, null, 0, 8192), true);
    if (!is_array($in)) {
        fail(400, 'Не разобрали запрос');
    }
    $file = admin_review_file($config, (string) ($in['file'] ?? ''));
    $action = (string) ($in['action'] ?? '');
    $rv = json_decode((string) file_get_contents($file), true);
    if (!is_array($rv)) {
        fail(422, 'Файл отзыва повреждён');
    }
    switch ($action) {
        case 'approve':
        case 'reject':
        case 'pending':
            $rv['status'] = $action === 'pending' ? 'pending' : $action . 'd';
            $rv['moderatedAt'] = gmdate('c');
            $note = trim((string) ($in['note'] ?? ''));
            if ($note !== '') {
                $rv['moderatorNote'] = mb_substr($note, 0, 300);
            }
            break;
        case 'verify':
            /* Отметку «покупка подтверждена» ставит человек, сверив отзыв с
               заказом. Сама по себе она не появляется: это утверждение о
               факте, а не оформление. */
            $rv['verified'] = ($in['value'] ?? true) === true;
            break;
        case 'reply':
            $reply = trim((string) ($in['text'] ?? ''));
            if ($reply === '') {
                unset($rv['reply']);
            } else {
                $rv['reply'] = mb_substr($reply, 0, 1000);
            }
            break;
        default:
            fail(422, 'Неизвестное действие');
    }
    if (@file_put_contents($file, (string) json_encode($rv, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX) === false) {
        fail(503, 'Не удалось сохранить решение');
    }
    @chmod($file, 0600);
    /* Решение вступает в силу сразу: live/reviews.json переписывается тут
       же, и витрина берёт его при следующей загрузке страницы. */
    try {
        $stats = reviews_publish($config, admin_live_file(), admin_product_ids());
    } catch (RuntimeException $e) {
        error_log('[hi-black] публикация отзывов: ' . $e->getMessage());
        fail(503, 'Решение сохранено, но витрина не обновилась. Проверьте права на live/reviews.json.');
    }
    echo json_encode(['ok' => true, 'status' => $rv['status'] ?? 'pending', 'published' => $stats['published']],
        JSON_UNESCAPED_UNICODE);
    exit;
}

fail(404, 'Неизвестный запрос админки');
