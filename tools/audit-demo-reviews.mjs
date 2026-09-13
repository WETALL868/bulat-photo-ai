#!/usr/bin/env node
/*
  Измеримый аудит повторов в демо-отзывах превью.

  Утверждение «все тексты уникальны» само по себе ничего не стоит: один
  шаблон с подставленным артикулом тоже даёт уникальные строки. Поэтому
  считаем три разные вещи:

    1. Разброс количества. Сколько карточек получили единицы, десятки,
       сотни и тысячу — иначе «диапазон 1..1000» может оказаться одним
       числом на весь каталог.
    2. Повторы внутри карточки. У самых «многоотзывных» позиций
       генерируем ВСЕ записи и считаем различные тексты. Здесь обещана
       полная уникальность по построению — проверяем, что так и есть.
    3. Похожесть между карточками. Берём первые записи каждого товара,
       сводим к скелету (числа, артикулы, марки и цвета маскируются) и
       смотрим, сколько карточек делят скелет. Отдельно — цветовые
       варианты одной серии: у них общий словарь, и честное число
       совпадений важнее красивого.

  Генератор живёт в браузере, поэтому и аудит идёт в браузере — тем же
  кодом, что работает на витрине.

  Запуск: node tools/audit-demo-reviews.mjs [--port=8097] [--full=20] [--first=12]
*/
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const PORT = Number(arg('port', 8097));
const FULL = Number(arg('full', 20));
const FIRST = Number(arg('first', 12));
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { /* уже закрыт */ } };
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/product/hb-tk-8115bk`, { waitUntil: 'networkidle' });
await page.waitForSelector('#ptabs', { timeout: 15000 });

const out = await page.evaluate(async ({ full, first }) => {
  window.HB_DEMO_REVIEWS = 3;
  const C = window.HBCatalog, count = window.HB_DEMO_COUNT, gen = window.HB_DEMO_REVIEWS_FOR;
  const items = C.all();

  /* Скелет: маскируем всё, что и так обязано различаться, — числа,
     артикулы, марки, цвета. Остаётся форма фразы. */
  const skeleton = (t) => String(t)
    .replace(/\d[\d\s  ]*/g, '⟨n⟩')
    .replace(/\b[A-Za-z][A-Za-z0-9-]{2,}\b/g, '⟨lat⟩')
    .replace(/(чёрн|голуб|пурпурн|жёлт|син|красн|зелён|сер)\w*/gi, '⟨цвет⟩')
    .replace(/\s+/g, ' ').trim().toLowerCase();

  const hist = { '1': 0, '2–9': 0, '10–99': 0, '100–999': 0, '1000': 0 };
  const counts = [];
  const skelOf = new Map();      /* скелет → сколько карточек его делят */
  const firstTexts = new Map();  /* текст → сколько карточек его делят */
  let withDemo = 0;

  for (const p of items) {
    const n = count(p);
    counts.push(n);
    if (!n) continue;
    withDemo += 1;
    hist[n === 1 ? '1' : n < 10 ? '2–9' : n < 100 ? '10–99' : n < 1000 ? '100–999' : '1000'] += 1;
    const d = await C.detail(p.id);
    for (const r of gen(p, d, 0, first)) {
      const s = skeleton(r.text);
      skelOf.set(s, (skelOf.get(s) || 0) + 1);
      firstTexts.set(r.text, (firstTexts.get(r.text) || 0) + 1);
    }
  }

  /* Полная проверка уникальности на самых крупных карточках. */
  const top = items.slice().sort((a, b) => count(b) - count(a)).slice(0, full);
  const inside = [];
  for (const p of top) {
    const n = count(p);
    const d = await C.detail(p.id);
    const texts = gen(p, d, 0, n).map((r) => r.text);
    inside.push({ code: p.code, n: n, uniq: new Set(texts).size });
  }

  /* Цветовые варианты: у них общий словарь — самый жёсткий случай. */
  const fams = new Map();
  for (const p of items) if (p.fam) { if (!fams.has(p.fam)) fams.set(p.fam, []); fams.get(p.fam).push(p); }
  const colorPairs = [];
  let pairChecked = 0, pairShared = 0, pairTotal = 0;
  for (const [key, mem] of fams) {
    if (mem.length < 2 || colorPairs.length >= 200) continue;
    const sets = [];
    for (const p of mem) {
      const d = await C.detail(p.id);
      sets.push({ code: p.code, texts: new Set(gen(p, d, 0, 20).map((r) => r.text)) });
    }
    for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
      let shared = 0;
      for (const t of sets[a].texts) if (sets[b].texts.has(t)) shared += 1;
      pairChecked += 1; pairShared += shared; pairTotal += Math.min(sets[a].texts.size, sets[b].texts.size);
      if (shared && colorPairs.length < 5) colorPairs.push(`${sets[a].code} ↔ ${sets[b].code}: ${shared} общих из 20`);
    }
    void key;
  }

  const skels = [...skelOf.values()];
  const texts = [...firstTexts.values()];
  return {
    total: items.length, withDemo,
    hist, min: Math.min(...counts.filter(Boolean)), max: Math.max(...counts),
    sum: counts.reduce((a, b) => a + b, 0),
    median: counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)],
    firstChecked: texts.reduce((a, b) => a + b, 0),
    firstDistinct: texts.length,
    firstRepeatMax: Math.max(...texts),
    skelDistinct: skels.length,
    skelMax: Math.max(...skels),
    skelInClusters: skels.filter((n) => n > 1).reduce((a, b) => a + b, 0),
    inside, pairChecked, pairShared, pairTotal, colorPairs,
  };
}, { full: FULL, first: FIRST });

const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + ' %' : '—');
console.log(`\nАудит демо-отзывов превью\n`);
console.log(`  товаров в каталоге:                    ${out.total}`);
console.log(`  из них с демо-отзывами:                ${out.withDemo}`);
console.log(`  всего демо-отзывов по каталогу:        ${out.sum.toLocaleString('ru-RU')}`);
console.log(`  на карточку: минимум ${out.min}, медиана ${out.median}, максимум ${out.max}`);
console.log('\n  Разброс количества по карточкам:');
for (const [k, v] of Object.entries(out.hist)) console.log(`    ${k.padEnd(9)} ${String(v).padStart(5)}  (${pct(v, out.withDemo)})`);

console.log(`\n  Повторы ВНУТРИ карточки (полная генерация, ${out.inside.length} самых крупных):`);
const bad = out.inside.filter((x) => x.uniq !== x.n);
console.log(`    проверено записей: ${out.inside.reduce((a, x) => a + x.n, 0).toLocaleString('ru-RU')}`);
console.log(`    карточек с повтором текста: ${bad.length}` + (bad.length ? ' — ' + bad.map((x) => `${x.code} ${x.uniq}/${x.n}`).join(', ') : ''));

console.log(`\n  Похожесть МЕЖДУ карточками (первые ${FIRST} записей каждой):`);
console.log(`    текстов проверено:                   ${out.firstChecked.toLocaleString('ru-RU')}`);
console.log(`    различных текстов:                   ${out.firstDistinct.toLocaleString('ru-RU')}  (${pct(out.firstDistinct, out.firstChecked)})`);
console.log(`    самый частый текст встречается у:    ${out.firstRepeatMax} карточек`);
console.log(`    различных скелетов фразы:            ${out.skelDistinct.toLocaleString('ru-RU')}`);
console.log(`    записей в кластерах скелета > 1:     ${out.skelInClusters.toLocaleString('ru-RU')}  (${pct(out.skelInClusters, out.firstChecked)})`);
console.log(`    крупнейший кластер скелета:          ${out.skelMax}`);

console.log(`\n  Цветовые варианты одной серии (по 20 первых записей на позицию):`);
console.log(`    пар сравнено:                        ${out.pairChecked}`);
console.log(`    совпавших текстов в парах:           ${out.pairShared} из ${out.pairTotal}  (${pct(out.pairShared, out.pairTotal)})`);
for (const s of out.colorPairs) console.log(`      ${s}`);

await browser.close();
stop();
