<?php
/**
 * Приём заказов.
 *
 * Витрина — статические файлы, и всё, что требует ключей, денег или почты,
 * происходит здесь. Ключи наружу не уходят никогда: браузер обращается только
 * к своему серверу, а сервер уже ходит в платёжку, СДЭК и почту.
 *
 * Настройки и секреты лежат ВЫШЕ публичной папки — путь к ним записан в
 * config-path.php. Так их не отдаст веб-сервер, даже если PHP однажды
 * перестанет исполняться.
 *
 * Что уже работает: разбор и проверка заказа, присвоение номера, запись в
 * var/orders и письмо менеджеру. Что предстоит: оплата, выгрузка заказа в ВТТ,
 * личный кабинет. Каркас под них — в конце файла.
 */

declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=UTF-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const MAX_BODY = 65536;      // заказ не бывает больше, всё остальное — мусор или атака
const MAX_ITEMS = 100;

function fail(int $code, string $message): never
{
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

/** Настройки: сначала файл вне публичной папки, иначе значения по умолчанию. */
function settings(): array
{
    $defaults = [
        'orders_dir' => __DIR__ . '/../var/orders',
        'manager_email' => '',          // куда слать уведомление о заказе
        'shop_name' => 'Фирменный магазин Hi-Black',
        'number_start' => 10240,
    ];
    $pointer = __DIR__ . '/config-path.php';
    if (is_file($pointer)) {
        $configFile = trim((string) require $pointer);
        if ($configFile !== '' && is_file($configFile)) {
            return array_merge($defaults, (array) require $configFile);
        }
    }
    return $defaults;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = trim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/');
$route = preg_replace('#^api/?#', '', $path);

if ($method === 'GET' && $route === 'status') {
    $live = __DIR__ . '/../live/update-status.json';
    echo json_encode([
        'ok' => true,
        'catalog' => is_file($live) ? json_decode((string) file_get_contents($live), true) : null,
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/*
  Обратный звонок. Заявка короткая и без цен, поэтому лежит рядом с заказами
  отдельным файлом cb-<время>.json — менеджеру важно только имя и телефон.
*/
if ($route === 'callback') {
    if ($method !== 'POST') {
        header('Allow: POST');
        fail(405, 'Заявка отправляется методом POST');
    }
    $raw = file_get_contents('php://input', false, null, 0, 4096);
    $in = json_decode((string) $raw, true);
    if (!is_array($in)) {
        fail(400, 'Не разобрали заявку');
    }
    $cut = static fn (string $k, int $n): string => mb_substr(trim((string) ($in[$k] ?? '')), 0, $n);
    $name = $cut('name', 120);
    $phone = $cut('phone', 40);
    if ($name === '' || preg_match_all('/\d/', $phone) < 10) {
        fail(422, 'Нужны имя и телефон');
    }
    $config = settings();
    $dir = (string) $config['orders_dir'];
    if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
        error_log('[hi-black] нет папки для заявок: ' . $dir);
        fail(503, 'Заявку не приняли. Позвоните нам, пожалуйста.');
    }
    $request = [
        'createdAt' => date('c'),
        'name' => $name,
        'phone' => $phone,
        'note' => $cut('note', 300),
        'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
    ];
    $file = $dir . '/cb-' . date('Ymd-His') . '-' . substr(bin2hex(random_bytes(3)), 0, 6) . '.json';
    if (file_put_contents($file, json_encode($request, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX) === false) {
        error_log('[hi-black] не удалось сохранить заявку на звонок');
        fail(503, 'Заявку не приняли. Позвоните нам, пожалуйста.');
    }
    if ($config['manager_email'] !== '') {
        @mail(
            (string) $config['manager_email'],
            'Заявка на звонок — ' . $config['shop_name'],
            $name . ', ' . $phone . ($request['note'] !== '' ? "\n" . $request['note'] : ''),
            'Content-Type: text/plain; charset=utf-8'
        );
    }
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
}

/*
  Отзыв о товаре.

  Приходит с карточки и НИКОГДА не публикуется сразу. Запись ложится в
  var/reviews со статусом pending, и на витрину попадает только после
  того, как её открыл и одобрил человек. Поэтому ответ говорит
  «отправлен на проверку», а не «опубликован»: между этими словами
  разница в одного модератора.

  Что здесь принципиально:
    • статус ставит сервер, а не запрос. Поле status из тела игнорируется
      целиком — иначе опубликовать что угодно можно было бы одной
      строчкой в JSON;
    • «покупка подтверждена» не выставляется. Подтвердить покупку может
      только заказ, а не форма, и до появления такой сверки этого флага
      у отзыва нет вовсе;
    • одинаковый отзыв на один товар не принимается дважды: ключ
      считается по товару и тексту, и повторная отправка возвращает тот
      же ответ, ничего не создавая.
*/
if ($route === 'review') {
    if ($method !== 'POST') {
        header('Allow: POST');
        fail(405, 'Отзыв отправляется методом POST');
    }
    $raw = file_get_contents('php://input', false, null, 0, 8192);
    $in = json_decode((string) $raw, true);
    if (!is_array($in)) {
        fail(400, 'Не разобрали отзыв');
    }
    $cut = static fn (string $k, int $n): string => mb_substr(trim((string) ($in[$k] ?? '')), 0, $n);
    $product = $cut('product', 120);
    $name = $cut('name', 80);
    $email = $cut('email', 120);
    $text = $cut('text', 2000);
    if ($product === '' || $name === '' || mb_strlen($text) < 20) {
        fail(422, 'Нужны товар, имя и текст отзыва');
    }
    /*
      Адрес проверяется и здесь. Клиентскую проверку обходит кто угодно, а
      без обратного адреса модератор не сможет уточнить отзыв — значит,
      принимать его бессмысленно.
    */
    if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        fail(422, 'Нужен корректный e-mail для связи по отзыву');
    }
    $rate = isset($in['rate']) ? (int) $in['rate'] : 0;
    if ($rate < 1 || $rate > 5) {
        $rate = 0;
    }
    $config = settings();
    $dir = rtrim((string) $config['orders_dir'], '/') . '/../reviews';
    if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
        error_log('[hi-black] нет папки для отзывов: ' . $dir);
        fail(503, 'Отзыв не приняли. Попробуйте позже.');
    }
    /* Ключ повтора — товар и текст. Имя в него не входит намеренно: один
       и тот же текст под двумя именами это тот же отзыв. */
    $key = substr(hash('sha256', $product . "\0" . $text), 0, 16);
    $file = $dir . '/' . preg_replace('/[^A-Za-z0-9_-]+/', '-', $product) . '-' . $key . '.json';
    if (is_file($file)) {
        echo json_encode(['ok' => true, 'status' => 'pending', 'duplicate' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $review = [
        'createdAt' => date('c'),
        /* Статус ставит сервер. Значение из запроса сюда не попадает. */
        'status' => 'pending',
        'verified' => false,
        'product' => $product,
        'name' => $name,
        /*
          Адрес живёт только здесь, в приватной очереди модерации: папка
          лежит выше публичной директории и наружу не отдаётся. В карточку,
          в микроразметку и в опубликованные данные каталога он не уходит
          ни при каких условиях — это контакт автора, а не часть отзыва.
        */
        'email' => $email,
        'rate' => $rate ?: null,
        'printer' => $cut('printer', 80),
        'text' => $text,
        'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
    ];
    if (file_put_contents($file, json_encode($review, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX) === false) {
        error_log('[hi-black] не удалось сохранить отзыв');
        fail(503, 'Отзыв не приняли. Попробуйте позже.');
    }
    if ($config['manager_email'] !== '') {
        @mail(
            (string) $config['manager_email'],
            'Новый отзыв на модерации — ' . $config['shop_name'],
            $product . "\n" . $name . ' — ' . ($rate ?: '?') . "/5\n\n" . $text,
            'Content-Type: text/plain; charset=utf-8'
        );
    }
    echo json_encode(['ok' => true, 'status' => 'pending'], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($route !== 'order') {
    fail(404, 'Неизвестный запрос');
}
if ($method !== 'POST') {
    header('Allow: POST');
    fail(405, 'Заказ отправляется методом POST');
}

$raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($raw === false || strlen($raw) > MAX_BODY) {
    fail(413, 'Слишком большой запрос');
}
$data = json_decode($raw, true);
if (!is_array($data)) {
    fail(400, 'Некорректный формат заказа');
}

/*
 * Всё, что пришло из браузера, — недоверенные данные. Имя и телефон чистим,
 * а цену и наличие берём НЕ из запроса, а из живого файла каталога: иначе
 * покупатель сможет прислать свою цену.
 */
$customer = is_array($data['customer'] ?? null) ? $data['customer'] : [];
$clean = static fn (string $key, int $max = 200): string =>
    mb_substr(trim(strip_tags((string) ($customer[$key] ?? ''))), 0, $max);

$name = $clean('name');
$phone = $clean('phone', 32);
$email = filter_var($clean('email'), FILTER_VALIDATE_EMAIL) ?: '';
if ($name === '' || $phone === '') {
    fail(422, 'Укажите имя и телефон — без них мы не сможем подтвердить заказ');
}

$items = is_array($data['items'] ?? null) ? $data['items'] : [];
if (!$items || count($items) > MAX_ITEMS) {
    fail(422, 'В заказе нет товаров');
}

$liveFile = __DIR__ . '/../live/catalog-live.json';
$live = is_file($liveFile) ? json_decode((string) file_get_contents($liveFile), true) : null;
$prices = is_array($live['items'] ?? null) ? $live['items'] : [];

$lines = [];
$total = 0;
foreach ($items as $item) {
    $id = (string) ($item['id'] ?? '');
    $qty = (int) ($item['qty'] ?? 0);
    if ($id === '' || $qty < 1 || $qty > 999) {
        continue;
    }
    if (!isset($prices[$id])) {
        fail(422, 'Товар ' . mb_substr($id, 0, 40) . ' больше не продаётся, обновите корзину');
    }
    $price = (float) ($prices[$id]['price'] ?? 0);
    $lines[] = [
        'id' => $id,
        'code' => mb_substr((string) ($item['code'] ?? ''), 0, 64),
        'name' => mb_substr((string) ($item['name'] ?? ''), 0, 300),
        'qty' => $qty,
        'price' => $price,          // цена сервера, а не браузера
        'sum' => $price * $qty,
    ];
    $total += $price * $qty;
}
if (!$lines) {
    fail(422, 'В заказе нет доступных товаров');
}

$config = settings();
$dir = (string) $config['orders_dir'];
if (!is_dir($dir) && !mkdir($dir, 0770, true) && !is_dir($dir)) {
    error_log('[hi-black] не удалось создать папку заказов: ' . $dir);
    fail(503, 'Магазин временно не может принять заказ. Позвоните нам, пожалуйста.');
}

/* Номер выдаём под блокировкой: два одновременных заказа не должны совпасть. */
$counterFile = $dir . '/.counter';
$fh = fopen($counterFile, 'c+');
if ($fh === false || !flock($fh, LOCK_EX)) {
    fail(503, 'Магазин временно не может принять заказ. Попробуйте через минуту.');
}
$current = (int) stream_get_contents($fh);
$number = max($current, (int) $config['number_start']) + 1;
ftruncate($fh, 0);
rewind($fh);
fwrite($fh, (string) $number);
fflush($fh);
flock($fh, LOCK_UN);
fclose($fh);

$order = [
    'number' => $number,
    'createdAt' => date('c'),
    'customer' => [
        'name' => $name,
        'phone' => $phone,
        'email' => $email,
        'company' => $clean('company'),
        'inn' => $clean('inn', 12),
        'biz' => ($customer['biz'] ?? '0') === '1',
    ],
    'delivery' => [
        'method' => $clean('deliv', 32),
        'address' => $clean('address', 300),
        'comment' => $clean('comment', 500),
    ],
    'payment' => $clean('pay', 32),
    'items' => $lines,
    'total' => $total,
    'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
];

if (file_put_contents($dir . '/' . $number . '.json', json_encode($order, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX) === false) {
    error_log('[hi-black] не удалось сохранить заказ ' . $number);
    fail(503, 'Магазин временно не может принять заказ. Позвоните нам, пожалуйста.');
}

/* Уведомление менеджеру. Письмо покупателю добавим вместе с шаблонами писем. */
if ($config['manager_email'] !== '') {
    $text = "Заказ №{$number}\n{$name}, {$phone}" . ($email !== '' ? ", {$email}" : '') . "\n\n";
    foreach ($lines as $l) {
        $text .= "{$l['code']} — {$l['name']}\n  {$l['qty']} × {$l['price']} = {$l['sum']} ₽\n";
    }
    $text .= "\nИтого: {$total} ₽\n";
    @mail(
        (string) $config['manager_email'],
        "Заказ №{$number} — {$config['shop_name']}",
        $text,
        ['Content-Type' => 'text/plain; charset=UTF-8']
    );
}

/*
 * Следующие шаги, когда дойдём до боевого запуска:
 *   1. Оплата: создание платежа и обработка уведомления от банка.
 *   2. Передача заказа в ВТТ методом CreateOrder и опрос GetOrderStatus.
 *   3. Личный кабинет: история заказов и повторный заказ.
 * Все они делаются здесь же и не требуют менять витрину.
 */

echo json_encode(['ok' => true, 'number' => $number], JSON_UNESCAPED_UNICODE);
