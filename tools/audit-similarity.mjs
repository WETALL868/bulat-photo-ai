#!/usr/bin/env node
/*
  Аудит близких дублей в описаниях.

  Зачем отдельно от tools/audit-descriptions.mjs. Тот считает уникальность
  по полному тексту — и показывает 4 278 уникальных на 4 278 карточек,
  хотя чёрный и пурпурный картриджи одной серии различаются только цветом,
  артикулом, ресурсом и штрихкодом. Хеш целого текста такую шаблонность не
  видит: подставь другое число — и текст «уникален».

  Метод. В два шага, и оба грубые намеренно: чем грубее маска, тем
  заметнее шаблон.

  1. Нормализация «гнёзд». Из текста вычёркивается всё, что меняется от
     позиции к позиции, а на его место встаёт метка:
        артикул            → ⟨арт⟩
        любое число        → ⟨N⟩
        слово-цвет         → ⟨цвет⟩
        марка техники      → ⟨марка⟩
        обозначение модели → ⟨модель⟩
     Остаётся скелет фразы. Два текста с одинаковым скелетом — это один
     шаблон с подменёнными значениями, сколько бы хешей они ни давали.

  2. Доля общей набивки. Текст режется на предложения, каждое
     нормализуется, и считается, у скольких ещё товаров встречается такое
     же предложение. Предложение, попавшее больше чем к сотне позиций,
     считается набивкой. Доля набивки — это сколько знаков описания
     занято фразами, которые покупатель уже читал на других карточках.

  Ни первое, ни второе не лечится синонимами: подменять слова, чтобы
  обмануть собственную метрику, — это ровно то же враньё, только дороже.
  Лечится это фактами, которых у позиции больше, чем у соседа.

  Запуск:
    node tools/audit-similarity.mjs
    node tools/audit-similarity.mjs --examples=3   примеры кластеров
    node tools/audit-similarity.mjs --json=<файл>
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VttStore } from '../vtt/src/store.mjs';
import { publish } from '../vtt/src/publish.mjs';

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

const BRANDS = /\b(hp|canon|epson|kyocera(?:-mita)?|brother|samsung|xerox|ricoh|oki|lexmark|panasonic|sharp|toshiba|konica(?:\s+minolta)?|pantum|deli|minolta)\b/gi;
const COLORS = /(^|[^0-9\p{L}])(ч[её]рн\p{L}*|голуб\p{L}*|пурпурн\p{L}*|ж[её]лт\p{L}*|светло-\p{L}+|фото-\p{L}+|матов\p{L}*|сер\p{L}*|красн\p{L}*|бел\p{L}*|бесцветн\p{L}*|цветн\p{L}*|многоцветн\p{L}*|тр[её]хцветн\p{L}*|четыр[её]хцветн\p{L}*)/giu;
/* Обозначение модели: латиница с цифрами, возможно через дробь. */
const MODELS = /\b[A-Za-z]{1,6}[- ]?\d{2,5}[A-Za-z0-9/–-]*/g;

export function skeleton(text, code) {
  let t = String(text ?? '');
  if (code) t = t.split(code).join('⟨арт⟩');
  t = t.replace(BRANDS, '⟨марка⟩');
  t = t.replace(MODELS, '⟨модель⟩');
  t = t.replace(COLORS, '$1⟨цвет⟩');
  t = t.replace(/\d[\d \s.,]*/g, '⟨N⟩');
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

const splitSentences = (text) => String(text ?? '')
  .split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.trim()).filter((s) => s.length > 12);

/* ------------------------------------------------ 1. кластеры скелетов */
const clusters = new Map();
for (const p of products) {
  const key = skeleton(p.description, p.code);
  if (!clusters.has(key)) clusters.set(key, []);
  clusters.get(key).push(p);
}
const sized = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
const inCluster = sized.filter(([, v]) => v.length > 1).reduce((a, [, v]) => a + v.length, 0);

/* --------------------------------------------- 2. доля общей набивки */
const sentenceUse = new Map();
const perProduct = new Map();
for (const p of products) {
  const list = splitSentences(p.description).map((s) => ({ raw: s, key: skeleton(s, p.code) }));
  perProduct.set(p.id, list);
  for (const { key } of new Set(list.map((x) => x.key)).values ? [...new Map(list.map((x) => [x.key, x])).values()] : list) {
    sentenceUse.set(key, (sentenceUse.get(key) ?? 0) + 1);
  }
}
const BOILER_AT = Math.max(50, Math.round(products.length * 0.02));
const shares = [];
for (const p of products) {
  const list = perProduct.get(p.id) ?? [];
  const total = list.reduce((a, x) => a + x.raw.length, 0) || 1;
  const boiler = list.filter((x) => (sentenceUse.get(x.key) ?? 0) >= BOILER_AT).reduce((a, x) => a + x.raw.length, 0);
  shares.push({ p, share: boiler / total });
}
shares.sort((a, b) => a.share - b.share);
const avg = shares.reduce((a, x) => a + x.share, 0) / (shares.length || 1);
const pctOf = (n) => `${((n / products.length) * 100).toFixed(1)} %`;

console.log('Аудит близких дублей');
console.log(`  активных карточек:                     ${products.length}`);
console.log(`  разных скелетов (текст без значений):  ${clusters.size}`);
console.log(`  карточек внутри кластеров > 1:         ${inCluster}  (${pctOf(inCluster)})`);
console.log(`  крупнейший кластер:                    ${sized[0]?.[1].length ?? 0} карточек`);
console.log(`  кластеров от 10 карточек:              ${sized.filter(([, v]) => v.length >= 10).length}`);
console.log(`\n  порог набивки: фраза встречается у ${BOILER_AT}+ товаров`);
console.log(`  средняя доля набивки в описании:       ${(avg * 100).toFixed(1)} %`);
for (const edge of [0.2, 0.4, 0.6, 0.8]) {
  console.log(`  карточек с набивкой выше ${(edge * 100).toFixed(0)} %:          ${shares.filter((x) => x.share > edge).length}`);
}

const topSentences = [...sentenceUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('\n  Самые повторяющиеся фразы:');
for (const [key, n] of topSentences) console.log(`    ${String(n).padStart(5)}×  ${key.slice(0, 96)}`);

const examples = Number(argOf('examples', 0));
if (examples) {
  console.log(`\n=== Типичные кластеры (по одному из разных разделов) ===`);
  const seenType = new Set();
  let shown = 0;
  for (const [, group] of sized) {
    if (shown >= examples || group.length < 2) break;
    const t = group[0].type;
    if (seenType.has(t)) continue;
    seenType.add(t); shown += 1;
    console.log(`\n── ${group.length} карточек · ${t}`);
    for (const p of group.slice(0, 2)) console.log(`   ${p.code}: ${p.description.split('\n\n')[0].slice(0, 150)}`);
  }
}

const jsonFile = argOf('json', null);
if (jsonFile) {
  fs.writeFileSync(path.resolve(jsonFile), JSON.stringify({
    generatedAt: new Date().toISOString(), products: products.length,
    skeletons: clusters.size, inCluster, largestCluster: sized[0]?.[1].length ?? 0,
    boilerplateThreshold: BOILER_AT, averageBoilerplateShare: avg,
    topSentences: topSentences.map(([k, n]) => ({ uses: n, skeleton: k })),
    clusters: sized.filter(([, v]) => v.length > 1).slice(0, 200)
      .map(([k, v]) => ({ size: v.length, type: v[0].type, skeleton: k.slice(0, 200), codes: v.slice(0, 5).map((p) => p.code) })),
  }, null, 1));
  console.log(`\nПолный отчёт: ${path.relative(ROOT, path.resolve(jsonFile))}`);
}
