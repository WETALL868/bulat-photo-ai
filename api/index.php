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

/* Метка «точка входа»: по ней подключаемые части отличают обращение
   через этот файл от прямого запроса к себе. */
define('HB_API', true);

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

require_once __DIR__ . '/reviews-store.php';

/*
  Админка живёт отдельным файлом: здесь пароль, сессии и адреса
  покупателей, и держать это вперемешку с приёмом заказов незачем.
  Подключается только на своих маршрутах — на обычный заказ её код не
  исполняется вовсе.
*/
if (str_starts_with($route, 'admin/') || $route === 'admin') {
    $adminRoute = substr($route, 6);
    require __DIR__ . '/admin.php';
    exit;
}

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
    /*
      Оценка обязательна и проверяется здесь же. Раньше неверное значение
      молча превращалось в null, и в очереди модерации отзыв без оценки
      было не отличить от отзыва, у которого её потеряли по дороге.
    */
    $rate = isset($in['rate']) ? (int) $in['rate'] : 0;
    if ($rate < 1 || $rate > 5) {
        fail(422, 'Поставьте оценку от 1 до 5');
    }
    $config = settings();
    $dir = reviews_dir($config);
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
        'rate' => $rate,
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
            $product . "\n" . $name . ' — ' . $rate . "/5\n\n" . $text,
            'Content-Type: text/plain; charset=utf-8'
        );
    }
    echo json_encode(['ok' => true, 'status' => 'pending'], JSON_UNESCAPED_UNICODE);
    exit;
}

/* Одно письмо, когда отсутствующий товар снова появится в живых остатках. */
if ($route === 'stock-alert') {
    if ($method !== 'POST') {
        header('Allow: POST');
        fail(405, 'Подписка отправляется методом POST');
    }
    $raw = file_get_contents('php://input', false, null, 0, 2049);
    if ($raw === false || strlen($raw) > 2048) {
        fail(413, 'Слишком большой запрос');
    }
    $in = json_decode($raw, true);
    $id = is_array($in) ? (string) ($in['product'] ?? '') : '';
    $email = is_array($in) ? mb_strtolower(trim((string) ($in['email'] ?? ''))) : '';
    if (!preg_match('/^[a-z0-9-]{1,160}$/', $id) || strlen($email) > 254 ||
        !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        fail(422, 'Укажите действующий адрес почты');
    }
    $catalogFile = __DIR__ . '/../data/catalog/index.json';
    $catalog = is_file($catalogFile) ? json_decode((string) file_get_contents($catalogFile), true) : null;
    $product = null;
    foreach (($catalog['rows'] ?? []) as $row) {
        if (is_array($row) && ($row[0] ?? '') === $id) {
            $product = $row;
            break;
        }
    }
    if ($product === null) {
        fail(404, 'Товар не найден');
    }
    $liveFile = __DIR__ . '/../live/catalog-live.json';
    $live = is_file($liveFile) ? json_decode((string) file_get_contents($liveFile), true) : null;
    $stock = $live['items'][$id]['stock'] ?? null;
    if ($stock === null) {
        fail(503, 'Сейчас не можем проверить остаток. Попробуйте позже.');
    }
    if ((float) $stock > 0) {
        fail(409, 'Товар уже в наличии — обновите страницу');
    }
    $dir = dirname(__DIR__, 3) . '/hiblack-stock-alerts';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        error_log('[hi-black] нет папки подписок');
        fail(503, 'Не удалось сохранить подписку. Попробуйте позже.');
    }
    $ipKey = hash('sha256', (string) ($_SERVER['REMOTE_ADDR'] ?? ''));
    $rateFile = $dir . '/.rate-' . $ipKey;
    $rate = fopen($rateFile, 'c+');
    if ($rate === false || !flock($rate, LOCK_EX)) {
        fail(503, 'Не удалось сохранить подписку. Попробуйте позже.');
    }
    $times = json_decode((string) stream_get_contents($rate), true);
    $times = is_array($times) ? array_values(array_filter($times, static fn ($x) => is_int($x) && $x > time() - 3600)) : [];
    if (count($times) >= 10) {
        flock($rate, LOCK_UN);
        fclose($rate);
        fail(429, 'Слишком много подписок. Попробуйте через час.');
    }
    $times[] = time();
    ftruncate($rate, 0);
    rewind($rate);
    fwrite($rate, json_encode($times));
    fflush($rate);
    flock($rate, LOCK_UN);
    fclose($rate);
    @chmod($rateFile, 0600);
    $key = hash('sha256', $id . "\0" . $email);
    $file = $dir . '/' . $key . '.json';
    $record = [
        'product' => $id,
        'email' => $email,
        'name' => (string) ($product[2] ?? ''),
        'slug' => (string) ($product[1] ?? ''),
        'createdAt' => date('c'),
        'expiresAt' => time() + 180 * 86400,
    ];
    if (!is_file($file) && file_put_contents($file, json_encode($record, JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
        error_log('[hi-black] не удалось сохранить подписку');
        fail(503, 'Не удалось сохранить подписку. Попробуйте позже.');
    }
    @chmod($file, 0600);
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
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
    if ($price <= 0 || (float) ($prices[$id]['stock'] ?? 0) <= 0) {
        fail(422, 'Товар ' . mb_substr($id, 0, 40) . ' сейчас недоступен, обновите корзину');
    }
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

/* Промокод и доставку считаем заново по серверным ценам. Итог из браузера
 * намеренно не принимаем: его можно изменить перед отправкой. */
$subtotal = $total;
$promo = strtoupper(trim((string) ($data['promo'] ?? '')));
if ($promo !== '' && $promo !== 'HIBLACK5') {
    fail(422, 'Промокод не действует, обновите корзину');
}
$discount = 0;
$runningGross = 0;
foreach ($lines as &$line) {
    $runningGross += $line['sum'];
    $nextDiscount = $promo === 'HIBLACK5' ? (int) round($runningGross * 0.05) : 0;
    $line['discount'] = $nextDiscount - $discount;
    $line['gross'] = $line['sum'];
    $line['sum'] -= $line['discount'];
    $discount = $nextDiscount;
}
unset($line);
$deliveryMethod = $clean('deliv', 32);
$deliveryCost = match ($deliveryMethod) {
    'courier' => 500,
    'pickup' => 0,
    default => null, // за МКАД и СДЭК рассчитывает менеджер
};
$total = $subtotal - $discount + ($deliveryCost ?? 0);

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
        'method' => $deliveryMethod,
        'cost' => $deliveryCost,
        'address' => $clean('address', 300),
        'comment' => $clean('comment', 500),
    ],
    'payment' => $clean('pay', 32),
    'items' => $lines,
    'subtotal' => $subtotal,
    'discount' => $discount,
    'promo' => $promo,
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
        $text .= "{$l['code']} — {$l['name']}\n  {$l['qty']} × {$l['price']} = {$l['gross']} ₽";
        if ($l['discount'] > 0) {
            $text .= " − {$l['discount']} ₽ (скидка 5%)";
        }
        $text .= " = {$l['sum']} ₽\n";
    }
    if ($discount > 0) {
        $text .= "\nПромокод {$promo}: −{$discount} ₽\n";
    }
    $text .= $deliveryCost === null ? "Доставка: по расчёту менеджера\n" : "Доставка: {$deliveryCost} ₽\n";
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
