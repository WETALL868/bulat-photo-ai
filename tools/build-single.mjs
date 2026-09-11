#!/usr/bin/env node
/*
  Сборка витрины в один HTML-файл.

  Нужна только для показа: отправить прототип вложением или открыть с телефона
  без сервера. Внутрь встраиваются стили, скрипты, шрифты, картинки и весь
  каталог целиком, поэтому файл получается тяжёлым — боевой сайт так не
  работает и грузит данные по частям.

  Каталог кладётся в window.HB_INLINE под теми же адресами, по которым витрина
  обычно ходит на сервер: клиент это видит и не делает запросов. Маршруты в
  таком режиме живут после решётки, потому что переписывать путь без сервера
  нельзя.

    node tools/build-single.mjs             → dist/hi-black.html
    node tools/build-single.mjs --artifact   → dist/hi-black-artifact.html
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = process.argv.includes('--artifact');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function dataUri(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('Нет файла: ' + rel);
  const ext = path.extname(rel).toLowerCase();
  return 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + fs.readFileSync(abs).toString('base64');
}
const inlineCssUrls = (css) => css.replace(/url\((['"]?)(\.\.\/[^'")]+)\1\)/g, (m, q, rel) => 'url(' + dataUri(path.join('assets/css', rel)) + ')');
const inlineHtmlSrcs = (html) => html.replace(/(src|href)="(\/assets\/img\/[^"]+)"/g, (m, attr, rel) => attr + '="' + dataUri(rel.slice(1)) + '"');

/* Те же адреса, по которым витрина ходит за данными. */
function collectData() {
  const map = {};
  const put = (url, rel) => { map[url] = JSON.parse(read(rel)); };
  put('/data/catalog/meta.json', 'data/catalog/meta.json');
  put('/data/catalog/index.json', 'data/catalog/index.json');
  put('/data/catalog/categories.json', 'data/catalog/categories.json');
  put('/data/catalog/brands.json', 'data/catalog/brands.json');
  put('/data/catalog/featured.json', 'data/catalog/featured.json');
  put('/data/catalog/search-index.json', 'data/catalog/search-index.json');
  put('/data/catalog/compatibility.json', 'data/catalog/compatibility.json');
  put('/data/catalog/families.json', 'data/catalog/families.json');
  put('/live/catalog-live.json', 'live/catalog-live.json');
  put('/data/site.json', 'data/site.json');
  for (const f of fs.readdirSync(path.join(ROOT, 'data/catalog/chunks'))) {
    put('/data/catalog/chunks/' + f, 'data/catalog/chunks/' + f);
  }
  /* Фотографии товаров превращаем в data-URI прямо в индексе. */
  const seen = {};
  const toUri = (p) => {
    if (!p || !p.startsWith('/assets/')) return p;
    if (!seen[p]) seen[p] = dataUri(p.slice(1));
    return seen[p];
  };
  const idx = map['/data/catalog/index.json'];
  const imgCol = idx.fields.indexOf('img');
  idx.rows.forEach((r) => { r[imgCol] = toUri(r[imgCol]); });
  map['/data/catalog/categories.json'].forEach((c) => { c.img = toUri(c.img); });
  map['/data/site.json'].brandLogos = Object.fromEntries(
    Object.entries(map['/data/site.json'].brandLogos).map(([k, v]) => [k, v ? toUri(v) : v])
  );
  /* Официальный знак MAX витрина берёт по адресу из site.json. В одном файле
     сервера нет, поэтому путь заменяем на data-URI — знак остаётся тем же
     файлом, просто уложенным внутрь. */
  const mx = map['/data/site.json'].messengers && map['/data/site.json'].messengers.max;
  if (mx && mx.icon) mx.icon = toUri(mx.icon);
  /* Тексты страниц приходят готовой разметкой, и картинки внутри них тоже
     ведут на /assets. Проходим по строкам и подставляем те же data-URI:
     иначе в одном файле такие картинки остаются битыми. */
  const inlineDataSrcs = (o) => {
    if (typeof o === 'string') {
      return o.replace(/(src|href)="(\/assets\/img\/[^"]+)"/g, (m, a, rel) => a + '="' + toUri(rel) + '"');
    }
    if (Array.isArray(o)) return o.map(inlineDataSrcs);
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) o[k] = inlineDataSrcs(o[k]);
    }
    return o;
  };
  map['/data/site.json'].pageText = inlineDataSrcs(map['/data/site.json'].pageText);
  return map;
}

let html = read('index.html');
const css = inlineCssUrls(read('assets/css/fonts.css') + '\n' + read('assets/css/styles.css'));
const js = read('assets/js/icons.js') + '\n' + read('assets/js/catalog.js') + '\n' + read('assets/js/app.js');
const data = 'window.HB_INLINE = ' + JSON.stringify(collectData()) + ';';

html = html
  .replace(/<link rel="preload"[^>]*>\s*/g, '')
  .replace(/<link rel="stylesheet" href="\/assets\/css\/fonts.css">\s*/, '')
  .replace('<link rel="stylesheet" href="/assets/css/styles.css">', '<style>\n' + css + '\n</style>')
  .replace(
    /<script src="\/assets\/js\/icons.js"><\/script>\s*<script src="\/assets\/js\/catalog.js"><\/script>\s*<script src="\/assets\/js\/app.js"><\/script>/,
    '<script>\n' + data + '\n</script>\n<script>\n' + js + '\n</script>'
  );
html = inlineHtmlSrcs(html);

if (artifact) {
  // Артефакт сам оборачивает содержимое в документ: оставляем заголовок, стили и тело.
  const title = '<title>Магазин Hi-Black</title>';
  const style = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  const body = (html.match(/<body>([\s\S]*)<\/body>/) || ['', ''])[1];
  html = title + '\n' + style + '\n' + body;
}

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', artifact ? 'hi-black-artifact.html' : 'hi-black.html');
fs.writeFileSync(out, html);
console.log('Собрано:', path.relative(ROOT, out), (fs.statSync(out).size / 1024 / 1024).toFixed(2) + ' МБ');
