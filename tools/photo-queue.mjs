#!/usr/bin/env node
/*
  Очередь на докачку дополнительных снимков.

  Поставщик объявляет у части позиций несколько фотографий: основной
  снимок лежит по адресу «<Id>.jpg», остальные — «<Id>_2.jpg», «<Id>_3.jpg»
  и дальше. Основные к нам перенесены (assets/img/vtt-full, 3 339 файлов),
  дополнительных нет ни одного: b2b.vtt.ru из облачной среды закрыт —
  прокси отвечает «CONNECT tunnel failed, response 403» и на http, и на
  https. Проверено прямым запросом, а не предположением.

  Поэтому здесь не скачивание, а подготовка к нему: список ровно тех
  адресов, которые нужны, привязка каждого к товару и готовый скрипт,
  который выполняется там, где доступ к b2b.vtt.ru есть. После него
  останется дописать реестр — команда для этого тоже печатается.

  Важно: очередь строится только по позициям, которые есть на витрине.
  Качать снимки к 5 943 отфильтрованным товарам незачем.

    node tools/photo-queue.mjs [--out=vtt-data/reports] [--limit=0]
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const OUT = path.join(ROOT, argOf('out', 'data'));
const LIMIT = Number(argOf('limit', 0)) || Infinity;

const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
const F = Object.fromEntries(idx.fields.map((k, i) => [k, i]));
const DICT = idx.dicts || {};
const val = (row, f) => ((idx.dictFields || []).includes(f) ? DICT[f]?.[row[F[f]]] : row[F[f]]);
const shopByCode = new Map();
for (const row of idx.rows) {
  const code = String(val(row, 'code') || '').trim();
  if (code) shopByCode.set(code.toUpperCase(), { id: row[F.id], name: val(row, 'name'), no: val(row, 'no') });
}

const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vtt-photos.json'), 'utf8'));
const have = reg.photos || {};

const store = {};
const dir = path.join(ROOT, 'vtt-data/items');
for (const f of fs.readdirSync(dir)) Object.assign(store, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const queue = [];
let extraTotal = 0;
for (const it of Object.values(store)) {
  const code = String(it.vendorCode || '').trim().toUpperCase();
  const shop = code ? shopByCode.get(code) : null;
  /* Товара нет на витрине — снимок ему не нужен. */
  if (!shop) continue;
  const photos = (it.photos || []).filter((u) => u && !/dummy\.jpg/i.test(u));
  if (photos.length < 2) continue;
  const missing = photos.slice(1)
    .map((u) => ({ url: String(u), file: String(u).split('/').pop() }))
    .filter((x) => !have[x.file]);
  if (!missing.length) continue;
  extraTotal += missing.length;
  queue.push({
    shopId: shop.id, code: it.vendorCode, no: shop.no, vttId: it.id,
    name: String(it.name || '').slice(0, 110),
    main: photos[0], extra: missing,
  });
  if (queue.length >= LIMIT) break;
}

fs.mkdirSync(OUT, { recursive: true });
const jsonFile = path.join(OUT, 'photo-queue.json');
fs.writeFileSync(jsonFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'Дополнительные снимки поставщика, которых нет в проекте. Скачивать там, где открыт b2b.vtt.ru.',
  products: queue.length, files: extraTotal, items: queue,
}, null, 1));

/* Скрипт намеренно простой и читаемый: его будет запускать человек на
   своей машине, и он должен видеть, что именно выполняется. */
const sh = [
  '#!/bin/sh',
  '# Докачка дополнительных снимков Hi-Black.',
  '# Запускать там, где открыт b2b.vtt.ru (в облачной среде он закрыт прокси).',
  '# После выполнения: node tools/photo-queue.mjs --register',
  'set -e',
  'DST=assets/img/vtt-full-new',
  'mkdir -p "$DST"',
  `echo "Файлов к загрузке: ${extraTotal} у ${queue.length} товаров"`,
  '',
  ...queue.flatMap((q) => q.extra.map((e) =>
    `curl -fsS --retry 3 -o "$DST/${e.file}" "${e.url}" && echo "ok ${e.file}" || echo "НЕ СКАЧАЛСЯ ${e.file} (${q.code})"`)),
  '',
  'echo "Готово. Дальше: перекодировать в webp и дописать data/vtt-photos.json —"',
  'echo "  node tools/photo-queue.mjs --register --from=$DST"',
].join('\n');
const shFile = path.join(OUT, 'photo-queue.sh');
fs.writeFileSync(shFile, sh + '\n');
fs.chmodSync(shFile, 0o755);

/*
  Второй режим: файлы уже скачаны — перекодировать и вписать в реестр.
  Реестр ведётся вручную, и дописывание сюда — единственное исключение,
  сделанное осознанно: руками вносить тысячи строк невозможно.
*/
if (process.argv.includes('--register')) {
  const from = path.join(ROOT, argOf('from', 'assets/img/vtt-full-new'));
  if (!fs.existsSync(from)) {
    console.error(`каталог со скачанными файлами не найден: ${path.relative(ROOT, from)}`);
    process.exit(1);
  }
  const sharp = (await import('sharp')).default;
  const crypto = await import('node:crypto');
  const dst = path.join(ROOT, String(reg.dir || 'assets/img/vtt-full'));
  let added = 0;
  for (const f of fs.readdirSync(from)) {
    if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
    if (have[f]) continue;
    const buf = fs.readFileSync(path.join(from, f));
    const webp = await sharp(buf).webp({ quality: 82 }).toBuffer();
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24) + '.webp';
    fs.writeFileSync(path.join(dst, name), webp);
    have[f] = name;
    added += 1;
  }
  reg.photos = Object.fromEntries(Object.entries(have).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(ROOT, 'data/vtt-photos.json'), JSON.stringify(reg, null, 1));
  console.log(`вписано в реестр: ${added}. Дальше: npm run catalog && npm run seo`);
  process.exit(0);
}

console.log(`товаров с необкачанными кадрами: ${queue.length}`);
console.log(`файлов к загрузке: ${extraTotal}`);
console.log(`  список: ${path.relative(ROOT, jsonFile)}`);
console.log(`  скрипт: ${path.relative(ROOT, shFile)}`);
console.log('');
console.log('b2b.vtt.ru из этой среды закрыт: прокси отвечает 403 на CONNECT.');
console.log('Скрипт выполняется там, где доступ есть, затем:');
console.log('  node tools/photo-queue.mjs --register --from=assets/img/vtt-full-new');
console.log('  npm run catalog && npm run seo');
