#!/usr/bin/env node
/*
  Аудит марки производителя по всей выгрузке поставщика.

  Зачем. На витрине магазина собственных марок не должно быть чужого
  ассортимента. Поле, по которому это решается, — Brand (Producer,
  Manufacturer): кто товар произвёл. Его легко перепутать с Vendor —
  а Vendor у VTT означает марку принтера, к которому расходник подходит.
  Спутать их значит пустить на витрину всё, что совместимо с HP.

  Что показывает: сколько позиций у каждой марки, сколько из них
  активных и сколько с повреждённой упаковкой, и что с этой маркой
  делает текущий фильтр допуска — пускает, не пускает или спасает по
  названию. Сырой стор при этом не трогается: это только отчёт.

  Запуск: node tools/audit-brands.mjs [--store=vtt-data] [--json=путь]
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VttStore } from '../vtt/src/store.mjs';
import { matchesFilter, ownBrandInName } from '../vtt/src/publish.mjs';
import { isDamagedPackage } from '../vtt/src/normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const STORE = path.resolve(ROOT, arg('store', 'vtt-data'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vtt/config.json'), 'utf8'));
const filter = cfg.publishFilter ?? {};

const store = new VttStore(STORE);
const all = [...store.loadAll().values()];

const rows = new Map();
const bump = (brand, key) => {
  const b = (brand ?? '').trim() || '(пусто)';
  if (!rows.has(b)) rows.set(b, { brand: b, total: 0, active: 0, damaged: 0, passes: 0, byName: 0 });
  rows.get(b)[key] += 1;
  return rows.get(b);
};

const allowed = (filter.brands ?? []).map((s) => String(s).trim().toLowerCase());
for (const it of all) {
  const r = bump(it.brand, 'total');
  if (it.active === false) continue;
  r.active += 1;
  const damaged = it.packageDamaged ?? isDamagedPackage({
    name: it.name, description: it.supplierDescription, compatibility: it.compatibilityText,
  });
  if (damaged) { r.damaged += 1; continue; }
  if (matchesFilter(it, filter)) {
    r.passes += 1;
    /* Позиция без своей марки, спасённая по названию, — отдельный
       случай: её допустил не Brand, а имя товара. */
    if (!allowed.includes(String(it.brand ?? '').trim().toLowerCase())) r.byName += 1;
  }
}

const list = [...rows.values()].sort((a, b) => b.total - a.total);
const N = (n) => String(n).padStart(6);
console.log(`\nМарка производителя по всей выгрузке (${all.length} позиций, стор ${path.relative(ROOT, STORE)})\n`);
console.log('  всего активных повреж. на витрину  из них по названию  марка');
for (const r of list) {
  console.log(`${N(r.total)}${N(r.active)}${N(r.damaged)}${N(r.passes)}${N(r.byName)}  ${r.brand}`);
}

const pass = list.filter((r) => r.passes > 0);
const drop = list.filter((r) => r.passes === 0 && r.active > 0);
console.log(`\nМарок всего: ${list.length}. На витрину проходят: ${pass.length}. Не проходят: ${drop.length}.`);
console.log(`Позиций на витрину: ${list.reduce((a, r) => a + r.passes, 0)}.`);
console.log('Белый список из vtt/config.json: ' + (filter.brands ?? []).join(', '));
if (filter.brandFallback) {
  console.log('Спасение по названию: Brand из [' + (filter.brandFallback.whenBrandIn ?? []).map((s) => s || '(пусто)').join(', ') +
    '] и метка в названии из [' + (filter.brandFallback.nameMarks ?? []).join(', ') + ']');
}

/*
  Отдельный отчёт по маркам, которых на витрине нет. Владельцу важно не
  «фильтр отсеял 5943», а какие именно марки и почему: часть из них —
  чужие производители, часть — служебные пометки выгрузки, а часть может
  оказаться своей, просто названной иначе. Пока марка не подтверждена
  полями поставщика, на витрину она не идёт.
*/
const byName = new Map();
for (const it of all) {
  const b = (it.brand ?? '').trim() || '(пусто)';
  if (!byName.has(b)) byName.set(b, []);
  if (byName.get(b).length < 3) byName.get(b).push(`${it.vendorCode} — ${String(it.name).slice(0, 78)}`);
}
console.log('\nДопущены на витрину:');
for (const r of pass) {
  const why = allowed.includes(r.brand.toLowerCase())
    ? 'в белом списке собственных марок'
    : 'Brand не заполнен или «Совместимые», но в названии стоит собственная марка';
  console.log(`  ${r.brand} — ${r.passes} позиций: ${why}`);
}
const excluded = (filter.excludeBrands ?? []).map((s) => String(s).trim().toLowerCase());
console.log('\nНе допущены (активные позиции, кроме повреждённой упаковки):');
for (const r of drop) {
  const live = r.active - r.damaged;
  if (live <= 0) continue;
  const why = excluded.includes(r.brand.toLowerCase())
    ? 'названа явно в excludeBrands: сторонний производитель'
    : (r.brand === '(пусто)' ? 'марка не указана и в названии нет собственной' : 'нет в белом списке собственных марок — марка не подтверждена');
  console.log(`  ${r.brand} — ${live} позиций: ${why}`);
  for (const ex of byName.get(r.brand) ?? []) console.log(`      ${ex}`);
}

const jsonPath = arg('json', null);
if (jsonPath) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, jsonPath)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, jsonPath), JSON.stringify({
    generatedAt: new Date().toISOString(),
    filter: { brands: filter.brands ?? [], excludeBrands: filter.excludeBrands ?? [], brandFallback: filter.brandFallback ?? null },
    brands: list.map((r) => ({ ...r, examples: byName.get(r.brand) ?? [] })),
  }, null, 2));
  console.log(`\nОтчёт: ${jsonPath}`);
}
void ownBrandInName;
