#!/usr/bin/env node
/*
  Разовая миграция: собрать реестр идентичности из уже опубликованного
  каталога.

  Реестр (tools/item-registry.mjs) появился после того, как исключение
  повреждённой упаковки перенумеровало 449 нормальных товаров. Чтобы
  ничего не перенумеровывать, реестр надо не начать с нуля, а заполнить
  тем, что уже видели покупатели: адресами и кодами из последней
  публикации до реестра.

  Откуда берутся данные:

    • адреса — прямо из индекса той сборки (data/catalog/index.json в
      указанной ревизии git);
    • коды — тем же выражением, которым их считала витрина: 100000 +
      fnv1a(адрес) % 900000. Другого источника нет и быть не может: код
      нигде не хранился, он вычислялся при отрисовке;
    • стабильный ключ — Id поставщика. В индексе его нет, поэтому раздача
      адресов воспроизводится из стора тем же алгоритмом, каким шла
      сборка, и результат сверяется с индексом: если хоть один адрес не
      совпал, миграция останавливается. Угадывать тут нечего.

  В реестр попадают ВСЕ товары той сборки, включая повреждённую упаковку.
  Она с витрины ушла, но её адреса и номера обязаны остаться занятыми —
  иначе они достанутся другим товарам, а именно из-за этого всё и
  затевалось.

  Запуск (один раз):
    node tools/seed-item-registry.mjs [--rev=5e304db] [--out=data/item-registry.json]
*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VttStore } from '../vtt/src/store.mjs';
import { publish } from '../vtt/src/publish.mjs';
import { slugify } from '../vtt/src/normalize.mjs';
import { unpackRows } from './index-pack.mjs';
import { ItemRegistry, fnv1a, NO_MIN, NO_MAX } from './item-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const REV = argOf('rev', '5e304db');
const OUT = path.resolve(ROOT, argOf('out', 'data/item-registry.json'));

const idx = JSON.parse(execFileSync('git', ['show', `${REV}:data/catalog/index.json`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));
const rows = unpackRows(idx);
const col = Object.fromEntries(idx.fields.map((f, i) => [f, i]));
const ownRows = rows.filter((r) => r[col.src] !== 'vtt');
const vttRows = rows.filter((r) => r[col.src] === 'vtt');
console.log(`каталог ${REV}: ${rows.length} товаров (прототип ${ownRows.length}, импорт ${vttRows.length})`);

/*
  Воспроизведение раздачи адресов. Фильтр тот же, что был в той сборке:
  собственные марки VTT и БЕЗ отсева повреждённой упаковки — она тогда
  ещё публиковалась.
*/
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vtt/config.json'), 'utf8'));
const { products } = publish(new VttStore(path.join(ROOT, 'vtt-data')), {
  filter: { ...cfg.publishFilter, excludeDamagedPackage: false },
});
const existing = new Set(ownRows.map((r) => r[col.id]));
const idByVtt = new Map();
for (const p of products) {
  let id = p.id;
  if (existing.has(id)) {
    id = `${p.id}-${slugify(p.vttId || '')}`.replace(/-+$/, '');
    let n = 2;
    while (existing.has(id)) id = `${p.id}-${slugify(p.vttId || '')}-${n++}`;
  }
  existing.add(id);
  idByVtt.set(p.vttId, id);
}

/* Сверка: воспроизведённые адреса обязаны совпасть с индексом до одного. */
const inIndex = new Set(vttRows.map((r) => r[col.id]));
const replayed = new Set(idByVtt.values());
const missing = [...inIndex].filter((x) => !replayed.has(x));
const extra = [...replayed].filter((x) => !inIndex.has(x));
if (missing.length || extra.length) {
  console.error(`Раздача адресов не воспроизвелась: нет ${missing.length}, лишних ${extra.length}`);
  console.error('  ', missing.slice(0, 5), extra.slice(0, 5));
  process.exit(2);
}
console.log(`раздача адресов воспроизведена точно: ${replayed.size} из ${inIndex.size}`);

/* Код товара — тем же выражением, каким его показывала витрина. */
const noOf = (id) => NO_MIN + (fnv1a(id) % (NO_MAX - NO_MIN + 1));

/* Признак повреждённой упаковки берём из стора, а не из товара витрины:
   в товар витрины он не едет, и попытка угадать его по названию ошиблась
   на 45 позициях — из-за чего номер при совпадении однажды достался
   удалённой позиции вместо той, что осталась на витрине. */
const storeItems = new VttStore(path.join(ROOT, 'vtt-data')).loadAll();
const damaged = new Set([...storeItems.values()].filter((i) => i.packageDamaged).map((i) => i.id));
const entries = [];
for (const r of ownRows) entries.push({ key: `own:${r[col.id]}`, id: r[col.id], damaged: false });
for (const [vttId, id] of idByVtt) entries.push({ key: `vtt:${vttId}`, id, damaged: damaged.has(vttId) });

/*
  Совпавшие номера. Хеш от адреса на 5 602 товарах даёт около двух
  десятков совпадений — это было и до реестра, просто никто не смотрел.
  Двум товарам один код оставить нельзя: по нему перестанет работать
  поиск. Номер остаётся у того, кто на витрине (повреждённая упаковка
  уступает), а при равных — у меньшего адреса; второму подбирается
  свободный. Порядок фиксированный, так что миграция повторяема.
*/
const byNo = new Map();
for (const e of entries) {
  e.no = noOf(e.id);
  if (!byNo.has(e.no)) byNo.set(e.no, []);
  byNo.get(e.no).push(e);
}
let reassigned = 0;
const taken = new Set(byNo.keys());
for (const [, group] of [...byNo.entries()].sort((a, b) => a[0] - b[0])) {
  if (group.length < 2) continue;
  group.sort((a, b) => (a.damaged === b.damaged ? a.id.localeCompare(b.id, 'ru') : (a.damaged ? 1 : -1)));
  for (const e of group.slice(1)) {
    let no = NO_MIN + ((e.no - NO_MIN + 1) % (NO_MAX - NO_MIN + 1));
    while (taken.has(no)) no = NO_MIN + ((no - NO_MIN + 1) % (NO_MAX - NO_MIN + 1));
    taken.add(no);
    console.log(`  код ${e.no} достался ${group[0].id}; ${e.id} получил ${no}`);
    e.no = no;
    reassigned += 1;
  }
}

const registry = new ItemRegistry();
for (const e of entries.sort((a, b) => a.key.localeCompare(b.key))) {
  registry.data.items[e.key] = { id: e.id, no: e.no };
  registry.byId.set(e.id, e.key);
  registry.usedNo.add(e.no);
}
registry.save(OUT);
console.log(`\nРеестр: ${registry.size} записей → ${path.relative(ROOT, OUT)}`);
console.log(`  из них повреждённая упаковка: ${entries.filter((e) => e.damaged).length} (адреса и номера остаются занятыми)`);
console.log(`  разведено совпавших номеров: ${reassigned}`);
const check = registry.get('vtt:4100603161');
console.log(`  проверка HB-TK-8115C (Id 4100603161): адрес ${check.id}, код ${check.no}`);
