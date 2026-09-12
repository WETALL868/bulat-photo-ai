#!/usr/bin/env node
/*
  Аудит описаний активного ассортимента.

  Проверяет три вещи, которые ломаются молча: длину, уникальность и
  происхождение. Длина сама по себе ничего не стоит — добить любой текст до
  пятисот знаков можно общими словами, — поэтому рядом считается,
  сколько текстов различаются по нормализованному виду и из каких полей
  каждый собран. Одинаковая длина при одинаковом тексте означает шаблон с
  подменённым артикулом, а не описание.

  Короткие описания не прячутся: они выписываются отдельным списком с
  причиной — каких именно фактов не хватило. Дописать их можно только
  данными, а не словами.

  Запуск:
    node tools/audit-descriptions.mjs
    node tools/audit-descriptions.mjs --sample=12     выборка по категориям
    node tools/audit-descriptions.mjs --json=<файл>   полный отчёт
    node tools/audit-descriptions.mjs --short=<файл>  список коротких
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VttStore } from '../vtt/src/store.mjs';
import { publish, DESCRIPTION_MIN } from '../vtt/src/publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vtt/config.json'), 'utf8'));
let { products } = publish(new VttStore(path.join(ROOT, 'vtt-data')), { filter: cfg.publishFilter });

/*
  Проверяется опубликованный текст, а не то, что вернул стор. У товаров из
  цветных серий описание дописывается составом набора уже в сборщике
  каталога — аудит, читающий стор напрямую, этой правки не видел бы и
  мерил бы не то, что увидит покупатель.
*/
const snapshotFile = path.join(ROOT, 'vtt-data/reports/published-descriptions.json');
if (fs.existsSync(snapshotFile)) {
  const snap = new Map(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).map((r) => [r.vttId, r]));
  products = products.map((p) => {
    const r = snap.get(p.vttId);
    return r ? { ...p, description: r.text, descriptionBasedOn: r.basedOn } : p;
  });
  console.log(`(текст взят из последней сборки каталога: ${snap.size} позиций)\n`);
} else {
  console.log('(каталог не собран — текст взят из стора; соберите npm run catalog)\n');
}

const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const byText = new Map();
const empty = [];
const short = [];
for (const p of products) {
  const text = p.description ?? '';
  if (!text.trim()) { empty.push(p); continue; }
  const key = norm(text);
  if (!byText.has(key)) byText.set(key, []);
  byText.get(key).push(p);
  if (text.length < DESCRIPTION_MIN) short.push(p);
}
const dups = [...byText.values()].filter((v) => v.length > 1);

/* Причина краткости — это перечень фактов, которых у позиции нет. */
const reasonOf = (p) => {
  const miss = [];
  if (!p.compat && !p.compatText) miss.push('нет перечня совместимости');
  if (!p.res && !p.volumeMl && !p.lifeTime) miss.push('нет ресурса или объёма');
  if (!p.compatText) miss.push('нет пометок поставщика');
  if (!(p.inPackage > 1)) miss.push('нет количества в упаковке');
  if (!p.originalNumber || p.originalNumber === p.code) miss.push('нет отдельного оригинального номера');
  if (!p.barcode) miss.push('нет штрихкода');
  return miss.join('; ') || 'фактов хватает, но все они короткие';
};

const lens = products.map((p) => (p.description ?? '').length).sort((a, b) => a - b);
const pct = (n) => `${((n / products.length) * 100).toFixed(1)} %`;
console.log('Аудит описаний активного ассортимента');
console.log(`  активных карточек:             ${products.length}`);
console.log(`  описаний от ${DESCRIPTION_MIN} знаков:       ${products.length - short.length - empty.length}  (${pct(products.length - short.length - empty.length)})`);
console.log(`  короче ${DESCRIPTION_MIN} знаков:            ${short.length}`);
console.log(`  пустых:                        ${empty.length}`);
console.log(`  уникальных текстов:            ${byText.size}`);
console.log(`  групп дословных дублей:        ${dups.length}`);
console.log(`  длина: мин ${lens[0]}, медиана ${lens[Math.floor(lens.length / 2)]}, макс ${lens[lens.length - 1]}`);

if (short.length) {
  const byType = {};
  for (const p of short) byType[p.type || '—'] = (byType[p.type || '—'] ?? 0) + 1;
  console.log('\n  Короткие описания по типам (дописать их можно только данными, не словами):');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${t}`);
  console.log('  Примеры с причиной:');
  for (const p of short.slice(0, 5)) console.log(`    ${p.code} (${p.description.length} зн.) — ${reasonOf(p)}`);
}
for (const group of dups.slice(0, 5)) console.log(`  ДУБЛЬ: ${group.map((p) => p.code).join(', ')}`);

/* Выборка для ручной проверки: по одному товару из разных разделов плюс
   те, что назвал заказчик. */
const sampleSize = Number(argOf('sample', 0));
if (sampleSize) {
  const must = ['HB-TK-8115BK', 'HB-TK-8115M'];
  const picked = [];
  const seenType = new Set();
  for (const code of must) {
    const p = products.find((x) => x.code === code);
    if (p) { picked.push(p); seenType.add(p.type); }
  }
  for (const p of products) {
    if (picked.length >= sampleSize) break;
    if (seenType.has(p.type)) continue;
    seenType.add(p.type); picked.push(p);
  }
  console.log(`\n=== Выборка ${picked.length} товаров из разных разделов ===`);
  for (const p of picked) {
    console.log(`\n── ${p.code} · ${p.type} · ${p.description.length} зн. · из полей: ${p.descriptionBasedOn.join(', ')}`);
    console.log(p.description.split('\n\n').map((x) => `   ${x}`).join('\n\n'));
  }
}

const shortFile = argOf('short', null);
if (shortFile) {
  fs.writeFileSync(path.resolve(shortFile),
    short.map((p) => `${p.code}\t${p.description.length}\t${p.type}\t${reasonOf(p)}`).join('\n') + '\n');
  console.log(`\nСписок коротких: ${short.length} → ${path.relative(ROOT, path.resolve(shortFile))}`);
}
const jsonFile = argOf('json', null);
if (jsonFile) {
  fs.writeFileSync(path.resolve(jsonFile), JSON.stringify({
    generatedAt: new Date().toISOString(), min: DESCRIPTION_MIN, total: products.length,
    long: products.length - short.length - empty.length, short: short.length, empty: empty.length,
    unique: byText.size, duplicateGroups: dups.length,
    shortList: short.map((p) => ({ code: p.code, id: p.id, type: p.type, length: p.description.length, reason: reasonOf(p) })),
  }, null, 1));
  console.log(`Полный отчёт: ${path.relative(ROOT, path.resolve(jsonFile))}`);
}
