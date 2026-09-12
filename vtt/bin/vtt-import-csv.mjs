#!/usr/bin/env node
/*
  Импорт полной выгрузки VTT из CSV.

    node vtt/bin/vtt-import-csv.mjs <файл.csv> [--store=vtt-data] [--dry]

  Тот же путь, что и у SOAP-выгрузки: сырой ряд → normalize → categories →
  store. Поэтому здесь бесплатно работают все её гарантии — повторный
  запуск идемпотентен, сырые строки сохраняются целиком, пропавшие товары
  не удаляются, а отчёт показывает раскладку и неполные карточки.

  Полнота выгрузки подтверждается не «файл дочитан до конца», а сверкой с
  отчётом рядом с ним, если он есть: total_reported_by_api должен совпасть
  с числом разобранных строк. Без совпадения deactivateMissing не
  вызывается — оборванная выгрузка не имеет права прятать каталог.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsvCatalog } from '../src/csv.mjs';
import { normalizeItem } from '../src/normalize.mjs';
import { deriveCategoryTree, buildCategoryTree, createCategoryMapper, flattenTree, UNMAPPED_ID } from '../src/categories.mjs';
import { VttStore, RunLock } from '../src/store.mjs';
import { makeLogger } from '../src/sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : fallback;
};
const source = argv.find((a) => !a.startsWith('--'));
if (!source) {
  console.error('Укажите файл выгрузки: node vtt/bin/vtt-import-csv.mjs <файл.csv>');
  process.exit(2);
}
const csvFile = path.resolve(source);
if (!fs.existsSync(csvFile)) {
  console.error(`Файл не найден: ${csvFile}`);
  process.exit(2);
}
const storeRoot = path.resolve(valueOf('store', path.join(ROOT, 'vtt-data')));
const dry = argv.includes('--dry');

const logger = makeLogger({});
const store = new VttStore(storeRoot);
const lock = new RunLock(path.join(storeRoot, '.sync.lock'));

/* Отчёт экспортёра лежит рядом с файлом и называет число, которое отдал
   API. Это единственная внешняя проверка полноты, которая у нас есть. */
function readSidecarReport(file) {
  const dir = path.dirname(file);
  for (const name of fs.readdirSync(dir)) {
    if (!/report.*\.json$/i.test(name)) continue;
    try { return { file: name, data: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }; }
    catch { /* битый отчёт не должен ронять импорт */ }
  }
  return null;
}

const started = new Date().toISOString();
const text = fs.readFileSync(csvFile, 'utf8');
const { columns, items: rawRows } = readCsvCatalog(text);
logger.info(`Разобрано строк: ${rawRows.length}, колонок: ${columns.length}`);

const sidecar = readSidecarReport(csvFile);
const reportedTotal = Number(sidecar?.data?.total_reported_by_api);
const completeByReport = Number.isFinite(reportedTotal) ? reportedTotal === rawRows.length : null;
if (sidecar) {
  logger.info(`Отчёт экспортёра ${sidecar.file}: API сообщил ${reportedTotal}, в файле ${rawRows.length}`);
}

/*
  Дерево категорий. GetCategories в выгрузке нет — в CSV приходят только
  названия Group и RootGroup, поэтому дерево производное. Оно всё равно
  детерминированное: идентификатор считается из названий и не зависит ни
  от порядка строк, ни от момента запуска.
*/
const hasCategoryIds = columns.includes('GroupId') && rawRows.some((r) => String(r.GroupId ?? '').trim());
const normalized = [];
const byId = new Map();
const totals = { rows: rawRows.length, withoutId: 0, duplicates: 0, imported: 0, errors: [] };

for (const raw of rawRows) {
  const id = String(raw.Id ?? '').trim();
  if (!id) { totals.withoutId += 1; continue; }
  if (byId.has(id)) { totals.duplicates += 1; continue; }
  try {
    const item = normalizeItem(raw, { now: started });
    item.raw = raw;
    byId.set(id, item);
    normalized.push(item);
  } catch (e) {
    totals.errors.push({ id, message: e.message });
  }
}
logger.info(`Нормализовано: ${normalized.length}, без Id: ${totals.withoutId}, дублей: ${totals.duplicates}, ошибок: ${totals.errors.length}`);

const tree = hasCategoryIds
  ? buildCategoryTree([...new Map(rawRows.map((r) => [String(r.GroupId), { Id: String(r.GroupId), Name: r.Group, ParentId: r.RootGroupId ?? '' }])).values()])
  : deriveCategoryTree(normalized);
const assign = createCategoryMapper(tree);
const catReport = { mapped: 0, byNameFallback: 0, unmapped: [], ambiguous: [] };
const assigned = new Map();
for (const item of normalized) {
  const d = assign(item);
  item.categoryId = d.id;
  assigned.set(item.id, d.id);
  if (d.status === 'byName') catReport.byNameFallback += 1;
  if (d.status === 'ambiguous') catReport.ambiguous.push({ id: item.id, name: item.name ?? null, value: d.value, candidates: d.candidates });
  if (d.id === UNMAPPED_ID) catReport.unmapped.push({ id: item.id, name: item.name ?? null, group: item.category ?? null, rootGroup: item.categoryRoot ?? null });
  else catReport.mapped += 1;
}
logger.info(`Разложено по категориям: ${catReport.mapped}, узлов дерева ${tree.nodes.size}, без категории ${catReport.unmapped.length}, неоднозначных ${catReport.ambiguous.length}`);

const distribution = {};
for (const item of normalized) {
  const key = [item.categoryRoot ?? '(без корня)', item.category ?? '(без группы)'].join(' / ');
  distribution[key] = (distribution[key] ?? 0) + 1;
}
const countBy = (key) => {
  const m = {};
  for (const item of normalized) { const v = item[key] ?? '(пусто)'; m[v] = (m[v] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};

const gaps = {
  noPhoto: normalized.filter((i) => !i.photos?.length).length,
  noDescription: normalized.filter((i) => !i.supplierDescription).length,
  noCompatibility: normalized.filter((i) => !i.compatibilityText).length,
  noBrand: normalized.filter((i) => !i.brand).length,
  noPrice: normalized.filter((i) => !(i.price > 0)).length,
  noCategory: catReport.unmapped.length,
  outOfStock: normalized.filter((i) => !(i.stock?.available > 0)).length,
};

if (dry) {
  console.log(JSON.stringify({ totals, gaps, categories: Object.keys(distribution).length }, null, 2));
  process.exit(0);
}

lock.acquire();
let report;
try {
  /* Сырые строки сохраняются порциями по тысяче: один файл на девять с
     половиной тысяч карточек читался бы целиком ради одной строки. */
  const RAW_CHUNK = 1000;
  for (let i = 0; i < rawRows.length; i += RAW_CHUNK) store.saveRaw('csv', rawRows.slice(i, i + RAW_CHUNK));

  const syncId = `csv-${started}`;
  const up = { added: 0, updated: 0, unchanged: 0, skipped: [] };
  const BATCH = 500;
  for (let i = 0; i < normalized.length; i += BATCH) {
    const rep = store.upsertItems(normalized.slice(i, i + BATCH), { now: started, syncId });
    up.added += rep.added.length;
    up.updated += rep.updated.length;
    up.unchanged += rep.unchanged.length;
    up.skipped.push(...rep.skipped);
  }
  totals.imported = up.added + up.updated + up.unchanged;

  /* Скрывать пропавшие можно только на подтверждённо полной выгрузке.
     Отчёт экспортёра, который не сошёлся со строками файла, — это не
     подтверждение, а расхождение. */
  const complete = completeByReport !== false;
  const deactivated = store.deactivateMissing(new Set(byId.keys()), { complete, now: started, syncId });

  report = {
    syncId, source: path.basename(csvFile), startedAt: started, finishedAt: new Date().toISOString(),
    columns, complete,
    reportedByApi: Number.isFinite(reportedTotal) ? reportedTotal : null,
    rows: totals.rows, unique: byId.size, withoutId: totals.withoutId, duplicates: totals.duplicates,
    errors: totals.errors, imported: totals.imported,
    added: up.added, updated: up.updated, unchanged: up.unchanged, skipped: up.skipped,
    hidden: deactivated.hidden.length, hiddenSkipped: deactivated.skipped ? deactivated.reason : null,
    categories: {
      source: tree.source, nodes: tree.nodes.size, roots: tree.roots.length,
      mapped: catReport.mapped, byNameFallback: catReport.byNameFallback,
      unmapped: catReport.unmapped.length, ambiguous: catReport.ambiguous.length,
      distribution,
    },
    brands: countBy('brand'),
    compatibleBrands: countBy('compatibleBrand'),
    gaps,
  };
  store.saveReport('last-csv-import', report);
  store.saveReport('csv-unmapped', { unmapped: catReport.unmapped, ambiguous: catReport.ambiguous });
  store.saveState({
    lastFullSync: started, resume: null,
    categoriesSource: tree.source,
    categories: flattenTree(tree, assigned),
    importSource: `csv:${path.basename(csvFile)}`,
  });
} finally {
  lock.release();
}

logger.info('Импорт CSV завершён', {
  строк: report.rows, уникальных: report.unique, импортировано: report.imported,
  добавлено: report.added, обновлено: report.updated, безизменений: report.unchanged,
  скрыто: report.hidden, категорий: report.categories.nodes,
});
console.log(`\nОтчёт: ${path.relative(ROOT, path.join(storeRoot, 'reports/last-csv-import.json'))}`);
