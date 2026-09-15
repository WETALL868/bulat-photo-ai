#!/usr/bin/env node
/*
  Проверка фотографий по всему каталогу.

  Ищет четыре разных беды, которые снаружи выглядят одинаково — «нет
  картинки», — но чинятся по-разному:

    битая ссылка      адрес есть, файла в проекте нет: на сайте будет 404
    горячая ссылка    адрес ведёт на b2b.vtt.ru: чужой сервер, офлайн не
                      работает, источник виден покупателю
    неожиданная       стоит заглушка, хотя у поставщика снимок есть, —
    заглушка          значит, его потеряли по дороге
    испорченный файл  файл есть, но это не изображение или он пуст

  Отдельно считается честное состояние: поставщик прислал PhotoUrl
  «dummy.jpg», снимка нет ни у кого, и заглушка на карточке правдива.
  Такие позиции выписываются списком — с адресом, артикулом и кодом
  товара, чтобы снимок можно было добавить руками.

    node tools/audit-photos.mjs            отчёт в консоль
    node tools/audit-photos.mjs --json     плюс файл vtt-data/reports/photos.json
    node tools/audit-photos.mjs --list     полный список позиций без снимка

  Код возврата 1, если нашлась хоть одна из четырёх бед: этим же кодом
  проверка годится для CI.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const R = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const PLACEHOLDER = '/assets/img/no-photo.svg';

const idx = R('data/catalog/index.json');
const F = Object.fromEntries(idx.fields.map((k, i) => [k, i]));
const slugs = fs.existsSync(path.join(ROOT, 'data/product-slugs.json'))
  ? R('data/product-slugs.json').items : {};
const registry = fs.existsSync(path.join(ROOT, 'data/item-registry.json'))
  ? R('data/item-registry.json').items : {};
const thumbs = fs.existsSync(path.join(ROOT, 'data/catalog/thumbs.json'))
  ? R('data/catalog/thumbs.json') : null;

/* Идентификатор витрины -> Id поставщика: по нему сверяемся со стором. */
const vttOf = {};
for (const [key, rec] of Object.entries(registry)) {
  if (key.startsWith('vtt:')) vttOf[rec.id] = key.slice(4);
}
/* Стор поставщика читаем, если он есть: на чистом клоне его нет, и тогда
   проверка «заглушка при живом снимке» просто пропускается. */
const storeDir = path.join(ROOT, 'vtt-data/items');
const store = {};
let storeRead = false;
if (fs.existsSync(storeDir)) {
  for (const f of fs.readdirSync(storeDir)) {
    if (f.endsWith('.json')) Object.assign(store, R('vtt-data/items/' + f));
  }
  storeRead = true;
}

/* Индекс пакует повторяющиеся начала адресов в таблицу баз. */
const unpack = (v) => {
  const s = String(v ?? '');
  return s.charCodeAt(0) === 1 ? idx.imgBases[Number(s[1])] + s.slice(2) : s;
};

/* Файл должен быть не пустым и начинаться сигнатурой изображения. */
function looksLikeImage(abs) {
  const st = fs.statSync(abs);
  if (st.size < 64) return false;
  const b = fs.readFileSync(abs).subarray(0, 8);
  if (b.toString('ascii', 0, 4) === 'RIFF') return true;          // webp
  if (b[0] === 0xff && b[1] === 0xd8) return true;                 // jpeg
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return true;
  const head = fs.readFileSync(abs).subarray(0, 300).toString('utf8');
  return /<svg[\s>]/i.test(head) || /^\s*<\?xml/.test(head);       // svg
}

const broken = [], hotlink = [], unexpected = [], corrupt = [], noPhoto = [];
const checked = new Set();
let withPhoto = 0;

for (const row of idx.rows) {
  const id = row[0];
  const img = unpack(row[F.img]);
  const info = {
    id,
    no: row[F.no],
    code: row[F.code],
    name: row[F.name],
    url: '/product/' + ((slugs[id] || {}).slug || id),
    img,
  };
  const vid = vttOf[id];
  const supplied = storeRead && vid && Array.isArray((store[vid] || {}).photos)
    ? store[vid].photos : [];
  info.originalNumber = storeRead && vid ? (store[vid] || {}).originalNumber || '' : '';

  if (/^https?:/i.test(img)) { hotlink.push(info); continue; }
  if (img === PLACEHOLDER || !img) {
    /* Ячейка атласа — тоже снимок: заглушка при живой ячейке это ошибка. */
    const cell = thumbs && ((thumbs.items || {})[id] || (vid && (thumbs.byVtt || {})[vid]));
    if (supplied.length || cell) {
      info.reason = supplied.length ? 'у поставщика снимок есть' : 'есть ячейка атласа';
      info.supplied = supplied[0] || '';
      unexpected.push(info);
    } else {
      info.missingFile = vid ? `снимка нет в выгрузке поставщика (Id ${vid}, PhotoUrl dummy.jpg)` : 'снимок не задан';
      noPhoto.push(info);
    }
    continue;
  }
  const rel = img.replace(/^\//, '');
  const abs = path.join(ROOT, rel);
  if (!checked.has(rel)) {
    checked.add(rel);
    if (!fs.existsSync(abs)) { broken.push({ ...info, missingFile: rel }); continue; }
    if (!looksLikeImage(abs)) { corrupt.push({ ...info, missingFile: rel }); continue; }
  } else if (!fs.existsSync(abs)) { broken.push({ ...info, missingFile: rel }); continue; }
  withPhoto += 1;
}

/* Картинки разделов и логотипы марок — тоже адреса, которые отдаёт сервер. */
const extra = [];
for (const c of R('data/catalog/categories.json')) {
  if (c.img && c.img.startsWith('/assets/') && !fs.existsSync(path.join(ROOT, c.img.slice(1)))) {
    extra.push({ url: '/catalog/' + c.id, img: c.img, missingFile: c.img });
  }
}
for (const b of R('data/catalog/brands.json')) {
  if (b.logo && b.logo.startsWith('/assets/') && !fs.existsSync(path.join(ROOT, b.logo.slice(1)))) {
    extra.push({ url: '/catalog?brand=' + b.id, img: b.logo, missingFile: b.logo });
  }
}
/* Файлы атласа миниатюр: без них тысячи карточек молча остаются пустыми. */
for (const f of (thumbs && thumbs.files) || []) {
  if (!fs.existsSync(path.join(ROOT, String(f).replace(/^\//, '')))) {
    extra.push({ url: '(атлас миниатюр)', img: f, missingFile: f });
  }
}

const problems = broken.length + hotlink.length + unexpected.length + corrupt.length + extra.length;
console.log(`товаров в каталоге: ${idx.rows.length}`);
console.log(`  со снимком: ${withPhoto}`);
console.log(`  без снимка (заглушка правдива): ${noPhoto.length}`);
console.log('');
console.log(`битых ссылок (файла нет): ${broken.length}`);
broken.slice(0, 10).forEach((x) => console.log(`   ${x.no} ${x.code} -> ${x.missingFile}`));
console.log(`горячих ссылок на поставщика: ${hotlink.length}`);
hotlink.slice(0, 10).forEach((x) => console.log(`   ${x.no} ${x.code} -> ${x.img}`));
console.log(`неожиданных заглушек: ${unexpected.length}`);
unexpected.slice(0, 10).forEach((x) => console.log(`   ${x.no} ${x.code} -> ${x.reason}: ${x.supplied}`));
console.log(`испорченных файлов: ${corrupt.length}`);
corrupt.slice(0, 10).forEach((x) => console.log(`   ${x.no} ${x.code} -> ${x.missingFile}`));
console.log(`битых картинок разделов, марок и атласа: ${extra.length}`);
extra.slice(0, 10).forEach((x) => console.log(`   ${x.url} -> ${x.missingFile}`));

if (args.includes('--list')) {
  console.log('\nПОЗИЦИИ БЕЗ СНИМКА (адрес, артикул, код товара, чего не хватает):');
  for (const x of noPhoto) {
    console.log(`  ${x.url}\n    артикул ${x.code} | код товара ${x.no} | ${x.missingFile}`);
  }
}
if (args.includes('--json')) {
  const out = path.join(ROOT, 'vtt-data/reports/photos.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: idx.rows.length, withPhoto,
    broken, hotlink, unexpected, corrupt, extra, noPhoto,
  }, null, 1));
  console.log(`\nотчёт: ${path.relative(ROOT, out)}`);
}
if (problems) {
  console.log(`\nНАЙДЕНО ПРОБЛЕМ: ${problems}`);
  process.exit(1);
}
console.log('\nбитых ссылок, горячих ссылок и неожиданных заглушек нет');
