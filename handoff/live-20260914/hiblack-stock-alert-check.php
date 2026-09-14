<?php
/** Send each stock alert once, after the published live inventory becomes positive. */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$dataRoot = __DIR__;
$alertsDir = $dataRoot . '/hiblack-stock-alerts';
$liveFile = $dataRoot . '/www/hiblack-msk.ru/live/catalog-live.json';
$dryRun = in_array('--dry-run', $argv, true);
if (!is_dir($alertsDir) || !is_file($liveFile)) {
    fwrite(STDERR, "Stock alerts or live inventory missing\n");
    exit(1);
}
$lock = fopen($alertsDir . '/.monitor.lock', 'c+');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "Stock alert monitor already running\n");
    exit(1);
}
$live = json_decode((string) file_get_contents($liveFile), true);
if (!is_array($live['items'] ?? null)) {
    fwrite(STDERR, "Invalid live inventory\n");
    exit(1);
}
$seen = 0;
$ready = 0;
$sent = 0;
$errors = 0;
$expired = 0;
foreach (glob($alertsDir . '/*.json') ?: [] as $file) {
    if (++$seen > 1000 || $sent >= 100) break;
    $item = json_decode((string) file_get_contents($file), true);
    if (!is_array($item) || empty($item['product']) || empty($item['email'])) {
        ++$errors;
        continue;
    }
    if (($item['expiresAt'] ?? 0) < time()) {
        if (!$dryRun) unlink($file);
        ++$expired;
        continue;
    }
    $stock = $live['items'][$item['product']]['stock'] ?? null;
    if ($stock === null || (float) $stock <= 0) continue;
    ++$ready;
    if ($dryRun) continue;
    $slug = (string) ($item['slug'] ?? '');
    $name = trim((string) ($item['name'] ?? ''));
    $email = (string) $item['email'];
    if (!preg_match('/^[a-z0-9-]{1,180}$/', $slug) || $name === '' ||
        !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        ++$errors;
        continue;
    }
    $url = 'https://hiblack-msk.ru/product/' . $slug;
    $subject = mb_encode_mimeheader('Товар снова в наличии — Hi-Black', 'UTF-8');
    $body = "Здравствуйте!\n\nВы интересовались товаром:\n" . $name .
        "\n\nОн снова в наличии. Посмотреть товар: " . $url .
        "\n\nЭто одноразовое уведомление о товаре, на которое вы подписались.\n";
    $headers = [
        'From' => 'Hi-Black <no-reply@hiblack-msk.ru>',
        'Content-Type' => 'text/plain; charset=UTF-8',
    ];
    if (@mail($email, $subject, $body, $headers)) {
        if (!unlink($file)) {
            ++$errors;
            continue;
        }
        ++$sent;
    } else {
        ++$errors;
    }
}
printf("checked=%d ready=%d sent=%d expired=%d errors=%d dry=%d\n",
    $seen, $ready, $sent, $expired, $errors, $dryRun ? 1 : 0);
flock($lock, LOCK_UN);
fclose($lock);
exit($errors ? 1 : 0);
