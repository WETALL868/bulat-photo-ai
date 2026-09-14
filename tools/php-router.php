<?php
/*
  Маршрутизатор для встроенного сервера PHP (php -S) в разработке.

  Боевой сервер отдаёт /api/* в api/index.php правилом .htaccess; здесь
  то же самое делает этот файл. Настоящие файлы сервер отдаёт сам —
  возвращаем false.
*/
declare(strict_types=1);

$path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (str_starts_with($path, '/api')) {
    require __DIR__ . '/../api/index.php';
    return true;
}
return false;
