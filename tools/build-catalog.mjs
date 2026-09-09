#!/usr/bin/env node
/*
  Сборщик каталога.

  Превращает выгрузку товаров в набор статичных файлов, которые витрина читает
  через fetch. Смысл разделения такой же, как у эталонного магазина NV Print:

    data/catalog/   меняется редко, кешируется браузером надолго
    live/           цены и остатки, обновляются по расписанию

  Главный приём — компактный индекс. Каждый товар записан массивом значений без
  имён полей, имена лежат один раз в meta.fields. На 90 товарах разница
  небольшая, на боевых 3 400 позициях это разница между 3 МБ и 400 КБ.

  Цен и остатков в индексе нет намеренно: они живут в live/catalog-live.json и
  подмешиваются на клиенте. Поэтому обновление цен не трогает каталог и не
  сбрасывает кеш витрины.

  Запуск:
    node tools/build-catalog.mjs                       из assets/js/data.js
    node tools/build-catalog.mjs --source vtt-csv --in out/hiblack_catalog.csv
*/
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_CATALOG = path.join(ROOT, 'data/catalog');
const OUT_LIVE = path.join(ROOT, 'live');
const CHUNK_SIZE = 32; // товаров в одном файле деталей

const args = process.argv.slice(2);
const argOf = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const SOURCE = argOf('source', 'data-js');
const IN_FILE = argOf('in', null);

/* ---------------------------------------------------------------- источники */

/*
  Путь к фотографии товара. Исходная выгрузка знает файл как .jpg, но картинки
  перекодированы в WebP (tools/optimize-images.mjs), поэтому берём тот файл,
  который действительно лежит на диске.
*/
function imagePath(rel) {
  if (!rel) return '';
  const webp = rel.replace(/\.(jpe?g|png)$/i, '.webp');
  if (fs.existsSync(path.join(ROOT, webp))) return '/' + webp;
  if (fs.existsSync(path.join(ROOT, rel))) return '/' + rel;
  return '';
}

/* Текущий прототип: window.HB из assets/js/data.js. */
function readDataJs() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'catalog-source/data.js'), 'utf8'), ctx);
  const D = ctx.window.HB;
  const products = D.products.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    model: p.model,
    cat: p.cat,
    brand: p.brand,
    type: p.type,
    res: p.res ?? null,
    color: p.color || '',
    chip: p.chip ?? null,
    compat: p.compat || '',
    models: p.models || [],
    equip: p.equip || '',
    tech: p.tech || '',
    print: p.print || '',
    weight: p.weight || '',
    img: imagePath(D.img[p.img]),
    rate: p.rate,
    reviews: p.n,
    pop: p.pop,
    badge: p.badge || '',
    price: p.price,
    old: p.old || 0,
    stock: p.stock ? 1 : 0,
  }));
  return { products, cats: D.cats, brands: D.brands, laserBrands: D.laserBrands, lines: D.lines, pages: D.pages, pageText: D.pageText };
}

/*
  Боевая выгрузка ВТТ (hiblack_catalog.csv, разделитель «;», UTF-8).

  Колонки распознаются по заголовку: у экспортёра они названы под мастер импорта
  Shop-Script («Цвет <color>», «Ресурс, страниц <resource>»), поэтому сверяем по
  вхождению ключевого слова, а не по точному совпадению. Когда появится реальный
  файл, поправить нужно будет только таблицу COLUMNS ниже.
*/
const COLUMNS = {
  name: ['наименование', 'название'],
  code: ['артикул'],
  price: ['цена'],
  old: ['зачеркнут', 'старая цена'],
  stock: ['остаток', 'наличие'],
  cat: ['категория'],
  brand: ['вендор', 'марка техники'],
  type: ['тип продукции'],
  res: ['ресурс'],
  color: ['цвет'],
  chip: ['чип'],
  compat: ['совместим', 'подходит к моделям'],
  img: ['изображен', 'фото'],
};

function splitCsvLine(line, sep) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readVttCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const head = splitCsvLine(lines[0], sep).map((h) => h.toLowerCase().trim());
  const col = {};
  for (const [key, words] of Object.entries(COLUMNS)) {
    col[key] = head.findIndex((h) => words.some((w) => h.includes(w)));
  }
  const missing = ['name', 'code', 'price'].filter((k) => col[k] < 0);
  if (missing.length) throw new Error('В CSV не найдены колонки: ' + missing.join(', ') + '. Поправьте таблицу COLUMNS в tools/build-catalog.mjs');

  const num = (s) => { const v = parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(v) ? v : 0; };
  const products = [];
  for (let i = 1; i < lines.length; i++) {
    const r = splitCsvLine(lines[i], sep);
    const get = (k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
    const name = get('name');
    if (!name || name.startsWith('!')) continue; // строки категорий импорта Shop-Script
    const code = get('code');
    const compat = get('compat');
    products.push({
      id: slugify(code || name),
      name,
      code,
      model: (code || '').replace(/^HB-/i, ''),
      cat: catFromText(get('cat') || get('type') || name),
      brand: brandFromText(get('brand') || compat || name),
      type: get('type') || typeFromName(name),
      res: num(get('res')) || null,
      color: get('color'),
      chip: /без\s*чипа/i.test(name) ? false : (/с\s*чипом/i.test(name) || /да|есть/i.test(get('chip')) ? true : null),
      compat,
      models: compat ? compat.split(/[,/]/).map((s) => s.trim()).filter(Boolean).slice(0, 24) : [],
      equip: '', tech: '', print: '', weight: '',
      img: get('img').split(/[|,]/)[0] || '',
      rate: 0, reviews: 0, pop: 50,
      badge: '',
      price: num(get('price')),
      old: num(get('old')),
      stock: num(get('stock')) > 0 ? 1 : 0,
    });
  }
  return { products, cats: null, brands: null, laserBrands: null, lines: null, pages: null, pageText: null };
}

/* ------------------------------------------------------- вспомогательное */

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
function slugify(s) {
  return String(s).toLowerCase().replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function catFromText(s) {
  const t = String(s).toLowerCase();
  if (/матрич|лент/.test(t)) return 'matrix';
  if (/чернил/.test(t)) return 'inks';
  if (/тонер(?!-картридж)/.test(t)) return 'toner';
  if (/струйн/.test(t)) return 'ink';
  if (/зип|запчаст|ролик|печк|барабан|чип/.test(t)) return 'zip';
  return 'laser';
}
const BRAND_WORDS = { hp: 'hp', kyocera: 'kyocera', canon: 'canon', brother: 'brother', samsung: 'samsung', xerox: 'xerox', ricoh: 'ricoh', epson: 'epson', lexmark: 'lexmark', oki: 'oki', panasonic: 'panasonic', sharp: 'sharp', toshiba: 'toshiba', pantum: 'pantum', 'konica': 'konica', 'катюша': 'katusha' };
function brandFromText(s) {
  const t = String(s).toLowerCase();
  for (const [w, id] of Object.entries(BRAND_WORDS)) if (t.includes(w)) return id;
  return 'universal';
}
function typeFromName(n) {
  const t = String(n).toLowerCase();
  if (/тонер-картридж/.test(t)) return 'Тонер-картридж';
  if (/^тонер|\sтонер\s/.test(t)) return 'Тонер';
  if (/чернил/.test(t)) return 'Чернила';
  return 'Картридж';
}
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Описание и характеристики собираются один раз здесь, а не в браузере на
   каждый показ карточки: так тот же текст попадает в предрендер для поиска. */
function buildDescription(p, brandName) {
  const kind = p.type === 'Тонер' ? 'Тонер' : p.type === 'Чернила' ? 'Чернила' : p.type === 'Запчасть' ? 'Запасная часть' : 'Совместимый ' + p.type.toLowerCase();
  let out = `<h3>${esc(kind + ' Hi-Black ' + p.code)}</h3>`;
  out += `<p>${esc(kind)} Hi-Black ${esc(p.code)}${p.compat ? ' для ' + esc(p.compat.replace(/^для\s+/, '')) : ''}.`;
  if (p.res) out += ` Ресурс — ${fmt(p.res)} страниц формата A4 при 5% заполнении, что соответствует оригинальному расходнику ${esc(brandName + ' ' + p.model)}.`;
  out += '</p>';
  if (p.chip === true) out += `<p>Встроенный чип корректно распознаётся принтером и ведёт учёт отпечатков — после установки не нужно сбрасывать счётчик или менять настройки. Тонер подобран под печку ${esc(brandName)}: равномерная заливка, чёткий мелкий текст, без полос и осыпания.</p>`;
  else if (p.chip === false) out += `<p>Версия без чипа: перед установкой переставьте чип со старого картриджа или используйте принтер с отключённым контролем расходников. Тонер подобран под печку ${esc(brandName)}: равномерная заливка, чёткий мелкий текст, без полос.</p>`;
  else if (p.type === 'Тонер') out += `<p>Тонер в банке для самостоятельной заправки картриджей. Подобран по составу и температуре плавления под печку ${esc(brandName)} — заправленный картридж печатает так же, как новый.</p>`;
  else if (p.type === 'Чернила') out += '<p>Водорастворимые чернила для заправки картриджей и СНПЧ. Не засоряют дюзы печатающей головки, дают насыщенный цвет и совпадают по профилю с оригинальными.</p>';
  else out += '<p>Продукция Hi-Black проходит контроль качества на каждом этапе производства и не нарушает патенты производителя оборудования.</p>';
  out += '<ul>' + (p.res ? '<li>Заявленный ресурс подтверждён тестами по ISO/IEC 19752</li>' : '') + '<li>Не нарушает патенты производителя принтера</li><li>Гарантия 12 месяцев, обмен при браке</li></ul>';
  out += '<p>Если сомневаетесь в совместимости, введите модель принтера в поле подбора в шапке сайта — покажем все подходящие расходники.</p>';
  return out;
}
function buildSpecs(p, brandName) {
  const rows = [];
  if (p.equip) rows.push(['Тип оборудования', p.equip]);
  rows.push(['Торговая марка', 'Hi-Black'], ['Код производителя', p.code]);
  if (p.model) rows.push(['Модель', p.model]);
  rows.push(['Тип продукции', p.type]);
  if (p.tech) rows.push(['Технология печати', p.tech]);
  if (p.print) rows.push(['Тип печати', p.print]);
  if (p.res) rows.push(['Ресурс', fmt(p.res) + ' страниц при 5% заполнении']);
  if (p.color) rows.push(['Цвет', p.color]);
  if (p.chip !== null) rows.push(['Чип', p.chip ? 'Есть' : 'Нет']);
  if (p.weight) rows.push(['Вес нетто', p.weight]);
  if (p.compat) rows.push(['Совместимость', p.compat.replace(/^для\s+/, '')]);
  rows.push(['Вендор оборудования', brandName]);
  if (p.model && p.type !== 'Тонер' && p.type !== 'Чернила') rows.push(['Оригинальный аналог', brandName + ' ' + p.model]);
  rows.push(['Гарантия', '12 месяцев'], ['Страна производства', 'Китай']);
  return rows;
}

/* --------------------------------------------------------------- сборка */

const src = SOURCE === 'vtt-csv' ? readVttCsv(IN_FILE || path.join(ROOT, 'out/hiblack_catalog.csv')) : readDataJs();
const fallback = SOURCE === 'vtt-csv' ? readDataJs() : src; // словари и тексты страниц берём из прототипа
const products = src.products;
const cats = src.cats || fallback.cats;
const brandDict = src.brands || fallback.brands;
const laserBrands = src.laserBrands || fallback.laserBrands;
const brandName = (id) => (brandDict[id] ? brandDict[id].name : id);

products.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name, 'ru'));

/*
  Адрес товара. Код производителя не уникален: один и тот же картридж бывает с
  чипом и без, код у них общий. Поэтому за основу берём идентификатор товара, а
  совпадения всё равно разводим числовым хвостом — иначе две карточки получат
  один адрес и одна из них выпадет из предрендера.
*/
const takenSlugs = new Set();
function uniqueSlug(p) {
  const base = slugify(p.id || p.code) || 'tovar';
  let s = base, n = 2;
  while (takenSlugs.has(s)) s = base + '-' + n++;
  takenSlugs.add(s);
  return s;
}

/* Компактный индекс: порядок полей задан один раз. */
const FIELDS = ['id', 'slug', 'name', 'code', 'cat', 'brand', 'img', 'type', 'res', 'color', 'chip', 'badge', 'rate', 'reviews'];
const rows = products.map((p) => [
  p.id,
  uniqueSlug(p),
  p.name,
  p.code,
  p.cat,
  p.brand,
  p.img,
  p.type,
  p.res,
  p.color,
  p.chip === null ? null : p.chip ? 1 : 0,
  p.badge,
  p.rate,
  p.reviews,
]);
const rowOf = new Map(products.map((p, i) => [p.id, i]));

/* Детали: только то, что нужно на карточке товара. Грузится чанком по 32. */
const chunks = [];
for (let i = 0; i < products.length; i += CHUNK_SIZE) {
  const part = {};
  for (const p of products.slice(i, i + CHUNK_SIZE)) {
    part[p.id] = {
      compat: p.compat,
      models: p.models,
      equip: p.equip,
      weight: p.weight,
      desc: buildDescription(p, brandName(p.brand)),
      specs: buildSpecs(p, brandName(p.brand)),
    };
  }
  chunks.push(part);
}

/* Поисковый индекс: токен → номера строк. Клиент ищет по началу слова. */
const searchIndex = {};
products.forEach((p, i) => {
  const text = [p.name, p.code, p.model, p.compat, brandName(p.brand), p.type, p.color].join(' ').toLowerCase();
  for (const tok of new Set(text.split(/[^0-9a-zа-яё]+/i).filter((t) => t.length >= 2))) {
    (searchIndex[tok] ||= []).push(i);
  }
});

/* Совместимость: страница под каждую модель принтера — источник поискового трафика. */
const compatibility = {};
products.forEach((p, i) => {
  for (const m of p.models) {
    const key = slugify(brandName(p.brand) + ' ' + m);
    if (!key) continue;
    (compatibility[key] ||= { brand: p.brand, model: m, label: brandName(p.brand) + ' ' + m, rows: [] }).rows.push(i);
  }
});

/* Категории и бренды с реальными счётчиками. */
const catCount = {}, brandCount = {};
for (const p of products) { catCount[p.cat] = (catCount[p.cat] || 0) + 1; brandCount[p.brand] = (brandCount[p.brand] || 0) + 1; }
const categories = cats.map((c) => ({ ...c, img: (fallback.products?.find?.((x) => x.id === c.img) ? '' : ''), count: catCount[c.id] || 0 }));
// картинка категории — фото первого товара в ней
for (const c of categories) {
  const first = products.find((p) => p.cat === c.id && p.img);
  c.img = first ? first.img : '';
}
const brands = Object.keys(brandDict)
  .filter((id) => brandCount[id])
  .map((id) => ({ id, name: brandDict[id].name, logo: brandDict[id].logo || null, count: brandCount[id] }))
  .sort((a, b) => b.count - a.count);

/* Цены и остатки — отдельно. Именно этот файл будет обновлять cron. */
const now = new Date();
const live = {
  version: 1,
  updatedAt: now.toISOString(),
  updatedAtMoscow: now.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' МСК',
  stores: ['Москва'],
  products: products.length,
  items: {},
};
for (const p of products) {
  live.items[p.id] = { price: p.price, old: p.old || undefined, stock: p.stock ? 1 : 0, available: !!p.stock };
}

const featured = products.slice(0, 8).map((p) => p.id);

/* ----------------------------------------------------------------- запись */

fs.rmSync(OUT_CATALOG, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_CATALOG, 'chunks'), { recursive: true });
fs.mkdirSync(OUT_LIVE, { recursive: true });

const write = (file, data) => {
  const p = path.join(ROOT, file);
  fs.writeFileSync(p, JSON.stringify(data));
  return fs.statSync(p).size;
};

const sizes = {};
sizes.index = write('data/catalog/index.json', { fields: FIELDS, rows });
sizes.categories = write('data/catalog/categories.json', categories);
sizes.brands = write('data/catalog/brands.json', brands);
sizes.compatibility = write('data/catalog/compatibility.json', compatibility);
sizes.search = write('data/catalog/search-index.json', searchIndex);
sizes.featured = write('data/catalog/featured.json', featured);
chunks.forEach((c, i) => write(`data/catalog/chunks/detail-${i}.json`, c));
sizes.chunks = chunks.reduce((a, _, i) => a + fs.statSync(path.join(OUT_CATALOG, `chunks/detail-${i}.json`)).size, 0);
sizes.live = write('live/catalog-live.json', live);
write('live/update-status.json', {
  status: 'ok',
  lastRunAt: now.toISOString(),
  lastSuccessAtMoscow: live.updatedAtMoscow,
  products: products.length,
  available: products.filter((p) => p.stock).length,
  source: SOURCE === 'vtt-csv' ? 'ВТТ, выгрузка CSV' : 'прототип, assets/js/data.js',
});

const meta = {
  generatedAt: now.toISOString(),
  source: SOURCE,
  products: products.length,
  categories: categories.length,
  brands: brands.length,
  compatibilityModels: Object.keys(compatibility).length,
  chunkSize: CHUNK_SIZE,
  chunks: chunks.length,
  inStock: products.filter((p) => p.stock).length,
  fields: FIELDS,
  bytes: { ...sizes, firstLoad: sizes.index + sizes.categories + sizes.brands + sizes.live },
};
write('data/catalog/meta.json', meta);

/* Словари и тексты страниц, которые не относятся к товарам. */
write('data/site.json', {
  laserBrands,
  lines: fallback.lines,
  pages: fallback.pages,
  pageText: fallback.pageText,
  /* Путь обязан начинаться со слеша: страницы живут на разной глубине
     (/product/…, /catalog/laser/kyocera), и относительная ссылка на них
     указала бы мимо. */
  brandLogos: Object.fromEntries(Object.entries(brandDict).map(([id, b]) => [id, b.logo ? '/' + b.logo.replace(/^\/+/, '') : null])),
  brandNames: Object.fromEntries(Object.entries(brandDict).map(([id, b]) => [id, b.name])),
});

const kb = (n) => (n / 1024).toFixed(1) + ' КБ';
console.log(`Каталог собран из источника «${SOURCE}»`);
console.log(`  товаров ${products.length}, категорий ${categories.length}, брендов ${brands.length}, моделей принтеров ${meta.compatibilityModels}`);
console.log(`  index.json ${kb(sizes.index)}, детали ${chunks.length} чанков ${kb(sizes.chunks)}, поиск ${kb(sizes.search)}`);
console.log(`  первая загрузка данных: ${kb(meta.bytes.firstLoad)}`);
