#!/usr/bin/env node
/*
  Аудит фотографий активного ассортимента.

  Отвечает на один вопрос, но по каждой позиции: увидит ли покупатель
  фотографию — и если нет, то почему именно. Причин ровно четыре, и
  путать их нельзя:

    нет у поставщика   в выгрузке пусто или dummy.jpg — показывать нечего;
    не скачано         адрес есть, локальной копии нет;
    скачано, не упаковано  копия есть, но в атлас превью не попала;
    показывается       ячейка атласа на месте, картинка видна.

  Почему «адрес есть» и «картинка видна» — разные вещи. Опубликованное
  превью живёт во фрейме со строгой политикой ресурсов: чужой хост в нём
  заблокирован целиком, и прямой адрес поставщика не сработает, каким бы
  верным он ни был. Единственный способ показать фотографию в превью —
  положить её внутрь публикации, в атлас. Поэтому «фото у поставщика
  есть» и «фото видно в превью» расходятся, и отчёт считает их отдельно.

  Запуск:
    node tools/audit-media.mjs                 отчёт в консоль
    node tools/audit-media.mjs --json=<файл>   полный отчёт файлом
    node tools/audit-media.mjs --todo=<файл>   список адресов к загрузке
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VttStore } from '../vtt/src/store.mjs';
import { publish, usablePhoto } from '../vtt/src/publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vtt/config.json'), 'utf8'));
const store = new VttStore(path.resolve(argOf('store', path.join(ROOT, 'vtt-data'))));
const { products } = publish(store, { filter: cfg.publishFilter });

/* Карта упакованных миниатюр. Ключ byVtt — Id поставщика: он переживает
   пересборку каталога, в отличие от адреса карточки. */
const thumbsFile = path.join(ROOT, 'data/catalog/thumbs.json');
const thumbs = fs.existsSync(thumbsFile) ? JSON.parse(fs.readFileSync(thumbsFile, 'utf8')) : { items: {}, byVtt: {} };
const byVtt = thumbs.byVtt ?? {};

/* Локальные копии из этапа картинок — их может не быть вовсе, если этап
   не запускали на этой машине. */
const manifestFile = path.join(ROOT, 'vtt-data/images/manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { items: {} };
const local = manifest.items ?? {};

const rows = [];
const counts = { всего: products.length, нетУПоставщика: 0, показывается: 0, скачаноНеУпаковано: 0, неСкачано: 0, битыйАдрес: 0 };
const errors = new Map();

for (const p of products) {
  const url = p.imagesOriginal?.[0] || p.images?.[0] || '';
  const rec = url ? local[url] || local[p.images?.[0]] : null;
  let state;
  if (p.photoMissing || !url) state = 'нетУПоставщика';
  else if (!usablePhoto(p.images?.[0])) { state = 'битыйАдрес'; }
  else if (byVtt[p.vttId]) state = 'показывается';
  else if (rec?.variants?.length) state = 'скачаноНеУпаковано';
  else state = 'неСкачано';
  counts[state] += 1;
  if (rec?.error) errors.set(rec.error, (errors.get(rec.error) ?? 0) + 1);
  rows.push({ vttId: p.vttId, id: p.id, code: p.code, state, url: p.images?.[0] ?? '' });
}

const pct = (n) => `${((n / products.length) * 100).toFixed(1)} %`;
console.log('Аудит фотографий активного ассортимента VTT');
console.log(`  товаров на витрине:            ${counts.всего}`);
console.log(`  фото есть у поставщика:        ${counts.всего - counts.нетУПоставщика - counts.битыйАдрес}`);
console.log(`  показывается в превью:         ${counts.показывается}  (${pct(counts.показывается)})`);
console.log(`  скачано, но не упаковано:      ${counts.скачаноНеУпаковано}`);
console.log(`  не скачано (нет локальной копии): ${counts.неСкачано}`);
console.log(`  фото нет у поставщика:         ${counts.нетУПоставщика}`);
console.log(`  адрес непригоден:              ${counts.битыйАдрес}`);
if (errors.size) {
  console.log('  ошибки загрузки:');
  for (const [msg, n] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${String(n).padStart(5)} ${msg}`);
}

/*
  Разбор одной позиции по шагам. Нужен ровно тогда, когда спрашивают «а
  почему вот у этого фото нет»: отчёт в числах на такой вопрос не
  отвечает, а догадки тут неуместны — причин у пропуска пять, и они на
  разных этапах.
*/
const trace = argOf('trace', null);
if (trace) {
  const all = store.loadAll();
  for (const id of trace.split(',').map((x) => x.trim()).filter(Boolean)) {
    const item = all.get(id);
    const p = products.find((x) => x.vttId === id);
    console.log(`\n── ${id} ──`);
    if (!item) { console.log('  в сторе поставщика такой позиции нет'); continue; }
    console.log(`  название:            ${item.name}`);
    console.log(`  1. поле выгрузки:    PhotoUrl = ${JSON.stringify(item.raw?.PhotoUrl ?? null)}`);
    console.log(`     PhotoUrls:        ${JSON.stringify(item.raw?.PhotoUrls ?? null)}`);
    console.log(`  2. после нормализации: ${JSON.stringify(item.photos ?? [])}`);
    console.log(`     исходный адрес:   ${JSON.stringify(item.photosOriginal ?? [])}`);
    console.log(`  3. адрес пригоден:   ${usablePhoto(item.photos?.[0]) ? 'да' : 'НЕТ'}`);
    console.log(`  4. на витрине:       ${p ? `да, ${p.id}` : 'НЕТ (отсеян фильтром публикации)'}`);
    const rec = local[item.photos?.[0]] || local[item.photosOriginal?.[0]];
    console.log(`  5. локальная копия:  ${rec?.variants?.length ? `есть, ${rec.variants.length} вариантов` : (rec?.error ? `ошибка: ${rec.error}` : 'НЕТ — этап картинок этот адрес не скачивал')}`);
    const cell = byVtt[id];
    console.log(`  6. ячейка атласа:    ${cell ? `есть, атлас ${cell[0]} (${cell[1]},${cell[2]})` : 'НЕТ'}`);
    console.log(`  ⇒ в превью:          ${cell ? 'фотография показывается' : (usablePhoto(item.photos?.[0]) ? 'заглушка «Фото не загрузилось»: адрес верный, но чужой хост во фрейме публикации заблокирован, а локальной копии нет' : 'заглушка: фотографии у поставщика нет')}`);
  }
}

const todoFile = argOf('todo', null);
if (todoFile) {
  /* Наряд на догрузку: ровно те адреса, которых не хватает витрине.
     Каждая строка — «Id поставщика<TAB>адрес», чтобы упаковщик мог
     разложить скачанное по позициям без повторного разбора каталога. */
  const todo = rows.filter((r) => r.state === 'неСкачано' || r.state === 'скачаноНеУпаковано');
  fs.writeFileSync(path.resolve(todoFile), todo.map((r) => `${r.vttId}\t${r.url}`).join('\n') + '\n');
  console.log(`\nНаряд на загрузку: ${todo.length} адресов → ${path.relative(ROOT, path.resolve(todoFile))}`);
}

const jsonFile = argOf('json', null);
if (jsonFile) {
  fs.writeFileSync(path.resolve(jsonFile), JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows }, null, 1));
  console.log(`Полный отчёт: ${path.relative(ROOT, path.resolve(jsonFile))}`);
}
