<?php
declare(strict_types=1);

const PRODUCT_BASE_URL = 'https://hiblack-msk.ru/product/';

$slug = isset($_GET['slug']) ? strtolower((string) $_GET['slug']) : '';
$file = dirname(__DIR__) . '/data/product-redirects.json';
$target = null;

if (preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/', $slug) && is_file($file)) {
    $payload = json_decode((string) file_get_contents($file), true);
    if (is_array($payload) && isset($payload['redirects'][$slug])) {
        $candidate = (string) $payload['redirects'][$slug];
        if (preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/', $candidate)) {
            $target = $candidate;
        }
    }
}

if ($target !== null) {
    $query = $_GET;
    unset($query['slug']);
    $suffix = $query ? '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '';
    header('Location: ' . PRODUCT_BASE_URL . $target . $suffix, true, 301);
    header('Cache-Control: public, max-age=86400');
    exit;
}

http_response_code(404);
header('X-Robots-Tag: noindex, nofollow');
$notFound = dirname(__DIR__) . '/seo-pages/404.html';
if (is_file($notFound)) {
    readfile($notFound);
} else {
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Страница не найдена';
}
