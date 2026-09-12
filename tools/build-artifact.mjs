#!/usr/bin/env node
/*
  Сборка превью набором файлов.

  Зачем вместо «всё в одном». На 9 579 товарах каталог весит около 25 МБ,
  и файл, в который встроено всё, просто не публикуется: ограничение
  страницы — 16 МБ. Но главное даже не размер. Витрина умеет грузить
  каталог по частям — чанк деталей открывается только тогда, когда открыли
  карточку, — а встраивание отменяет это умение и заставляет браузер
  проглотить весь каталог до первого экрана. Набор файлов сохраняет
  штатное поведение: индекс, потом ровно те чанки, которые понадобились.

  Что меняется относительно боевого сайта. Только две вещи, и обе — из-за
  отсутствия сервера: адреса данных становятся относительными (путь с
  ведущим слешем рядом со страницей не обслуживается), а маршруты уезжают
  за решётку (переписывать путь без сервера нельзя). Код витрины при этом
  один и тот же — обе особенности включаются флагами.

    node tools/build-artifact.mjs [--chunk-group=4] [--out=dist/artifact]
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packIndex, unpackRows } from './index-pack.mjs';
import { proxyUrl, shouldProxy, PROXY_ORIGIN } from './image-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
/* Публикация принимает не больше 255 файлов за раз, а чанков деталей при
   размере 32 получается три сотни. Поэтому для превью они склеиваются
   группами — на сайте размер чанка остаётся прежним. */
const GROUP = Math.max(1, Number(argOf('chunk-group', 4)) || 4);
const OUT = path.resolve(ROOT, argOf('out', 'dist/artifact'));
/* `--image-proxy=none` собирает превью с прямыми адресами поставщика —
   нужно, чтобы отличить «политика фрейма запрещает хост» от «прокси сам
   не отвечает». */
const IMAGE_PROXY = argOf('image-proxy', 'wsrv');
const MAX_FILES = 255;

/* Собранный каталог можно взять не из репозитория, а из отдельной папки:
   так превью с демонстрационными записями (--demo-reviews) не требует
   подменять честные data/catalog, из которых строится предрендер.
   Адреса файлов в самом превью при этом не меняются. */
const SRC_CATALOG = path.resolve(ROOT, argOf('catalog', 'data/catalog'));
const SRC_LIVE = path.resolve(ROOT, argOf('live', 'live'));
const srcPath = (rel) => {
  if (rel.startsWith('data/catalog/')) return path.join(SRC_CATALOG, rel.slice('data/catalog/'.length));
  if (rel.startsWith('live/')) return path.join(SRC_LIVE, rel.slice('live/'.length));
  return path.join(ROOT, rel);
};
const read = (rel) => fs.readFileSync(srcPath(rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const published = [];
function put(rel, body) {
  const abs = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  /* Один и тот же файл может встретиться и в разметке, и в стилях, и в
     индексе. В списке публикации он должен быть один: лимит файлов один
     на всю публикацию, и тратить его на повтор незачем. */
  if (!published.includes(rel)) published.push(rel);
  return rel;
}
function copy(rel) {
  const src = srcPath(rel);
  if (!fs.existsSync(src)) return null;
  return put(rel, fs.readFileSync(src));
}

/* ------------------------------------------------------------- данные */

/*
  Адреса картинок внутри данных тоже становятся относительными.

  Это не мелочь и не косметика. Рядом со страницей путь с ведущим слешем
  не обслуживается вовсе, а в каталоге такие пути лежат у 3 282 заглушек
  «Фото не передано», у картинок разделов и у логотипов марок. Переписать
  их только в разметке, как было, недостаточно: в разметке их единицы, а
  в данных — три с половиной тысячи, и именно они попадают в src карточек.
*/
const relativeAssets = (text) => text.replace(/(["'(]|\\")\/assets\//g, '$1assets/');

for (const f of ['meta.json', 'categories.json', 'brands.json',
  'featured.json', 'search-index.json', 'compatibility.json', 'families.json']) {
  put(`data/catalog/${f}`, relativeAssets(read(`data/catalog/${f}`)));
}

/*
  Индекс — отдельно: в нём переписываются адреса картинок поставщика.

  Прямой адрес во фрейме превью не работает: src проставлен, файл по нему
  открывается в отдельной вкладке и отдаёт 200, а naturalWidth остаётся
  нулём. Значит ограничение не в файле, а в том, откуда фрейму разрешено
  грузить картинки. Прокси заодно уменьшает картинку до ширины карточки и
  отдаёт WebP, так что превью ещё и легчает.

  Это правка ТОЛЬКО превью. В data/catalog лежат настоящие адреса
  поставщика, и боевой сайт ходит к нему напрямую.
*/
{
  const idxRaw = JSON.parse(relativeAssets(read('data/catalog/index.json')));
  const rows = unpackRows(idxRaw);
  const col = Object.fromEntries(idxRaw.fields.map((f, i) => [f, i]));
  let proxied = 0;
  if (IMAGE_PROXY !== 'none') {
    for (const row of rows) {
      const url = row[col.img];
      if (typeof url !== 'string' || !shouldProxy(url)) continue;
      row[col.img] = proxyUrl(url, { width: 320 });
      proxied += 1;
    }
  }
  /* Префикс прокси выносится в таблицу баз: он одинаков у всех строк, и
     без этого индекс распух бы на полсотни байт на товар. */
  const bases = [`${PROXY_ORIGIN}?url=`, ...idxRaw.imgBases];
  put('data/catalog/index.json', JSON.stringify(packIndex(idxRaw.fields, rows, { imgBases: bases })));
  console.log(`  адресов картинок через прокси: ${proxied}${IMAGE_PROXY === 'none' ? ' (прокси отключён)' : ''}`);
}
put('data/site.json', relativeAssets(read('data/site.json')));
copy('live/catalog-live.json');

/*
  Атласы миниатюр, если они собраны (tools/pack-thumbs.mjs). Это второй,
  самостоятельный путь: картинки лежат внутри публикации и не зависят ни
  от поставщика, ни от стороннего прокси. Нет атласов — превью работает
  как раньше.
*/
let atlasFiles = 0;
if (fs.existsSync(srcPath('data/catalog/thumbs.json'))) {
  const thumbs = JSON.parse(read('data/catalog/thumbs.json'));
  put('data/catalog/thumbs.json', relativeAssets(read('data/catalog/thumbs.json')));
  for (const rel of thumbs.files ?? []) if (copy(rel)) atlasFiles += 1;
  console.log(`  атласов миниатюр: ${atlasFiles}, товаров с миниатюрой ${Object.keys(thumbs.items ?? {}).length}`);
}

/*
  Склейка чанков. Клиент вычисляет номер чанка как floor(строка /
  chunkSize), поэтому вместе с файлами меняется и chunkSize в meta.json —
  иначе он попросит файл, которого нет.
*/
const meta = readJson('data/catalog/meta.json');
const chunkDir = srcPath('data/catalog/chunks');
const chunkFiles = fs.readdirSync(chunkDir)
  .filter((f) => /^detail-\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

let groups = 0;
/* Демонстрационные записи считаются и называются вслух: собрать превью с
   примерами оформления и не заметить этого нельзя. */
let demoCards = 0, demoRecords = 0;
for (let i = 0; i < chunkFiles.length; i += GROUP) {
  const merged = {};
  for (const f of chunkFiles.slice(i, i + GROUP)) Object.assign(merged, JSON.parse(fs.readFileSync(path.join(chunkDir, f), 'utf8')));
  for (const card of Object.values(merged)) {
    const demo = (card.reviews || []).filter((r) => r && r.demo);
    if (demo.length) { demoCards += 1; demoRecords += demo.length; }
  }
  put(`data/catalog/chunks/detail-${groups}.json`, relativeAssets(JSON.stringify(merged)));
  groups += 1;
}
meta.chunkSize = (meta.chunkSize ?? 32) * GROUP;
/* Число чанков тоже пересчитывается: иначе в meta остаётся счёт исходной
   сборки (137 файлов по 32 товара), а рядом лежит 35 файлов по 128. Поле
   справочное, но расходящееся с действительностью справочное поле хуже
   отсутствующего. */
meta.chunks = groups;
put('data/catalog/meta.json', JSON.stringify(meta));

/* ---------------------------------------------------------- картинки */

/*
  Публикуются только те картинки, на которые действительно есть ссылки:
  в assets/img лежат и исходники, и то, что нужно другим сборкам, а
  лимит файлов один на всю публикацию.
*/
const idx = readJson('data/catalog/index.json');
const site = readJson('data/site.json');
const needed = new Set();
const collect = (value) => {
  if (typeof value === 'string') {
    const m = value.match(/\/assets\/img\/[^"')\s]+/g);
    if (m) for (const one of m) {
      /* Когда карта атласов собрана, индивидуальные VTT-миниатюры уже
         представлены ячейками внутри неё. Публикация тысяч исходных
         файлов поверх атласов снова превысила бы лимит 255 файлов. */
      if (atlasFiles && one.startsWith('/assets/img/vtt/')) continue;
      needed.add(one.slice(1));
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach(collect); return; }
  if (value && typeof value === 'object') Object.values(value).forEach(collect);
};
collect(idx.rows);
collect(readJson('data/catalog/categories.json'));
collect(site);
collect(read('index.html'));
collect(read('assets/css/styles.css'));
for (const rel of needed) copy(rel);

/* Шрифты и иконки из CSS: они грузятся из стилей, а не из разметки. */
const cssText = read('assets/css/fonts.css') + '\n' + read('assets/css/styles.css');
for (const m of cssText.matchAll(/url\((['"]?)(\.\.\/[^'")]+)\1\)/g)) {
  const rel = path.posix.normalize(path.posix.join('assets/css', m[2]));
  copy(rel);
}

/* ------------------------------------------------------------ страница */

/*
  Код витрины встраивается в страницу, а данные — нет. Скрипты и стили
  весят сотни килобайт и нужны сразу; каталог весит десятки мегабайт и
  нужен по частям. Встроить первое и оставить второе файлами — ровно то
  разделение, ради которого всё это и затевалось.
*/
const css = (read('assets/css/fonts.css') + '\n' + read('assets/css/styles.css'))
  .replace(/url\((['"]?)(\.\.\/[^'")]+)\1\)/g, (m, q, rel) => `url(${path.posix.normalize(path.posix.join('assets/css', rel))})`);
const js = read('assets/js/icons.js') + '\n' + read('assets/js/catalog.js') + '\n' + read('assets/js/app.js');

let html = read('index.html');
html = html
  .replace(/<link rel="preload"[^>]*>\s*/g, '')
  .replace(/<link rel="stylesheet" href="\/assets\/css\/fonts.css">\s*/, '')
  .replace('<link rel="stylesheet" href="/assets/css/styles.css">', '<style>\n' + css + '\n</style>')
  .replace(
    /<script src="\/assets\/js\/icons.js"><\/script>\s*<script src="\/assets\/js\/catalog.js"><\/script>\s*<script src="\/assets\/js\/app.js"><\/script>/,
    '<script>window.HB_DATA_BASE = "./"; window.HB_HASH_ROUTING = true;</script>\n<script>\n' + js + '\n</script>',
  );
/* Ссылки на картинки в разметке тоже становятся относительными. */
html = html.replace(/(src|href)="\/assets\//g, '$1="assets/');

const title = '<title>Магазин Hi-Black</title>';
const style = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const body = (html.match(/<body>([\s\S]*)<\/body>/) || ['', ''])[1];
/*
  Объявление кодировки нужно: простой preview-сервер может не добавить
  charset в Content-Type, и тогда русский текст превращается в mojibake
  ещё до выполнения встроенного JS. Оно идёт первым, в пределах первой
  тысячи байт, — иначе браузер успеет выбрать кодировку сам.

  А вот полного каркаса здесь быть не должно. Публикация сама оборачивает
  файл в <!doctype html><head>…</head><body>, и второй такой каркас
  внутри даёт вложенные html и body: разметка становится невалидной, а
  теги из внутренней «головы» разбираются как содержимое тела. Поэтому
  отдаём только то, что кладётся в тело, — заголовок, стили и разметку.
*/
/*
  Превью не должно попадать в индекс ни при каких условиях. Это не боевая
  витрина: здесь может стоять флаг --demo-reviews с примерами оформления
  вместо отзывов, здесь адреса картинок идут через прокси, а данные
  собраны для просмотра, а не для покупателя из поиска. Боевые страницы
  строит tools/build-seo.mjs из data/catalog, и этой строки там нет.
*/
const noindex = '<meta name="robots" content="noindex,nofollow">';
fs.writeFileSync(path.join(OUT, 'index.html'),
  '<meta charset="utf-8">\n' + noindex + '\n' + title + '\n' + style + '\n' + body);

/* --------------------------------------------------------------- итог */

const bytes = published.reduce((a, rel) => a + fs.statSync(path.join(OUT, rel)).size, 0);
const page = fs.statSync(path.join(OUT, 'index.html')).size;
const mb = (n) => (n / 1048576).toFixed(2) + ' МБ';
console.log(`Превью собрано в ${path.relative(ROOT, OUT)}`);
if (demoCards) {
  console.log(`  ДЕМОНСТРАЦИОННЫЕ ЗАПИСИ: ${demoRecords} на ${demoCards} карточках — примеры оформления, не отзывы.`);
  console.log('  Страница помечена noindex; предрендер и карта сайта строятся отдельно и этих записей не содержат.');
}
console.log(`  страница ${mb(page)}, файлов рядом ${published.length}, данные ${mb(bytes)}`);
console.log(`  чанков деталей ${groups} (по ${meta.chunkSize} товаров), картинок ${needed.size}` +
  (atlasFiles ? `, атласов ${atlasFiles}` : ''));
console.log(`  файлов ${published.length + 1} из ${MAX_FILES} — запас ${MAX_FILES - published.length - 1}`);
if (published.length + 1 > MAX_FILES) {
  console.error(`  ОШИБКА: файлов ${published.length + 1}, публикация принимает не больше ${MAX_FILES}`);
  process.exit(1);
}
if (page > 16 * 1048576) {
  console.error('  ОШИБКА: страница больше 16 МБ');
  process.exit(1);
}
/* Список публикуемых файлов лежит РЯДОМ с каталогом, а не внутри: иначе
   он сам попал бы в публикацию и занял место в лимите. */
fs.writeFileSync(`${OUT}.files.json`, JSON.stringify(published, null, 1));
