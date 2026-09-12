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
import { packIndex } from './index-pack.mjs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { contacts, legal, shop, messengers} from '../catalog-source/site.config.mjs';
import { colorKey, colorTitle, colorRank } from '../vtt/src/colors.mjs';
import { modelsFromName, parseSupplierNote } from '../vtt/src/publish.mjs';
import { seriesKey, famKey, FAM_MAX, FAM_MIN_SERIES, variantLabel } from '../vtt/src/family.mjs';
import { ItemRegistry, stableKey } from './item-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_CATALOG = path.join(ROOT, 'data/catalog');
const OUT_LIVE = path.join(ROOT, 'live');
const CHUNK_SIZE = 32; // товаров в одном файле деталей

const args = process.argv.slice(2);
/* Принимаем оба написания: «--source vtt» и «--source=vtt». Второе
   привычнее и раньше молча игнорировалось, собирая не тот источник. */
const argOf = (name, def) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
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

/*
  Отзывы.

  Их здесь больше нет, и это осознанное решение, а не упущение.

  Раньше в этом месте лежал список из десяти готовых текстов с именами,
  городами и датами, и сборка раздавала их товарам по хешу артикула. На
  витрине это выглядело как отзывы покупателей: имя, город, «покупка
  подтверждена», «отзыв полезен?». Ни одного из этих людей не
  существовало, дат таких не было, и опыта эксплуатации, о котором они
  рассказывали, тоже. Шесть карточек подряд показывали один и тот же
  текст с разной подписью — по этому совпадению всё и вскрылось.

  Придуманный отзыв от лица покупателя — это не «наполнение прототипа».
  Он влияет на решение о покупке, попадает в рейтинг, в микроразметку и
  в поисковую выдачу. Поэтому вместо генератора здесь пусто: настоящих
  отзывов у нас пока нет, и карточка так и говорит — «Пока нет отзывов».

  Откуда они появятся. Форма на карточке отправляет отзыв на модерацию
  (POST /api/review), сервер кладёт его в var/reviews со статусом
  pending. Опубликованным отзыв становится только после проверки
  человеком, и только тогда попадает в счётчики, в звёзды и в
  AggregateRating. VTT отзывов не отдаёт — источник только собственный.

  Поле reviewList остаётся в форме данных: как только появятся
  настоящие записи, их будет куда положить, и вёрстка их уже умеет
  показывать.
*/
/* --------------------------------------------------------------- сборка */

/*
  Источник «vtt»: каталог берётся из стора синхронизации (vtt-data), который
  наполняет vtt/bin/vtt-sync.mjs. Витрина и импорт разделены намеренно —
  сборка сайта не ходит в сеть и работает из готовых данных, поэтому её
  можно повторить в любой момент и получить тот же результат.

  Раздел витрины и бренд принтера считаются теми же функциями, что и для
  остальных источников: таксономия магазина одна, независимо от того,
  откуда пришёл товар. Дерево категорий поставщика при этом сохраняется
  рядом и не подменяется.
*/
async function readVttStore(storeRoot) {
  const { VttStore } = await import('../vtt/src/store.mjs');
  const { publish } = await import('../vtt/src/publish.mjs');
  const tax = await import('../vtt/src/shop-taxonomy.mjs');
  const store = new VttStore(storeRoot);
  if (!fs.existsSync(path.join(storeRoot, 'items'))) {
    throw new Error(
      `Стор VTT пуст: ${storeRoot}. Сначала выполните синхронизацию — ` +
      'node vtt/bin/vtt-sync.mjs full (или --mock для фикстур).',
    );
  }
  const state = store.loadState();
  const editorialFile = path.join(ROOT, 'catalog-source/vtt-editorial.json');
  const editorial = fs.existsSync(editorialFile) ? JSON.parse(fs.readFileSync(editorialFile, 'utf8')) : {};
  const cfgFile = path.join(ROOT, 'vtt/config.json');
  const filter = fs.existsSync(cfgFile) ? (JSON.parse(fs.readFileSync(cfgFile, 'utf8')).publishFilter ?? {}) : {};

  /*
    Манифест картинок, если этап загрузки уже отработал. Его нет — витрина
    показывает заглушку и говорит об этом прямо; выдумывать картинку
    нельзя, а ссылаться на чужой сервер по http — значит получить битую
    картинку у половины посетителей.
  */
  const manifestFile = path.join(storeRoot, 'images/manifest.json');
  let images = null;
  if (fs.existsSync(manifestFile)) {
    try {
      const { ImageManifest } = await import('../vtt/src/images.mjs');
      images = new ImageManifest(manifestFile);
    } catch (e) {
      console.log(`  манифест картинок не прочитан: ${e.message}`);
    }
  }

  const { products, report } = publish(store, {
    filter, editorial,
    categories: state.categories ?? [],
    /* Раздел и марка берутся из таблиц соответствия, а не из разбора
       названия: на реальном ассортименте угадывание по тексту сваливало
       бумагу и инструмент в лазерные картриджи, и увидеть это было
       нечем. Всё, чего нет в таблице, попадает в «Прочее» и в отчёт. */
    shopCat: (item) => tax.shopCategoryOf(item).id,
    shopBrand: (item) => tax.shopBrandOf(item).id,
  });

  /* Локальные варианты подставляются поверх исходных адресов: сам адрес
     поставщика остаётся в сторе и в карточке, чтобы этап картинок можно
     было переиграть, ничего не потеряв. */
  if (images) {
    const { srcsetOf, fallbackSrc } = await import('../vtt/src/images.mjs');
    let withLocal = 0;
    for (const p of products) {
      const source = (p.images ?? []).find((u) => images.get(u)?.variants?.length);
      if (!source) continue;
      const rec = images.get(source);
      p.imgOriginal = p.img;
      p.img = fallbackSrc(rec) || p.img;
      p.srcset = srcsetOf(rec);
      p.srcsetAvif = srcsetOf(rec, 'avif');
      p.imgW = rec.width; p.imgH = rec.height;
      p.photoMissing = false;
      withLocal += 1;
    }
    console.log(`  локальных картинок подставлено: ${withLocal} из ${products.length}`);
  }

  /* Сводка считается по тому, что реально попало на витрину, а не по
     всему стору: иначе отчёт обещал бы разделы, которых на сайте нет. */
  const publishedIds = new Set(products.map((p) => p.vttId));
  const taxonomy = tax.taxonomyReport(
    [...store.loadAll().values()].filter((i) => i.active !== false && publishedIds.has(i.id)),
  );
  console.log(`  импорт VTT: в сторе ${report.total}, опубликовано ${report.published}, ` +
    `скрыто ${report.inactive}, отсеяно фильтром ${report.filtered}`);
  console.log('  разделы витрины: ' + Object.entries(taxonomy.cats).map(([k, v]) => `${k} ${v}`).join(', '));
  if (report.filtered) {
    const byBrand = {};
    for (const i of store.loadAll().values()) {
      if (i.active === false || publishedIds.has(i.id)) continue;
      const b = (i.brand ?? '').trim() || '(Brand не заполнен)';
      byBrand[b] = (byBrand[b] ?? 0) + 1;
    }
    const top = Object.entries(byBrand).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  отсеяно фильтром марок: ${report.filtered} — ` + top.map(([b, n]) => `${b} ${n}`).join(', ') +
      (Object.keys(byBrand).length > 6 ? ` и ещё ${Object.keys(byBrand).length - 6} марок` : ''));
  }
  if (Object.keys(taxonomy.unknownRoots).length) {
    console.log('  РАЗДЕЛЫ ПОСТАВЩИКА БЕЗ СООТВЕТСТВИЯ: ' + JSON.stringify(taxonomy.unknownRoots));
  }
  if (Object.keys(taxonomy.unknownVendors).length) {
    console.log('  марки без соответствия: ' + Object.keys(taxonomy.unknownVendors).join(', ') + ' → универсальные');
  }
  if (report.missingRequired.length) {
    console.log(`  БЕЗ ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ: ${report.missingRequired.length} товаров (название, артикул или цена)`);
  }
  console.log(`  пробелы в данных: без фото ${report.noPhoto.length}, без описания ${report.noDescription.length}, ` +
    `без совместимости ${report.noCompatibility.length}, без цены ${report.noPrice.length}`);
  store.saveReport('last-publish', report);
  store.saveReport('last-taxonomy', taxonomy);

  return {
    products, vttCategories: state.categories ?? [], vttReport: report, taxonomy,
    importedCats: tax.IMPORTED_SHOP_CATS, importedBrandNames: tax.IMPORTED_BRAND_NAMES,
    cats: null, brands: null, laserBrands: null, lines: null, pages: null, pageText: null,
  };
}

const src = SOURCE === 'vtt'
  ? await readVttStore(argOf('store', path.join(ROOT, 'vtt-data')))
  : SOURCE === 'vtt-csv' ? readVttCsv(IN_FILE || path.join(ROOT, 'out/hiblack_catalog.csv')) : readDataJs();
const fallback = SOURCE === 'data-js' ? src : readDataJs();

/*
  Подмешивание импорта в существующий каталог: --with-vtt=<сколько>.

  Нужно для preview. Заменять витрину целиком выгрузкой нельзя, пока в
  сторе лежат фикстуры: владелец должен видеть свой настоящий магазин, а
  не синтетику вместо него. Поэтому товары импорта добавляются рядом и
  помечаются demo — метка идёт и в карточку, и в каталог, и в исключение
  из sitemap, чтобы их нельзя было принять за реальные позиции.

  На боевых данных флаг не нужен: там источником становится сам стор
  (--source=vtt), и никакой пометки demo у товаров не появляется.
*/
/*
  Реестр идентичности. Адрес карточки и «Код товара» выдаются из него и
  больше не зависят от того, какие товары попали в эту сборку.

  Товары прототипа занимают свои адреса первыми: они были в магазине до
  импорта, и их адреса — основа, вокруг которой разводятся совпадения.
*/
const REGISTRY_FILE = path.join(ROOT, 'data/item-registry.json');
const registry = ItemRegistry.load(REGISTRY_FILE);
const registryWas = registry.size;
for (const p of src.products) {
  const rec = registry.claim(stableKey(p), { preferredId: p.id, seed: p.id });
  p.id = rec.id;
  p.no = rec.no;
}

/* `--with-vtt=all` — весь ассортимент поставщика; число — ограничение для
   быстрой проверки сборки, чтобы не ждать девять с половиной тысяч
   карточек на каждой правке вёрстки. */
const WITH_VTT_RAW = String(argOf('with-vtt', 0));
const WITH_VTT = WITH_VTT_RAW === 'all' ? Infinity : (Number(WITH_VTT_RAW) || 0);
let imported = null;
if (WITH_VTT > 0 && SOURCE !== 'vtt') {
  imported = await readVttStore(argOf('store', path.join(ROOT, 'vtt-data')));
  /*
    Пометка ДЕМО снята. Импортированные позиции — не макет: это реальные
    товары из выгрузки поставщика, с настоящим артикулом, ценой и
    остатком, и показывать над ними плашку «проверочные данные» значит
    врать в другую сторону. Флаг остался только как ключ запуска: он
    нужен на синтетических данных (--mock), где товары действительно
    выдуманы.
  */
  const demoFlag = argOf('vtt-demo', '0') !== '0';
  let taken = 0, renamed = 0;
  for (const p of imported.products) {
    if (taken >= WITH_VTT) break;
    /*
      Адрес выдаёт реестр, а не текущий состав каталога.

      Артикул у VTT не уникален: один и тот же NameAlias встречается у
      позиций с чипом и без, в повреждённой упаковке и в целой. Раньше
      совпадение разводилось на месте — к идентификатору дописывался Id
      поставщика, — и адрес зависел от того, кто в этой сборке попался
      первым. Стоило убрать с витрины повреждённую упаковку, и 449
      нормальных товаров переехали на освободившиеся адреса.

      Теперь адрес принадлежит товару: реестр помнит, кому что выдано, и
      держит занятыми даже адреса ушедших позиций. Освободившийся адрес
      повреждённой упаковки не достанется никому.
    */
    const rec = registry.claim(stableKey({ ...p, source: 'vtt' }), {
      preferredId: p.id,
      seed: slugify(p.vttId || ''),
    });
    if (rec.id !== p.id) renamed += 1;
    src.products.push({ ...p, id: rec.id, no: rec.no, demo: demoFlag, source: 'vtt' });
    taken += 1;
  }
  src.vttCategories = imported.vttCategories;
  console.log(`  подмешано товаров импорта: ${taken}${demoFlag ? ' (помечены demo)' : ''}` +
    (renamed ? `, из них ${renamed} с уточнённым идентификатором из-за совпадения артикулов` : ''));
  if (taken < imported.products.length && WITH_VTT === Infinity) {
    console.log(`  ВНИМАНИЕ: перенесено ${taken} из ${imported.products.length}`);
  }
} // словари и тексты страниц берём из прототипа
const products = src.products;
const cats = src.cats || fallback.cats;
const brandDict = src.brands || fallback.brands;
const laserBrands = src.laserBrands || fallback.laserBrands;

/*
  Разделы и марки, которых в каталоге магазина не было.

  Ассортимент поставщика шире прототипа: там есть бумага, инструмент и
  печатающая техника, а среди марок — Lomond, Deli, RISO. Без записи в
  словаре такой товар попал бы в раздел, которого нет в навигации, и
  просто исчез бы с витрины: каталог рисуется по списку cats. Поэтому
  недостающие записи добавляются, а существующие не трогаются — у них
  свои тексты и картинки.
*/
const importedCats = src.importedCats ?? imported?.importedCats ?? [];
const importedBrandNames = src.importedBrandNames ?? imported?.importedBrandNames ?? {};
if (products.some((p) => p.source === 'vtt')) {
  const have = new Set(cats.map((c) => c.id));
  const used = new Set(products.map((p) => p.cat));
  for (const c of importedCats) if (!have.has(c.id) && used.has(c.id)) cats.push({ ...c, img: '' });
  for (const [id, name] of Object.entries(importedBrandNames)) {
    if (!brandDict[id] && products.some((p) => p.brand === id)) brandDict[id] = { name, logo: '' };
  }
}
const brandName = (id) => (brandDict[id] ? brandDict[id].name : id);

products.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name, 'ru'));

for (const p of products) {
  p.reviewList = [];
  p.reviews = 0;
  p.rate = 0;
}

/*
  Проверка описаний.

  Описание собирается из полей выгрузки, и у двух похожих позиций оно
  запросто может совпасть слово в слово — тогда на витрине появляется
  «та же фраза с подменённым артикулом», а это ровно то, чего в карточке
  быть не должно. Проверка идёт на каждой сборке, а не когда-нибудь
  руками: пустое описание и дословный дубль — это дефект данных, и
  увидеть его надо сразу, а не через полгода в выдаче.

  Сравнивается нормализованный текст (без регистра и лишних пробелов):
  пара, различающаяся только заглавной буквой, — такой же дубль.
*/
{
  const seen = new Map();
  const empty = [];
  for (const p of products) {
    if (p.source !== 'vtt') continue;
    const text = String(p.description ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) { empty.push(p.code || p.id); continue; }
    if (!seen.has(text)) seen.set(text, []);
    seen.get(text).push(p.code || p.id);
  }
  const dups = [...seen.values()].filter((v) => v.length > 1);
  const dupItems = dups.reduce((a, v) => a + v.length, 0);
  console.log(`  описания импортированных товаров: ${seen.size + empty.length}, ` +
    `уникальных ${seen.size}, пустых ${empty.length}, дословных дублей ${dupItems}`);
  if (empty.length) console.log(`    ПУСТЫЕ: ${empty.slice(0, 10).join(', ')}${empty.length > 10 ? ' и ещё ' + (empty.length - 10) : ''}`);
  for (const group of dups.slice(0, 5)) console.log(`    ДУБЛЬ: ${group.join(', ')}`);
  if (dups.length > 5) console.log(`    …и ещё ${dups.length - 5} групп дублей`);
}

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
/* `demo` и `src` едут в индексе, а не только в деталях: по ним витрина
   рисует пометку в списке, а сборщик страниц решает, что не индексировать
   и не класть в sitemap. Читать ради этого чанк деталей было бы дороже. */
/* `no` — «Код товара»: выдаётся реестром один раз и живёт с товаром.
   Раньше витрина считала его хешем от адреса при отрисовке, и вместе со
   сменой адреса менялся код — покупатель переставал находить товар по
   известному ему номеру. */
const FIELDS = ['id', 'slug', 'name', 'code', 'no', 'cat', 'brand', 'img', 'type', 'res', 'color', 'chip', 'badge', 'rate', 'reviews', 'fam', 'demo', 'src'];
const rows = products.map((p) => [
  p.id,
  uniqueSlug(p),
  p.name,
  p.code,
  p.no,
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
  null, // семейство по цвету, проставляется ниже
  p.demo ? 1 : 0,
  p.source || '',
]);
const rowOf = new Map(products.map((p, i) => [p.id, i]));

/*
  Карточка импортированного товара. Текст и характеристики берутся ровно из
  того, что прислал VTT: ни одного поля «по умолчанию», ни одной
  подставленной гарантии или сертификата. Пусто — значит пусто, и это видно
  в отчёте о неполных данных.
*/
function vttDescriptionHtml(p) {
  const parts = [];
  if (p.editorialDescription) parts.push(`<p>${esc(p.editorialDescription)}</p>`);
  if (p.description) parts.push(`<p>${esc(p.description)}</p>`);
  if (p.supplierDescription && p.supplierDescription !== p.description) {
    parts.push(`<p class="supplier-desc"><b>Описание поставщика.</b> ${esc(p.supplierDescription)}</p>`);
  }
  if (!parts.length) {
    parts.push('<p class="muted">Поставщик не передал описание для этой позиции. ' +
      'Характеристики ниже — всё, что есть по данным выгрузки.</p>');
  }
  return parts.join('');
}

function vttSpecs(p) {
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '' && v !== 0) rows.push([k, String(v)]); };
  const nf = (n) => Number(n).toLocaleString('ru-RU');
  const note = parseSupplierNote(p.compatText);

  add('Артикул', p.code);
  add('Оригинальный номер', p.originalNumber !== p.code ? p.originalNumber : '');
  add('Тип', p.type);
  add('Марка', p.supplierBrand);
  add('Для техники', p.compatibleBrand);
  /* Полный перечень моделей живёт здесь, а не в описании: у ролика он
     занимает триста знаков, и в тексте его читать невозможно. Строка
     поставщика приводится дословно — резать её на модели нельзя. */
  add('Совместимость по данным поставщика', note.compat);
  add('Особенности', note.notes.length || note.unknown.length
    ? [...note.notes, ...note.unknown].join(' ').replace(/\s+/g, ' ').trim() : '');
  add('Ресурс, страниц', p.res ? nf(p.res) : '');
  add('Объём, мл', p.volumeMl ? nf(p.volumeMl) : '');
  /* Строка поставщика показывается, только если из неё не вышло числа:
     иначе рядом с «6 000 страниц» стояло бы «6K» — то же самое дважды. */
  add('Ресурс по выгрузке', !p.res && !p.volumeMl ? p.lifeTime : '');
  add('Цвет', p.colorTitle || p.color);
  add('Штрихкод', p.barcode);
  add('В упаковке, шт.', p.inPackage > 1 ? nf(p.inPackage) : '');
  /* Вес штуки и вес упаковки — разные поля выгрузки (Gross* против
     Width/Height/Depth/Weight) и разные величины. Сливать их нельзя. */
  add('Вес одной штуки, кг', p.grossWeight ? nf(p.grossWeight) : '');
  add('Вес упаковки, кг', p.weight ? nf(p.weight) : '');
  /*
    Габариты без единицы измерения — и это не небрежность. В выгрузке
    есть Width/Height/Depth, но нигде не сказано, в чём они выражены, а
    сверка GrossVolume с произведением сторон сходится не у всех
    позиций. Подписать «см» под 0,38 × 0,45 × 0,57 значит заявить размер
    спичечного коробка для коробки с шестью картриджами.
  */
  const dims = (d) => (d && (d.width || d.height || d.depth)
    ? [d.width, d.height, d.depth].filter((v) => v !== undefined && v !== null).map(nf).join(' × ')
    : '');
  add('Габариты одной штуки (единицы в выгрузке не указаны)', dims(p.grossDimensions));
  add('Габариты упаковки (единицы в выгрузке не указаны)', dims(p.dimensions));
  add('Раздел поставщика', (p.catPath ?? []).join(' / ') || p.vttCategory);
  /*
    Складских количеств здесь нет.

    Раньше карточка публиковала «Доступно на складе, шт.: 500» и «На
    центральном складе, шт.: 500». Покупателю это не помогает выбрать, а
    магазину показывать свои остатки в штуках незачем — их видят и
    конкуренты, и они устаревают между выгрузками. Достаточно статуса
    «В наличии», который стоит рядом с ценой. Сами числа никуда не
    делись: они лежат в сторе поставщика и используются для расчётов,
    просто не публикуются.
  */
  return rows;
}

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
      /* У импортированного товара описание уже собрано из фактов VTT на
         этапе публикации — здесь его не переписываем, иначе потеряли бы
         единственный источник правды и начали бы додумывать. */
      desc: p.source === 'vtt' ? vttDescriptionHtml(p) : buildDescription(p, brandName(p.brand)),
      specs: p.source === 'vtt' ? vttSpecs(p) : buildSpecs(p, brandName(p.brand)),
      reviews: p.reviewList,
      ...(p.source ? { source: p.source } : {}),
      ...(p.demo ? { demo: true } : {}),
      /* Имя раздела — последний элемент пути, второй раз его хранить
         незачем: на 9 579 карточках это полмегабайта повтора. */
      ...(p.catPath?.length ? { vttCatPath: p.catPath } : (p.vttCategory ? { vttCatPath: [p.vttCategory] } : {})),
      ...(p.supplierDescription ? { supplierDesc: p.supplierDescription } : {}),
      ...(p.originalNumber ? { originalNumber: p.originalNumber } : {}),
      /* stockDetail в публикуемые детали не кладётся: точные остатки —
         внутренние данные. Наличие витрина берёт из live-файла флагом. */
    };
  }
  chunks.push(part);
}

/* Комплекты по цветам: правила склейки серий живут в vtt/src/family.mjs. */
const famBuckets = new Map();
products.forEach((p, i) => {
  if (!p.color) return;
  if (seriesKey(p).length < FAM_MIN_SERIES) return;
  const key = famKey(p);
  if (!famBuckets.has(key)) famBuckets.set(key, []);
  famBuckets.get(key).push(i);
});
const families = {};
/*
  В этом срезе каталога у части серий не хватает цвета: жёлтого в выгрузке
  просто нет, хотя магазин им торгует. Достраиваем комплект существующими
  товарами по артикулу — выдуманных артикулов быть не должно. Переключатель
  цвета ведёт на настоящую карточку с её ценой, наличием и списком принтеров.
*/
const COLOR_FILL = [
  { seed: 'HB-T1291', add: ['HB-T1714'] },
  { seed: 'HB-T1713', add: ['HB-T1291', 'HB-T1292'] },
  { seed: 'Чернила Hi-Black для HP OfficeJet Pro 6000/ 7000/ 8000, Пигментные, Black, 0,1 л.', add: ['Чернила Hi-Black Универсальные для HP (Тип H), Yellow, 0,1 л.'] },
];
const byCode = new Map();
products.forEach((p, i) => { if (p.code && !byCode.has(p.code)) byCode.set(p.code, i); });

/*
  Заголовок серии. У товаров прототипа есть разобранный список принтеров —
  берём его. У импортированных его нет вовсе, и единственный источник —
  название поставщика: из него вынимается та же часть «для …», что и в
  описании, тем же осторожным разбором. Если и она не читается, остаётся
  само название с отрезанным цветом — но не с вычеркнутым каждым словом,
  иначе «Hi-Black» превращается в «Hi».
*/
function famLabel(p) {
  if (p.compat) return p.type + ' ' + brandName(p.brand) + ' для ' + p.compat.replace(/^для\s+/, '');
  /* Разбор названия — только для импортированных товаров. У прототипа
     `brand` означает марку принтера, а не изготовителя расходника, и по
     этой ветке заголовок вышел бы «Чернила Brother для Brother». */
  const models = p.source === 'vtt' ? modelsFromName(p.name) : '';
  if (models && p.type) return `${p.type} ${p.supplierBrand || ''} для ${models}`.replace(/\s{2,}/g, ' ');
  return String(p.name || '')
    .replace(/,\s*(black|cyan|magenta|yellow|light\s+\w+|photo\s+\w+|ч[её]рн\w*|голуб\w*|пурпурн\w*|ж[её]лт\w*)\s*(?=,|$)/i, '')
    .trim();
}

/*
  Название серии для заголовка блока цветов: «Серия TK-8115».

  Берётся не из головы, а из самих артикулов — общим началом. У
  HB-TK-8115BK / HB-TK-8115C / HB-TK-8115M / HB-TK-8115Y это «HB-TK-8115»,
  и после отсечения марки остаётся «TK-8115». Общее начало обрезается по
  границе разделителя: «HB-TK-811» — не серия, а обрубок.

  Если общего начала не нашлось (у цветов серии бывают совсем разные
  артикулы, как у HP CF410A/411A/412A), подписи серии просто не будет.
*/
function seriesName(codes) {
  if (codes.length < 2) return '';
  let prefix = codes[0];
  for (const c of codes.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < c.length && prefix[i].toUpperCase() === c[i].toUpperCase()) i += 1;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[^0-9A-Za-zА-Яа-я]+$/, '');
  prefix = prefix.replace(/^(?:HB|N|HiBl|CN)[-\s]+/i, '');
  return prefix.length >= 3 && /\d/.test(prefix) ? prefix : '';
}

let famSkippedBig = 0;
[...famBuckets.entries()]
  .filter(([, list]) => {
    /* Считаем по русским названиям, а не по кодам: «Bk» и «BK» — один и
       тот же чёрный, и семейством из двух цветов это не делает. */
    if (new Set(list.map((i) => colorKey(products[i].color))).size < 2) return false;
    if (list.length > FAM_MAX) { famSkippedBig += 1; return false; }
    return true;
  })
  .sort((a, b) => a[0].localeCompare(b[0]))
  .forEach(([, own]) => {
    const fill = COLOR_FILL.find((f) => own.some((i) => products[i].code === f.seed));
    const seen = new Set(own.map((i) => colorKey(products[i].color)));
    const list = own.slice();
    if (fill) {
      for (const code of fill.add) {
        const i = byCode.get(code);
        if (i == null || list.includes(i) || seen.has(colorKey(products[i].color))) continue;
        seen.add(colorKey(products[i].color));
        list.push(i);
      }
    }
    const first = products[own[0]];
    const id = 'set-' + slugify(first.code || first.id).replace(/[a-z]$/i, '') + '-' + list.length;
    const sorted = list.slice().sort((a, b) => {
      const d = colorRank(products[a].color) - colorRank(products[b].color);
      /* При равном цвете — по ресурсу: младший вариант первым, как их и
         перечисляют в документации на аппарат. */
      return d !== 0 ? d : (products[a].res ?? 0) - (products[b].res ?? 0);
    });
    const counts = {};
    for (const i of sorted) { const k = colorKey(products[i].color); counts[k] = (counts[k] ?? 0) + 1; }
    /* Две позиции одного цвета и одного объёма встречаются: у VTT это два
       артикула на один и тот же товар. Подпись должна их различать, иначе
       в переключателе две одинаковые кнопки — а различает их артикул. */
    const labels = sorted.map((i) => variantLabel(products[i], counts[colorKey(products[i].color)] > 1));
    const seenLabel = {};
    for (const l of labels) seenLabel[l] = (seenLabel[l] ?? 0) + 1;
    const finalLabels = labels.map((l, n) => (seenLabel[l] > 1 ? `${l} · ${products[sorted[n]].code}` : l));
    families[id] = {
      /* Без списка принтеров (универсальные чернила) заголовок берём из
         названия, убрав из него только сам цвет, а не каждое слово-цвет:
         иначе «Hi-Black» превращается в «Hi». */
      label: famLabel(first),
      colors: finalLabels,
      series: seriesName(sorted.map((i) => products[i].code || '')),
      rows: sorted,
    };
    /* Заимствованный товар остаётся в своей серии: его карточка показывает
       свой комплект, а не чужой. */
    for (const i of own) rows[i][FIELDS.indexOf('fam')] = id;
  });
console.log(`  цветовых серий: ${Object.keys(families).length}, в них товаров ` +
  `${Object.values(families).reduce((a, f) => a + f.rows.length, 0)}` +
  (famSkippedBig ? `, отброшено слишком широких групп: ${famSkippedBig}` : ''));

/* Поисковый индекс: токен → номера строк. Клиент ищет по началу слова. */
const searchIndex = {};
products.forEach((p, i) => {
  /* «Код товара» ищется наравне с артикулом: покупатель, которому его
     назвали по телефону, вводит в поиск именно его. */
  const text = [p.name, p.code, p.no, p.model, p.compat, brandName(p.brand), p.type, p.color].join(' ').toLowerCase();
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

/*
  Каталог пересобирается начисто, но карта атласов — не его выход. Её
  собирает отдельный этап (tools/pack-thumbs.mjs) из скачанных картинок,
  а лежит она здесь же. Стереть её вместе с каталогом значит потерять все
  фотографии: файлы атласов останутся на диске, а указателя на ячейки не
  будет — и витрина молча покажет заглушки. Поэтому карта переживает
  пересборку.
*/
const THUMBS_FILE = path.join(OUT_CATALOG, 'thumbs.json');
const keptThumbs = fs.existsSync(THUMBS_FILE) ? JSON.parse(fs.readFileSync(THUMBS_FILE, 'utf8')) : null;
fs.rmSync(OUT_CATALOG, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_CATALOG, 'chunks'), { recursive: true });
fs.mkdirSync(OUT_LIVE, { recursive: true });

const write = (file, data) => {
  const p = path.join(ROOT, file);
  fs.writeFileSync(p, JSON.stringify(data));
  return fs.statSync(p).size;
};

const sizes = {};
/* Сжатие индекса живёт в отдельном модуле: тем же кодом его разбирает
   предрендер, и формат проверяется тестом на круговой обход. */
sizes.index = write('data/catalog/index.json', packIndex(FIELDS, rows));

/*
  Карта атласов возвращается на место и заново привязывается к
  идентификаторам этой сборки.

  Привязка обязательна. Идентификатор витрины не вечен: при совпадении
  артикулов сборщик дописывает к нему хвост, и какие товары столкнутся —
  зависит от состава витрины. Сменился фильтр — сменилась часть
  идентификаторов, и карта, ключёванная ими, начала бы указывать в
  пустоту. Устойчив только Id поставщика, поэтому карта хранит и его.
*/
if (keptThumbs) {
  const byVtt = keptThumbs.byVtt ?? null;
  const items = {};
  let found = 0;
  for (const p of products) {
    const cell = byVtt ? byVtt[p.vttId] : keptThumbs.items?.[p.id];
    if (cell) { items[p.id] = cell; found += 1; }
  }
  const kept = { ...keptThumbs, version: 2, items, byVtt: byVtt ?? undefined };
  sizes.thumbs = write('data/catalog/thumbs.json', kept);
  console.log(`  миниатюр из атласов: ${found} на ${products.filter((p) => p.source === 'vtt').length} импортированных товаров`);
}
sizes.categories = write('data/catalog/categories.json', categories);
sizes.brands = write('data/catalog/brands.json', brands);
sizes.compatibility = write('data/catalog/compatibility.json', compatibility);
sizes.search = write('data/catalog/search-index.json', searchIndex);
sizes.featured = write('data/catalog/featured.json', featured);
sizes.families = write('data/catalog/families.json', families);
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
  families: Object.keys(families).length,
  chunkSize: CHUNK_SIZE,
  chunks: chunks.length,
  inStock: products.filter((p) => p.stock).length,
  fields: FIELDS,
  bytes: { ...sizes, firstLoad: sizes.index + sizes.categories + sizes.brands + sizes.live },
};
/* Отметка о карте атласов: по ней витрина решает, запрашивать ли её. */
if (keptThumbs) meta.thumbs = true;
/*
  Таблица названий цветов едет вместе с каталогом, а не дублируется в
  скрипте витрины. Источник один — vtt/src/colors.mjs, и расходиться
  двум копиям негде. В индексе при этом остаётся код поставщика: по нему
  работает фильтр, и по нему покупатель сверяется с надписью на
  картридже.
*/
meta.colorTitles = Object.fromEntries(
  [...new Set(products.map((p) => p.color).filter(Boolean))].map((c) => [c, colorTitle(c)]),
);
write('data/catalog/meta.json', meta);

/*
  Реестр сохраняется после сборки — вместе с адресами и номерами, которые
  выдались впервые. Файл коммитится: это не кэш, а история выданного.
  Потерять его значит перенумеровать магазин.
*/
registry.save(REGISTRY_FILE);
console.log(`  реестр идентификаторов: ${registry.size} записей` +
  (registry.issued ? `, выдано новых ${registry.issued}` : ', новых не выдавалось') +
  ` (было ${registryWas})`);

/*
  Заглушки в текстах страниц заменяются настоящими контактами: адрес и телефон
  прописаны в одном месте (catalog-source/site.config.mjs), а не размазаны по
  десятку текстов.
*/
const SUBST = [
  [/\[адрес самовывоза\]/gi, contacts.address],
  [/\[Адрес склада и самовывоза в Москве\]/gi, contacts.address],
  [/\[email для заказов\]/gi, contacts.email],
  [/\[Юридическое лицо, ИНН, ОГРН\]/gi, `${legal.fullName}, ИНН ${legal.inn}, ОГРН ${legal.ogrn}`],
  [/\[Юридическое лицо, ОГРН\]/gi, `${legal.fullName}, ОГРН ${legal.ogrn}`],
  [/\+7 \(495\) 000-00-00/g, contacts.phone],
];
const pageText = Object.fromEntries(
  Object.entries(fallback.pageText).map(([k, v]) => [k, SUBST.reduce((t, [re, to]) => t.replace(re, to), v)])
);

/* Страницы контактов и реквизитов собираются из настроек целиком. */
const row = (l, v) => `<div class="krow"><span>${l}</span><b>${v}</b></div>`;
const DELIV = { msk: 500, out: 1000, outKm: 5, perKm: 50, timed: 1600, hours: '09:00–18:00' };
const sellerLine = `${legal.fullName}, ИНН ${legal.inn}, ОГРН ${legal.ogrn}`;
const h3 = (t) => `<h3>${t}</h3>`;
const ul = (items) => `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`;
const ol = (items) => `<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`;
const pp = (...t) => t.map((x) => `<p>${x}</p>`).join('');
const money = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const svg = (d) => `<svg class="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
/*
  Адрес MAX попадает в сборку только если он настоящий: подтверждён флагом и
  прошёл проверку формы. Иначе в site.json уходит url: null — заглушка не может
  оказаться ни в данных, ни в DOM, ни стать кликабельной ссылкой.
*/
const maxPublic = (() => {
  const m = messengers.max;
  const url = typeof m.url === 'string' ? m.url.trim() : '';
  const looksReal = /^https:\/\/max\.ru\/\S+$/i.test(url)
    && !/replace|placeholder|example|todo|username|<|>/i.test(url);
  const active = m.confirmed === true && looksReal;
  return {
    name: m.name, label: m.label, note: m.note, pending: m.pending,
    /* Официальный знак MAX лежит отдельным файлом и подключается картинкой:
       внутри у него 154 градиента, 16 фильтров и маска со своими id, и при
       вставке прямо в разметку эти id столкнулись бы между четырьмя точками.
       У <img> собственная область имён, знак грузится один раз и остаётся
       байт-в-байт официальным. */
    icon: '/assets/img/max-icon.svg',
    active, url: active ? url : null,
  };
})();



const ICO = {
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  pin: svg('<path d="M12 21s-6-5.7-6-11a6 6 0 0 1 12 0c0 5.3-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>'),
};
pageText.contacts =
  `<p class="lead">Ответим на вопросы по наличию, совместимости и доставке, поможем подобрать расходник по модели принтера и выставим счёт организации.</p>` +
  `<div class="ccards">` +
  `<div class="ccard"><span class="cico">${ICO.phone}</span><div class="ct">Телефон</div>` +
  `<b><a href="tel:${contacts.phone.replace(/[^0-9+]/g, '')}">${contacts.phone}</a></b>` +
  `<span>${contacts.officeHours}</span></div>` +
  `<div class="ccard"><span class="cico">${ICO.mail}</span><div class="ct">Электронная почта</div>` +
  `<b><a href="mailto:${contacts.email}">${contacts.email}</a></b>` +
  `<span>Отвечаем в рабочее время</span></div>` +
  `<div class="ccard"><span class="cico">${ICO.clock}</span><div class="ct">Режим работы</div>` +
  `<b>${contacts.officeHours}</b><span>Заказы на сайте принимаются круглосуточно</span></div>` +
  /* MAX — такой же полноценный канал, как телефон и почта. Адрес приходит из
     одной константы messengers.max и в разметке не дублируется. */
  /* Знак стоит без подложки: у официального вектора своя заливка, и чёрный
     квадрат под ним спорил бы с градиентом. */
  `<div class="ccard ccard-max"><img class="maxico maxico-lg" src="${maxPublic.icon}" alt="" width="42" height="42">` +
  `<div class="ct">Мессенджер</div>` +
  (maxPublic.active
    ? `<b><a class="maxlink" href="${maxPublic.url}" target="_blank" rel="noopener noreferrer"` +
      ` aria-label="Написать нам в мессенджере MAX, откроется в новой вкладке">Написать в MAX</a></b>` +
      `<span>${maxPublic.note}</span>`
    /* Адреса ещё нет: блок виден для согласования дизайна, но ссылкой не
       притворяется — это span без href и без навигации. */
    : `<b><span class="maxlink is-off" aria-disabled="true">Написать в MAX</span></b>` +
      `<span class="maxnote">${maxPublic.pending}</span>`) +
  `</div>` +
  /* Закрываем саму сетку карточек. Без этого `</div>` браузер оставлял
     .ccards открытой до конца страницы, и заголовок «Фирменный магазин»,
     блок склада, форма и подсказки становились ячейками той же сетки —
     на десктопе страница контактов разъезжалась по трём колонкам. */
  `</div>` +
  h3('Фирменный магазин и склад') +
  `<div class="cshop"><div>` +
  pp(`${contacts.address}, метро ${contacts.metro}.`,
     `Самовывоз — <b>по предварительному согласованию</b>. Часы выдачи: ${contacts.pickupHours.replace(/,?\s*по предварительному согласованию/i, '')}. Прежде чем приехать, дождитесь подтверждения менеджера, что заказ собран.`) +
  `</div><div class="map-ph">${ICO.pin}<span>Карта будет добавлена позже</span></div></div>` +
  h3('Написать нам') +
  `<form class="cform" id="contact-form" novalidate>` +
  `<div class="row2">` +
  `<label class="fld"><span>Имя</span><input type="text" name="name" autocomplete="name" placeholder="Как к вам обращаться" required></label>` +
  `<label class="fld"><span>Электронная почта</span><input type="email" name="email" autocomplete="email" placeholder="mail@example.com" required></label>` +
  `</div><div class="row2">` +
  `<label class="fld"><span>Телефон <i>— необязательно</i></span><input type="tel" name="phone" autocomplete="tel" inputmode="tel" placeholder="+7 (___) ___-__-__"></label>` +
  `<label class="fld"><span>Тема обращения</span><select name="topic">` +
  ['Подбор расходника', 'Наличие и сроки', 'Заказ и доставка', 'Счёт для организации', 'Гарантия и возврат', 'Другое']
    .map((t) => `<option>${t}</option>`).join('') +
  `</select></label></div>` +
  `<label class="fld"><span>Сообщение</span><textarea name="message" rows="4" placeholder="Модель принтера, код картриджа или суть вопроса" required></textarea></label>` +
  `<label class="agree"><input type="checkbox" name="agree-pd"><span>Я даю <a href="/help/pdconsent">согласие на обработку персональных данных</a> и ознакомлен(а) с <a href="/help/privacy">Политикой конфиденциальности</a></span></label>` +
  `<button class="btn btn-y btn-lg" type="submit">Отправить обращение</button>` +
  `</form>` +
  h3('Не знаете, что подойдёт') +
  `<div class="chelp"><p>Назовите модель принтера или код картриджа — покажем, что подходит, с ценой и наличием.</p>` +
  `<div class="acts"><a class="btn btn-y" href="/finder">Подобрать по принтеру</a>` +
  `<a class="btn btn-o" href="/help/compat">Таблицы совместимости</a></div></div>` +
  h3('Реквизиты продавца') +
  `<div class="keyspecs">` +
  row('Полное наименование', legal.fullName) + row('Юридический адрес', legal.legalAddress) +
  row('ИНН', legal.inn) + row('КПП', legal.kpp) + row('ОГРН', legal.ogrn) +
  row('Банк', legal.bankName) + row('Расчётный счёт', legal.settlementAccount) +
  row('Корреспондентский счёт', legal.correspondentAccount) + row('БИК', legal.bik) + row('ОКПО', legal.okpo) +
  `</div>`;

pageText.business = `<p>Работаем с организациями и индивидуальными предпринимателями: счёт формируется при оформлении заказа и приходит на почту, закрывающие документы отдаём вместе с товаром или отправляем по ЭДО.</p>` +
  `<h3>Как оформить заказ по счёту</h3><ul><li>Соберите корзину и на шаге оформления выберите «Юридическое лицо».</li><li>Укажите ИНН — остальные реквизиты подставятся автоматически.</li><li>Счёт придёт на указанную почту в течение рабочего дня.</li><li>После оплаты отгружаем со склада ${contacts.city || 'в Москве'} и передаём документы.</li></ul>` +
  `<h3>Реквизиты продавца</h3><div class="keyspecs">` +
  row('Полное наименование', legal.fullName) + row('Юридический адрес', legal.legalAddress) +
  row('ИНН', legal.inn) + row('КПП', legal.kpp) + row('ОГРН', legal.ogrn) +
  row('Банк', legal.bankName) + row('Расчётный счёт', legal.settlementAccount) +
  row('Корреспондентский счёт', legal.correspondentAccount) + row('БИК', legal.bik) + row('ОКПО', legal.okpo) +
  `</div>`;

/*
  Юридические и информационные страницы собираются из настроек: реквизиты,
  телефон, почта и адрес встречаются в них десятки раз, и держать их копиями
  в тексте — верный способ разойтись с действительностью. Структура разделов
  повторяет рабочий магазин, тексты адаптированы под Hi-Black и текущего
  продавца. Служебные пометки вида «подтвердить до публикации» в интерфейс не
  переносятся: покупателю они ничего не говорят.
*/

pageText.privacy =
  pp(`Политика описывает, как ${legal.fullName} обрабатывает и защищает персональные данные пользователей магазина ${shop.shopName}.`) +
  h3('Оператор персональных данных') +
  pp(`Оператором персональных данных является ${sellerLine}, юридический адрес: ${legal.legalAddress}.`,
     `Обращения по вопросам обработки данных принимаются по телефону ${contacts.phone} и на адрес ${contacts.email}.`) +
  h3('Термины') +
  ul(['Сайт — интернет-магазин Hi-Black.', `Продавец, оператор — ${legal.fullName}.`,
      'Пользователь — лицо, использующее сайт.', 'Покупатель — пользователь, оформивший заказ.']) +
  h3('Общие положения') +
  pp('Политика применяется ко всем данным, которые оператор получает через сайт при оформлении и исполнении заказа, обращении в поддержку и заказе обратного звонка.',
     'Оператор обрабатывает данные на основании закона, договора с покупателем и согласия пользователя.') +
  h3('Какие данные обрабатываются') +
  ul(['Контактные данные из формы заказа: имя, телефон, адрес электронной почты',
      'Адрес доставки', 'Реквизиты организации при оформлении заказа на юридическое лицо',
      'Содержание обращений и история взаимодействия с магазином',
      'Технические данные, необходимые для работы и безопасности сайта: IP-адрес, данные браузера, cookie сессии']) +
  h3('Цели обработки') +
  ul(['Оформление и исполнение заказа', 'Связь с покупателем по вопросам заказа',
      'Выставление документов при заказе на организацию',
      'Ответы на обращения и предотвращение злоупотреблений']) +
  h3('Обработка, хранение и защита') +
  pp('Оператор вправе собирать, систематизировать, хранить, уточнять, использовать, блокировать и удалять данные автоматизированным и неавтоматизированным способом в объёме, необходимом для указанных целей.',
     'Данные хранятся не дольше, чем этого требуют цели обработки и обязательные сроки хранения документов. После достижения цели данные удаляются либо обезличиваются, если иное не установлено законом.',
     'Для работы корзины и защиты форм используются необходимые cookie и локальное хранилище браузера — подробнее в <a href="/help/cookies">Политике использования файлов cookie</a>.',
     'Оператор применяет разграничение доступа, защищённое соединение и иные организационные и технические меры защиты.') +
  h3('Передача третьим лицам') +
  pp('Данные передаются только исполнителям, без которых невозможно выполнить выбранную услугу: перевозчику — для доставки, почтовому сервису — для служебных писем. Передаётся только необходимый объём.',
     'Оператор не продаёт персональные данные и не выполняет трансграничную передачу.') +
  h3('Права пользователя') +
  ul(['Получить сведения об обработке своих данных', 'Потребовать уточнения или удаления данных',
      'Отозвать согласие на обработку',
      `Направить требование можно на ${contacts.email}. Для идентификации заявителя оператор может запросить сведения, подтверждающие связь с данными.`]) +
  `<p class="muted small">См. также: <a href="/help/pdconsent">Согласие на обработку персональных данных</a>.</p>`;

pageText.pdconsent =
  pp('Отдельное согласие пользователя на действия с данными, необходимыми для выбранного обращения или операции.') +
  h3('Кому и на что даётся согласие') +
  pp(`Пользователь свободно, своей волей и в своём интересе даёт ${sellerLine} согласие на обработку данных, введённых в соответствующую форму сайта.`,
     'Согласие является конкретным для действия, рядом с которым установлена отметка: оформление заказа, заказ обратного звонка или обращение через форму связи.') +
  h3('Перечень данных') +
  ul(['Имя', 'Телефон', 'Адрес электронной почты', 'Адрес доставки — при оформлении заказа',
      'Реквизиты организации — при оформлении заказа на юридическое лицо', 'Текст обращения']) +
  h3('Перечень действий с данными') +
  pp('Сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, передача исполнителям в объёме, необходимом для выполнения заказа, блокирование, удаление и уничтожение. Обработка ведётся автоматизированным и неавтоматизированным способом.') +
  h3('Срок действия и отзыв') +
  pp('Согласие действует до достижения цели обработки или до его отзыва.',
     `Отозвать согласие можно письменно на ${contacts.email} либо по адресу ${legal.legalAddress}. Отзыв не распространяется на данные, которые оператор обязан хранить по закону.`) +
  `<p class="muted small">См. также: <a href="/help/privacy">Политика конфиденциальности</a>.</p>`;

pageText.terms =
  pp('Условия использования сайта и оформления заказов.') +
  h3('Стороны и термины') +
  ul(['Сайт — интернет-магазин Hi-Black.', `Продавец — ${sellerLine}.`,
      'Пользователь — лицо, использующее сайт.', 'Покупатель — пользователь, оформивший заказ.']) +
  h3('Предмет соглашения') +
  pp(`Соглашение определяет условия использования сайта и порядок взаимодействия между ${legal.fullName} и пользователем.`) +
  h3('Информация о товарах') +
  pp('Цена и наличие фиксируются при оформлении заказа. Заказ считается принятым после присвоения номера; менеджер вправе связаться с покупателем для уточнения доставки и характеристик.',
     'Изображение может незначительно отличаться от конкретной партии без изменения существенных характеристик.',
     'Указание кода расходного материала производителя техники в карточке совместимого товара служит для обозначения совместимости и не означает принадлежности товара правообладателю кода.') +
  h3('Оформление заказа') +
  pp('Оформляя заказ, пользователь подтверждает достоверность данных, принимает настоящие условия и отдельно выражает согласие на обработку персональных данных.',
     'Доступны оплата при получении и оплата по счёту.',
     'Доставка выполняется выбранным при оформлении способом. Стоимость и срок показываются до подтверждения заказа либо согласовываются менеджером.') +
  h3('Заключительные положения') +
  pp(`${legal.fullName} вправе изменять условия соглашения. Актуальная редакция публикуется на этой странице.`) +
  `<p class="muted small">См. также: <a href="/help/offer">Публичная оферта</a>, <a href="/help/privacy">Политика конфиденциальности</a>.</p>`;

pageText.offer =
  pp(`Настоящий документ является публичной офертой ${sellerLine} — предложением заключить договор розничной купли-продажи на условиях, изложенных ниже.`) +
  h3('Предмет договора') +
  pp('Продавец обязуется передать покупателю расходные материалы для печатающей техники, а покупатель — принять и оплатить их.',
     'Оформление заказа на сайте означает акцепт оферты: договор считается заключённым с момента присвоения заказу номера.') +
  h3('Цена и оплата') +
  pp('Цена указывается в карточке товара и фиксируется при оформлении заказа. Доступны оплата при получении и оплата по счёту для физических и юридических лиц.',
     `Порядок оплаты описан на странице <a href="/help/payment">Оплата</a>.`) +
  h3('Доставка и передача товара') +
  pp(`Способы, стоимость и порядок доставки описаны на странице <a href="/help/delivery">Доставка</a>. Право собственности и риск случайной гибели переходят к покупателю в момент передачи товара.`) +
  h3('Возврат и гарантия') +
  pp(`Гарантийные обязательства и порядок возврата описаны на странице <a href="/help/warranty">Гарантия и возврат</a> и определяются Законом РФ «О защите прав потребителей».`) +
  h3('Реквизиты продавца') +
  ul([`${legal.fullName}`, `ИНН ${legal.inn}, КПП ${legal.kpp}, ОГРН ${legal.ogrn}`,
      `Юридический адрес: ${legal.legalAddress}`,
      `Телефон: ${contacts.phone}`, `Электронная почта: ${contacts.email}`]);

pageText.cookies =
  pp('Документ описывает, какие файлы cookie использует магазин и зачем.') +
  h3('Что такое cookie') +
  pp('Cookie — небольшие текстовые файлы, которые сайт сохраняет в браузере. Они позволяют запомнить состояние страницы между переходами: например, содержимое корзины.') +
  h3('Какие cookie использует магазин') +
  ul(['Технические — работа корзины, избранного и сравнения, сохранение выбранных фильтров',
      'Сессионные — защита форм и корректная передача заказа на сервер',
      'Локальное хранилище браузера — состояние корзины между визитами и отметка о том, что уведомление о cookie уже показано']) +
  pp('Магазин не использует cookie систем веб-аналитики, рекламных сетей и сторонних трекеров.') +
  h3('Управление cookie') +
  pp('Отключить или удалить cookie можно в настройках браузера. Без технических cookie корзина и оформление заказа работать не будут.') +
  `<p class="muted small">См. также: <a href="/help/privacy">Политика конфиденциальности</a>.</p>`;

pageText.delivery =
  pp('Заказы по Москве и области развозит курьер магазина. По остальной России заказ доставляется в выбранный покупателем пункт выдачи СДЭК.') +
  h3('Москва в пределах МКАД') +
  pp(`Курьер магазина — ${money(DELIV.msk)}. Доставка до подъезда, стандартный интервал ${DELIV.hours}. Дату и интервал подтверждает менеджер.`) +
  h3('Москва за пределами МКАД') +
  pp(`${money(DELIV.out)} за первые ${DELIV.outKm} км от МКАД, далее ${money(DELIV.perKm)} за километр. Расстояние и итоговую стоимость подтверждает менеджер.`) +
  h3('Доставка к определённому времени') +
  pp(`В пределах МКАД — ${money(DELIV.timed)} вместо стандартного тарифа. Время согласовывается с менеджером.`) +
  h3('Россия — СДЭК') +
  pp('Покупатель выбирает населённый пункт и удобный пункт выдачи или постамат. Заказ можно получить только в выбранной точке перевозчика. Стоимость рассчитывается по тарифам СДЭК и подтверждается менеджером.') +
  h3('Самовывоз') +
  pp(`Со склада по адресу ${contacts.address} — по предварительному согласованию. Прежде чем приехать, дождитесь подтверждения менеджера, что заказ собран.`) +
  h3('Упаковка') +
  pp('Расходные материалы отправляются в заводской упаковке, дополнительно защищённой транспортной упаковкой.') +
  `<p class="muted small">Условия, дату и время доставки подтверждает менеджер. Способы оплаты — на странице <a href="/help/payment">Оплата</a>.</p>`;

pageText.payment =
  pp('Оплатить заказ можно при получении или по счёту.') +
  h3('При получении') +
  pp('Курьеру магазина — наличными или картой. Для доставки СДЭК возможность оплаты при получении подтверждает менеджер.') +
  h3('По счёту') +
  pp(`Счёт выставляет ${legal.fullName} — как физическим, так и юридическим лицам. Для организаций счёт формируется при оформлении заказа и приходит на указанную почту, закрывающие документы передаются вместе с товаром или по ЭДО.`,
     `Условия для организаций — на странице <a href="/help/business">Юрлицам</a>.`) +
  h3('Онлайн-оплата') +
  pp('Оплата картой на сайте и через СБП появится после подключения платёжного провайдера. До этого момента доступны оплата при получении и оплата по счёту.') +
  h3('Документы') +
  pp('К заказу прилагаются документы, подтверждающие покупку. Они же понадобятся при обращении по гарантии и возврату.');

pageText.warranty =
  pp('Условия гарантии на расходные материалы, порядок обращения и правила возврата.') +
  h3('Срок гарантии') +
  pp('Гарантийный срок указывается в карточке товара и в документах на заказ. Единый срок для всего ассортимента не устанавливается: он зависит от типа расходного материала.',
     'Гарантия распространяется на случаи, когда расходный материал не печатает, печатает с дефектами по вине изготовления или не распознаётся устройством при подтверждённой совместимости.') +
  h3('Что считается гарантийным случаем') +
  ul(['Картридж не распознаётся устройством из списка совместимости',
      'Печать с полосами, пятнами или пропусками с первых страниц',
      'Утечка тонера или чернил из корпуса',
      'Комплектность не соответствует описанию в карточке товара']) +
  h3('Когда гарантия не действует') +
  ul(['Механические повреждения корпуса после получения заказа',
      'Следы самостоятельной разборки, перезаправки или замены чипа',
      'Установка в устройство, которого нет в списке совместимости',
      'Естественный износ после выработки заявленного ресурса']) +
  h3('Порядок обращения') +
  ol([`Позвоните по телефону ${contacts.phone} или напишите на ${contacts.email}, указав номер заказа и артикул товара.`,
      'Опишите проблему и приложите фотографию тестовой страницы, если дефект виден на печати.',
      'Продавец подтверждает гарантийный случай и согласует замену или возврат.',
      'Товар передаётся курьеру или привозится по адресу магазина в оригинальной упаковке.']) +
  h3('Возврат товара надлежащего качества') +
  pp('Товар можно вернуть, если он не был в употреблении, сохранены товарный вид, потребительские свойства, пломбы и заводская упаковка, а также документ, подтверждающий покупку.',
     'Расходные материалы со вскрытой герметичной упаковкой возврату не подлежат, если упаковка была необходима для сохранности товара.') +
  h3('Возврат товара ненадлежащего качества') +
  pp('При обнаружении недостатка покупатель вправе потребовать замены товара либо возврата уплаченной суммы в порядке и в сроки, установленные законодательством о защите прав потребителей.',
     'Возврат денежных средств выполняется тем же способом, которым была произведена оплата.') +
  h3('Как обратиться') +
  ul([`По телефону: ${contacts.phone}`, `По электронной почте: ${contacts.email}`, `По адресу магазина: ${contacts.address}`]) +
  h3('Правовая основа') +
  pp('Условия определяются Законом РФ «О защите прав потребителей» и Правилами продажи товаров по договору розничной купли-продажи.',
     `Продавцом по договору выступает ${legal.fullName}.`);

/* Словари и тексты страниц, которые не относятся к товарам. */
write('data/site.json', {
  contacts,
  legal,
  shop,
  messengers: { max: maxPublic },
  laserBrands,
  lines: fallback.lines,
  pages: fallback.pages,
  pageText,
  /* Путь обязан начинаться со слеша: страницы живут на разной глубине
     (/product/…, /catalog/laser/kyocera), и относительная ссылка на них
     указала бы мимо. */
  brandLogos: Object.fromEntries(Object.entries(brandDict).map(([id, b]) => [id, b.logo ? '/' + b.logo.replace(/^\/+/, '') : null])),
  brandNames: Object.fromEntries(Object.entries(brandDict).map(([id, b]) => [id, b.name])),
});

const kb = (n) => (n / 1024).toFixed(1) + ' КБ';
if (!maxPublic.active) {
  console.warn('');
  console.warn('  MAX: адрес не задан — блоки собраны в неактивном виде.');
  console.warn('  В site.json уходит url: null, ссылок с заглушкой в сборке нет.');
  console.warn('  Чтобы включить канал: catalog-source/site.config.mjs, messengers.max —');
  console.warn('  url: \'https://max.ru/<аккаунт>\' и confirmed: true.');
  console.warn('');
}
console.log(`Каталог собран из источника «${SOURCE}»`);
console.log(`  товаров ${products.length}, категорий ${categories.length}, брендов ${brands.length}, моделей принтеров ${meta.compatibilityModels}`);
console.log(`  index.json ${kb(sizes.index)}, детали ${chunks.length} чанков ${kb(sizes.chunks)}, поиск ${kb(sizes.search)}`);
console.log(`  первая загрузка данных: ${kb(meta.bytes.firstLoad)}`);
