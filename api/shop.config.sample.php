<?php
/*
  Настройки магазина. Этот файл должен лежать ВНЕ публичной папки: в нём
  почтовые и платёжные ключи. В репозиторий попадает только образец.
*/
return [
    'orders_dir' => '/var/www/hi-black/var/orders',
    'manager_email' => 'zakaz@example.ru',
    'shop_name' => 'Фирменный магазин Hi-Black',
    'number_start' => 10240,

    // Заполняется на этапе подключения оплаты и выгрузки заказов поставщику.
    // 'payment' => ['shop_id' => '', 'secret_key' => ''],
    // 'vtt' => ['login' => '', 'password' => ''],
];
