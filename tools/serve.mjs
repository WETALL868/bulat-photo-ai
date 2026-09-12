#!/usr/bin/env node
/*
  Локальный сервер для разработки.

  Повторяет правила боевого .htaccess, чтобы витрину можно было проверять по
  настоящим адресам ещё до выкладки:

    существующий файл            отдаём как есть
    /catalog/laser/kyocera       seo-pages/catalog/laser/kyocera.html
    /                            seo-pages/home.html
    неизвестный адрес            seo-pages/404.html со статусом 404
    POST /api/order              приём заказа (в разработке пишем в файл)
    POST /api/review             отзыв на модерацию (пишем в var/reviews)

  Запуск: node tools/serve.mjs [порт]
*/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8080);
const ORDERS = path.join(ROOT, 'var/orders');
const REVIEWS = path.join(ROOT, 'var/reviews');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
/* Служебные разделы закрыты от индексации так же, как на боевом сервере. */
const NOINDEX = /^\/(cart|checkout|order|favorites|compare|login|search)(\/|$)/;

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/html; charset=utf-8' }, extra || {}));
  res.end(body);
}
function safeJoin(base, p) {
  const full = path.normalize(path.join(base, decodeURIComponent(p)));
  return full.startsWith(base) ? full : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/order') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let order;
      try { order = JSON.parse(body); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'Некорректный запрос' }), TYPES['.json']); }
      const number = 10240 + fs.readdirSync(fs.existsSync(ORDERS) ? ORDERS : (fs.mkdirSync(ORDERS, { recursive: true }), ORDERS)).length + 1;
      fs.writeFileSync(path.join(ORDERS, number + '.json'), JSON.stringify({ number, createdAt: new Date().toISOString(), ...order }, null, 2));
      console.log(`заказ №${number}: ${order.items?.length || 0} поз., ${order.total} ₽`);
      send(res, 200, JSON.stringify({ ok: true, number }), TYPES['.json']);
    });
    return;
  }

  /*
    Отзыв. Повторяет поведение боевого api/index.php: запись ложится в
    очередь модерации со статусом pending и никогда не публикуется сама.
    Здесь это нужно, чтобы путь «форма → сервер → очередь» проверялся
    локально целиком, а не только на боевом хостинге.
  */
  if (req.method === 'POST' && pathname === '/api/review') {
    let rbody = '';
    req.on('data', (c) => { rbody += c; if (rbody.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let rev;
      try { rev = JSON.parse(rbody); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'Некорректный запрос' }), TYPES['.json']); }
      const text = String(rev.text ?? '').trim();
      const name = String(rev.name ?? '').trim();
      const email = String(rev.email ?? '').trim();
      const product = String(rev.product ?? '').trim();
      if (!product || !name || text.length < 20) {
        return send(res, 422, JSON.stringify({ ok: false, error: 'Нужны товар, имя и текст отзыва' }), TYPES['.json']);
      }
      /* Та же проверка адреса, что и на боевом сервере: иначе локальная
         проверка формы расходится с настоящей. */
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
        return send(res, 422, JSON.stringify({ ok: false, error: 'Нужен корректный e-mail для связи по отзыву' }), TYPES['.json']);
      }
      fs.mkdirSync(REVIEWS, { recursive: true });
      const key = Buffer.from(product + '\0' + text).toString('base64url').slice(0, 22);
      const file = path.join(REVIEWS, `${product.replace(/[^A-Za-z0-9_-]+/g, '-')}-${key}.json`);
      if (fs.existsSync(file)) return send(res, 200, JSON.stringify({ ok: true, status: 'pending', duplicate: true }), TYPES['.json']);
      fs.writeFileSync(file, JSON.stringify({
        createdAt: new Date().toISOString(),
        /* Статус ставит сервер: поле из запроса игнорируется целиком. */
        status: 'pending', verified: false,
        /* Адрес — только в очередь модерации, как на боевом сервере. */
        product, name, email, rate: Number(rev.rate) || null,
        printer: String(rev.printer ?? '').trim(), text,
      }, null, 2));
      console.log(`отзыв на модерации: ${product} — ${name}`);
      send(res, 200, JSON.stringify({ ok: true, status: 'pending' }), TYPES['.json']);
    });
    return;
  }

  // 1. Настоящий файл
  const direct = safeJoin(ROOT, pathname);
  if (direct && fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    const ext = path.extname(direct);
    const cache = /\.(js|css|svg|webp|jpe?g|png|woff2)$/.test(direct) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return send(res, 200, fs.readFileSync(direct), TYPES[ext] || 'application/octet-stream', { 'Cache-Control': cache });
  }

  // 2. Заранее собранная страница
  const rel = pathname === '/' ? 'home' : pathname.replace(/^\/+|\/+$/g, '');
  const snapshot = safeJoin(path.join(ROOT, 'seo-pages'), rel + '.html');
  const headers = NOINDEX.test(pathname) ? { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-cache' } : { 'Cache-Control': 'no-cache' };
  if (snapshot && fs.existsSync(snapshot)) return send(res, 200, fs.readFileSync(snapshot), TYPES['.html'], headers);

  // 3. Служебные разделы витрины: оболочка без предрендера
  if (NOINDEX.test(pathname)) {
    const shell = path.join(ROOT, 'seo-pages/app.html');
    if (fs.existsSync(shell)) return send(res, 200, fs.readFileSync(shell), TYPES['.html'], headers);
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), TYPES['.html'], headers);
  }

  // 4. Пока предрендер не собран, отдаём оболочку: сайт работает как обычное
  //    приложение, и tools/build-seo.mjs может обойти все адреса.
  const nf = path.join(ROOT, 'seo-pages/404.html');
  if (!fs.existsSync(nf)) return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), TYPES['.html'], { 'Cache-Control': 'no-cache' });

  // 5. Настоящий 404
  send(res, 404, fs.readFileSync(nf), TYPES['.html'], { 'X-Robots-Tag': 'noindex' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Витрина Hi-Black: http://127.0.0.1:${PORT}/`);
  console.log('Правила совпадают с боевым .htaccess: предрендер, служебные разделы без индексации, настоящий 404.');
});
