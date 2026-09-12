#!/usr/bin/env node
/*
  Предрендер: собирает готовый HTML для каждого публичного адреса.

  Зачем. Витрина рисуется скриптом, а поисковику и человеку с медленным
  интернетом нужен готовый документ. Поэтому каждый адрес один раз открывается
  в браузере, отрисованная страница сохраняется в seo-pages/, и сервер отдаёт
  её мгновенно. Скрипт на той же странице потом перерисовывает содержимое и
  дальше работает как обычное приложение.

  Так же устроен эталонный магазин NV Print: 10 448 готовых страниц, из них
  6 530 — под конкретные модели принтеров.

  Запуск: node tools/build-seo.mjs [--limit N]
  Требует поднятого dev-сервера (tools/serve.mjs) — запускается сам.
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { unpackRows } from './index-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'seo-pages');
/*
  Старые снимки удаляем перед сборкой. Dev-сервер отдаёт seo-pages/*.html, если
  файл есть, поэтому без очистки предрендер снимал бы сам себя: правка шапки или
  подвала в index.html не попадала бы в новые страницы.
*/
fs.rmSync(OUT, { recursive: true, force: true });
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = 'https://hi-black.example';       // боевой домен подставляется здесь
const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const argValue = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const catalog = read('data/catalog/index.json');
const meta = read('data/catalog/meta.json');
const cats = read('data/catalog/categories.json');
const brands = read('data/catalog/brands.json');
const compat = read('data/catalog/compatibility.json');
const live = read('live/catalog-live.json');
const site = read('data/site.json');

const F = Object.fromEntries(meta.fields.map((f, i) => [f, i]));
/* Индекс лежит сжатым — тем же модулем, что его собрал, он и
   разворачивается: предрендер должен видеть раздел «laser», а не номер
   в словаре. */
const products = unpackRows(catalog).map((r) => Object.fromEntries(meta.fields.map((f, i) => [f, r[i]])));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/* ------------------------------- список адресов и описания для каждого */

const routes = [];
const add = (url, file, m) => routes.push({ url, file, meta: m });

add('/', 'home', {
  title: 'Hi-Black — фирменный магазин расходных материалов для принтеров',
  desc: 'Совместимые картриджи, тонеры, чернила и запчасти Hi-Black для принтеров и МФУ Brother, Canon, HP, Kyocera, Samsung, Xerox. Подбор по модели принтера, доставка по всей России.',
});
add('/catalog', 'catalog', {
  title: 'Каталог расходных материалов Hi-Black',
  desc: `Все ${meta.products} позиций Hi-Black: картриджи, тонеры, чернила и запчасти для принтеров и МФУ. Цены и наличие обновляются ежедневно.`,
});
for (const c of cats) {
  add('/catalog/' + c.id, 'catalog/' + c.id, {
    title: `${c.name} Hi-Black — купить в фирменном магазине`,
    desc: c.seo.slice(0, 300),
  });
}
/* Категория и бренд: комбинации, в которых действительно есть товары. */
const combos = new Set();
for (const p of products) combos.add(p.cat + '/' + p.brand);
for (const key of combos) {
  const [cat, brand] = key.split('/');
  const c = cats.find((x) => x.id === cat);
  const b = brands.find((x) => x.id === brand);
  if (!c || !b) continue;
  const n = products.filter((p) => p.cat === cat && p.brand === brand).length;
  add(`/catalog/${cat}/${brand}`, `catalog/${cat}/${brand}`, {
    title: `${c.name} Hi-Black для ${b.name} — ${n} ${plural(n, 'товар', 'товара', 'товаров')}`,
    desc: `Совместимые ${c.name.toLowerCase()} Hi-Black для принтеров и МФУ ${b.name}. Гарантия ресурса, отгрузка со склада в Москве, доставка по России.`,
  });
}
/*
  Какие карточки предрендерить.

  Демонстрационные страницы отдаются поисковику с noindex и в карту сайта
  не попадают — предрендерить их незачем: девять с половиной тысяч файлов
  по 80 КБ это семьсот мегабайт и полтора часа сборки ради страниц,
  которые никто не должен индексировать. Витрина всё равно рисует их в
  браузере, поэтому для человека ничего не меняется.

  Небольшая выборка демо-страниц всё же собирается — чтобы статический
  путь был проверен на настоящих импортированных данных, а не только на
  товарах прототипа.
*/
const DEMO_SAMPLE = Number(argValue('demo-sample', 24));
const seoProducts = [];
let demoTaken = 0;
for (const p of products) {
  if (p.demo) { if (demoTaken >= DEMO_SAMPLE) continue; demoTaken += 1; }
  seoProducts.push(p);
}
const skippedDemo = products.filter((p) => p.demo).length - demoTaken;

for (const p of seoProducts.slice(0, LIMIT)) {
  const l = live.items[p.id] || {};
  add('/product/' + p.slug, 'product/' + p.slug, {
    title: `${p.name} — купить в фирменном магазине Hi-Black`,
    desc: `${p.name}. ${p.res ? 'Ресурс ' + fmt(p.res) + ' страниц. ' : ''}${l.price ? 'Цена ' + fmt(l.price) + ' ₽. ' : ''}Гарантия 12 месяцев, отгрузка со склада в Москве.`,
    product: p,
  });
}
for (const [key, entry] of Object.entries(compat).slice(0, LIMIT)) {
  add('/printer/' + key, 'printer/' + key, {
    title: `Картриджи для ${entry.label} — расходные материалы Hi-Black`,
    desc: `Подходящие картриджи, тонеры и запчасти Hi-Black для ${entry.label}: ${entry.rows.length} ${plural(entry.rows.length, 'позиция', 'позиции', 'позиций')} в наличии и под заказ. Совместимость проверена.`,
  });
}
for (const pg of site.pages) {
  add('/help/' + pg.id, 'help/' + pg.id, {
    title: `${pg.title} — Hi-Black`,
    desc: `${pg.title}: условия фирменного магазина Hi-Black.`,
  });
}
add('/finder', 'finder', {
  title: 'Подбор картриджа по модели принтера — Hi-Black',
  desc: 'Введите модель принтера или МФУ и получите список подходящих картриджей, тонеров и чернил Hi-Black.',
});

function plural(n, a, b, c) { n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }

/* ------------------------------------------------------------- сборка */

const server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), String(PORT)], { stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { } };
process.on('exit', stop); process.on('SIGINT', () => { stop(); process.exit(1); });

await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
/* Витрина не анимирует переходы, когда её снимает предрендер: иначе в готовый
   HTML попадают классы анимации и полоса прогресса, застывшая в середине. */
await page.addInitScript(() => { window.HB_STATIC = true; });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.HBRender && document.querySelector('#app h1, #app h2'), null, { timeout: 20000 });

let done = 0;
const t0 = Date.now();
for (const r of routes) {
  await page.evaluate((u) => { history.pushState({}, '', u); return window.HBRender(); }, r.url);
  let html = await page.content();

  /* Заголовок и описание страницы: их видит поисковик и соцсети. */
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(r.meta.title) + '</title>')
    .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="' + esc(r.meta.desc) + '">');

  const canonical = SITE + r.url;
  let head = (r.meta?.product?.demo ? '<meta name="robots" content="noindex,nofollow">' : '') +
    `<link rel="canonical" href="${canonical}">` +
    `<meta property="og:type" content="${r.meta.product ? 'product' : 'website'}">` +
    `<meta property="og:title" content="${esc(r.meta.title)}">` +
    `<meta property="og:description" content="${esc(r.meta.desc)}">` +
    `<meta property="og:url" content="${canonical}">`;
  if (r.meta.product) {
    const p = r.meta.product, l = live.items[p.id] || {};
    head += `<meta property="og:image" content="${SITE}${p.img}">`;
    /* Микроразметка товара: цена и наличие берутся из живого файла, поэтому
       страницу нужно пересобирать вместе с обновлением остатков. */
    head += '<script type="application/ld+json">' + JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product',
      name: p.name, sku: p.code, brand: { '@type': 'Brand', name: 'Hi-Black' },
      image: SITE + p.img,
      /* AggregateRating выводится только там, где есть настоящие
         опубликованные отзывы. Демо-записи в счётчики не попадают, поэтому
         reviews у таких товаров ноль — и разметки не будет. Цифра в
         разметке обязана совпадать с видимой на странице. */
      aggregateRating: (!p.demo && p.reviews > 0 && p.rate > 0)
        ? { '@type': 'AggregateRating', ratingValue: p.rate, reviewCount: p.reviews }
        : undefined,
      offers: { '@type': 'Offer', price: l.price, priceCurrency: 'RUB', availability: l.available ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder', url: canonical },
    }) + '</script>';
  }
  html = html.replace('</head>', head + '</head>');

  const file = path.join(OUT, r.file + '.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  if (++done % 50 === 0) process.stdout.write(`  ${done}/${routes.length}\n`);
}

/* Оболочка для служебных разделов (корзина, оформление, кабинет) и 404. */
await page.evaluate(() => { history.pushState({}, '', '/cart'); return window.HBRender(); });
fs.writeFileSync(path.join(OUT, 'app.html'), (await page.content())
  .replace(/<title>[\s\S]*?<\/title>/, '<title>Hi-Black — фирменный магазин</title>'));

await page.evaluate(() => { history.pushState({}, '', '/404'); return window.HBRender(); });
fs.writeFileSync(path.join(OUT, '404.html'), (await page.content())
  .replace(/<title>[\s\S]*?<\/title>/, '<title>Страница не найдена — Hi-Black</title>'));

await browser.close();
stop();

/*
  Карта сайта и robots.txt.

  Демонстрационные товары в карту не попадают и помечены noindex: это
  проверочные данные для preview, им нечего делать в поиске. Правило
  одно и то же и для страницы товара, и для его будущей страницы отзывов —
  иначе «не индексируется» превращалось бы в «не индексируется наполовину».
*/
const now = new Date().toISOString().slice(0, 10);
const indexable = routes.filter((r) => !r.meta?.product?.demo);
const demoCount = routes.length - indexable.length;
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  indexable.map((r) => `<url><loc>${SITE}${r.url}</loc><lastmod>${now}</lastmod><changefreq>${r.url === '/' ? 'daily' : 'weekly'}</changefreq></url>`).join('\n') +
  '\n</urlset>\n';
if (demoCount) console.log(`  из карты сайта исключено демонстрационных страниц: ${demoCount}`);
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
fs.writeFileSync(path.join(ROOT, 'robots.txt'), `User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /order\nDisallow: /favorites\nDisallow: /compare\nDisallow: /login\nDisallow: /search\nSitemap: ${SITE}/sitemap.xml\n`);

const bytes = routes.reduce((a, r) => a + fs.statSync(path.join(OUT, r.file + '.html')).size, 0);
console.log(`Собрано страниц: ${routes.length} за ${((Date.now() - t0) / 1000).toFixed(0)} с, ${(bytes / 1024 / 1024).toFixed(1)} МБ`);
console.log(`  товаров ${seoProducts.slice(0, LIMIT).length}, моделей принтеров ${Math.min(Object.keys(compat).length, LIMIT)}, категорий ${cats.length}`);
if (skippedDemo) {
  console.log(`  не предрендерено демонстрационных карточек: ${skippedDemo} (они noindex и вне карты сайта; витрина рисует их в браузере)`);
}
if (errors.length) console.log('  ошибки в браузере:', [...new Set(errors)].slice(0, 5));
