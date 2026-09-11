/*
  Оркестровка синхронизации: диагностика, полная выгрузка, оперативные данные.

  Возобновление после сбоя. Курсор порции пишется в state.json после каждой
  успешной порции вместе со списком уже увиденных Id. Повторный запуск
  продолжает с этого места, а не начинает с нуля: на каталоге в десятки
  тысяч строк это разница между «доделать» и «начать заново».

  Признак полноты. Скрывать пропавшие товары можно только тогда, когда цикл
  дошёл до короткой порции сам, без исключений и без отмены. Этот факт
  фиксируется отдельным флагом complete и передаётся в deactivateMissing —
  оборванный синк прятать каталог не имеет права.
*/
import { VttClient, withRetry, downloadAll, VttAuthError } from './client.mjs';
import { normalizeItem, normalizeRuntime, normalizeCompatibility, normalizeAttributes, normalizeRelated, compatibilityLabel } from './normalize.mjs';
import { buildCategoryTree, deriveCategoryTree, createCategoryMapper, flattenTree, UNMAPPED_ID } from './categories.mjs';
import { VttStore, RunLock } from './store.mjs';
import { makeRedactor, httpRisk } from './config.mjs';

export function makeLogger({ redact = (s) => s, sink = console } = {}) {
  const line = (level, msg, extra) => {
    const text = `[${new Date().toISOString()}] ${level} ${redact(msg)}`;
    sink.log(extra === undefined ? text : `${text} ${redact(JSON.stringify(extra))}`);
  };
  return {
    info: (m, e) => line('INFO ', m, e),
    warn: (m, e) => line('WARN ', m, e),
    error: (m, e) => line('ERROR', m, e),
  };
}

/*
  Диагностика. Одна короткая порция — проверяет доступность сервиса,
  учётные данные и форму ответа, не выкачивая каталог. Возвращает список
  фактически пришедших полей: именно так подтверждается контракт ItemDto,
  без доверия к документации.
*/
export async function diagnose({ client, credentials, store, logger, sampleSize = 5 }) {
  const started = new Date().toISOString();
  const portion = await client.getItemPortion(credentials, 0, Math.max(1, sampleSize));
  const fields = new Set();
  for (const item of portion.items) for (const k of Object.keys(item)) fields.add(k);

  /* Проверяем доступность каждой операции WSDL для этой учётной записи.
     Метод в WSDL есть у всех — но право на вызов может быть не у всех,
     и узнать это можно только вызовом. */
  const sampleId = portion.items[0]?.Id;
  const probe = async (name, fn) => {
    try { const r = await fn(); return { supported: r.supported, count: r.items.length, reason: r.reason ?? null }; }
    catch (e) { if (e instanceof VttAuthError) throw e; return { supported: false, count: 0, reason: e.message }; }
  };
  const categories = await client.getCategories(credentials).catch((e) => {
    if (e instanceof VttAuthError) throw e;
    return { supported: false, items: [], reason: e.message };
  });
  const operations = {
    GetCategories: { supported: categories.supported, count: categories.items.length, reason: categories.reason ?? null },
    GetGoodsCompatibilityInformation: await probe('c', () => client.getGoodsCompatibilityInformation(credentials, sampleId)),
    GetAdditionalAttributes: await probe('a', () => client.getAdditionalAttributes(credentials, sampleId)),
    GetRelatedItems: await probe('r', () => client.getRelatedItems(credentials, sampleId)),
    GetCategoryItems: categories.items.length
      ? await probe('ci', () => client.getCategoryItems(credentials, categories.items[0].Id ?? categories.items[0].id))
      : { supported: false, count: 0, reason: 'нет категорий для проверки' },
    GetItem: await probe('i', () => client.getItem(credentials, sampleId)),
    GetRuntimeItem: await probe('ri', () => client.getRuntimeItem(credentials, sampleId)),
  };
  const compat = { supported: operations.GetGoodsCompatibilityInformation.supported, items: [], reason: operations.GetGoodsCompatibilityInformation.reason };

  const result = {
    startedAt: started,
    finishedAt: new Date().toISOString(),
    itemPortion: { ok: true, received: portion.items.length, totalCount: portion.totalCount },
    itemDtoFields: [...fields].sort(),
    operations,
    getCategories: operations.GetCategories,
    getGoodsCompatibilityInformation: operations.GetGoodsCompatibilityInformation,
    sample: portion.items.slice(0, 2),
  };
  if (store) {
    store.saveRaw('diagnose', portion.items);
    result.reportFile = store.saveReport('diagnose', result);
  }
  logger?.info('Диагностика завершена', {
    received: result.itemPortion.received,
    fields: result.itemDtoFields.length,
    categories: result.getCategories.supported,
  });
  return result;
}

/*
  Полная выгрузка. Сырые порции сохраняются до нормализации: если завтра
  изменится нормализация, каталог пересобирается из стора без обращения к
  VTT.
*/
export async function fullSync({
  client, credentials, store, logger, config,
  now = () => new Date().toISOString(),
  resume = true,
}) {
  const stamp = now();
  const syncId = `full-${stamp}`;
  const state = store.loadState();
  const canResume = resume && state.resume?.syncId && state.resume.from > 0;
  const seen = new Set(canResume ? state.resume.seen ?? [] : []);
  if (canResume) logger?.info('Продолжаю прерванную выгрузку', { from: state.resume.from, already: seen.size });

  /*
    Категории запрашиваются ДО выгрузки товаров. Это не мелочь: категорию
    нужно проставить прямо в порции, чтобы порция сразу легла в стор.
    Иначе раскладку пришлось бы делать в самом конце по всему каталогу — а
    тогда прерванная выгрузка теряла бы всё, что успела скачать.
  */
  let catsResult = { supported: false, items: [], reason: 'не запрашивалось' };
  try {
    catsResult = await client.getCategories(credentials);
  } catch (e) {
    if (e instanceof VttAuthError) throw e;
    catsResult = { supported: false, items: [], reason: e.message };
  }
  const official = catsResult.supported && catsResult.items.length;
  if (official) store.saveRaw('categories', catsResult.items);
  /* Без официального дерева идентификатор категории считается из полей
     самого товара, поэтому «дерево» здесь пустое: оно будет собрано из
     накопленных значений в конце. */
  const tree = official ? buildCategoryTree(catsResult.items) : deriveCategoryTree([]);
  const assign = createCategoryMapper(tree);

  const totals = { added: 0, updated: 0, unchanged: 0, skipped: [], rowsReceived: 0, duplicates: 0, withoutId: 0, portions: 0 };
  const catReport = { mapped: 0, byNameFallback: 0, unmapped: [], ambiguous: [] };
  const assignedCats = new Map();
  const incomplete = [];
  /* Для производного дерева хранятся только пары «корень/лист», а не все
     товары: памяти это стоит копейки при любом размере каталога. */
  const derivedPairs = new Map();
  let complete = false;

  const handlePortion = (portion, from, to) => {
    store.saveRaw('items', portion.items);
    totals.portions += 1;
    totals.rowsReceived += portion.items.length;

    const batch = [];
    for (const raw of portion.items) {
      const id = raw.Id === undefined || raw.Id === null ? '' : String(raw.Id).trim();
      if (!id) { totals.withoutId += 1; continue; }
      if (seen.has(id)) { totals.duplicates += 1; continue; }
      seen.add(id);

      const item = normalizeItem(raw, { now: stamp });
      const decision = assign(item);
      item.categoryId = decision.id;
      assignedCats.set(item.id, decision.id);
      if (decision.status === 'byName') catReport.byNameFallback += 1;
      if (decision.status === 'ambiguous') {
        catReport.ambiguous.push({ id: item.id, name: item.name ?? null, value: decision.value, candidates: decision.candidates });
      }
      if (decision.id === UNMAPPED_ID) {
        catReport.unmapped.push({ id: item.id, name: item.name ?? null, group: item.category ?? null, rootGroup: item.categoryRoot ?? null });
      } else {
        catReport.mapped += 1;
        if (!official) derivedPairs.set(decision.id, { root: item.categoryRoot ?? null, leaf: item.category ?? null });
      }
      if (item.missing?.length) incomplete.push({ id: item.id, name: item.name ?? null, missing: item.missing });
      batch.push(item);
    }

    /* Порция кладётся в стор сразу, и только после этого двигается курсор.
       Порядок именно такой: при падении между записью и курсором повтор
       порции ничего не испортит — upsert идемпотентен. */
    const rep = store.upsertItems(batch, { now: stamp, syncId });
    totals.added += rep.added.length;
    totals.updated += rep.updated.length;
    totals.unchanged += rep.unchanged.length;
    totals.skipped.push(...rep.skipped);
    store.saveState({ resume: { syncId, from: to + 1, seen: [...seen] } });
    return portion;
  };

  const fetchPortion = (from, to) => withRetry(
    () => client.getItemPortion(credentials, from, to),
    {
      attempts: config.retryAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      onRetry: ({ attempt, attempts, delay, error }) =>
        logger?.warn(`Повтор порции ${from}..${to} (${attempt}/${attempts}) через ${delay} мс: ${error.message}`),
    },
  ).then((portion) => handlePortion(portion, from, to));

  try {
    await downloadAll(fetchPortion, {
      portionSize: config.portionSize,
      startFrom: canResume ? state.resume.from : 0,
      /* Дедупликация и накопление уже сделаны в handlePortion, поэтому
         downloadAll здесь отвечает только за границы порций. */
      seen: new Set(),
      collected: [],
      onProgress: (p) => logger?.info(`Порция ${p.portions}: строк ${totals.rowsReceived}, уникальных ${seen.size}`),
    });
    complete = true;
  } catch (e) {
    logger?.error(`Выгрузка прервана: ${e.message}`);
    throw e;
  }

  /* Производное дерево собирается из накопленных пар — теперь, когда
     известен весь набор категорий. */
  const finalTree = official
    ? tree
    : deriveCategoryTree([...derivedPairs.values()].map((p) => ({ category: p.leaf, categoryRoot: p.root })));

  /*
    Обогащение после основной выгрузки.

    Порядок именно такой: сначала весь каталог лежит в сторе, и только
    потом к нему добираются дополнительные операции. Если какая-то из них
    недоступна учётной записи или упадёт, каталог уже сохранён и ничего не
    теряется — в отчёт уйдёт только факт недоступности.

    Членство в категориях через GetCategoryItems надёжнее текстовых
    Group/RootGroup: связь задана идентификаторами, а не совпадением
    названий, которое ломается от любой правки у поставщика. Поэтому там,
    где официальное членство известно, оно перекрывает раскладку по тексту.
  */
  const enrich = { compatibility: null, attributes: null, related: null, categoryMembership: null };
  const enriched = new Map();
  /* Обогащение копится в памяти и кладётся в стор одним проходом на товар.
     Иначе один и тот же шард переписывался бы по разу на каждую операцию —
     на 50 тысячах карточек это часы лишнего ввода-вывода. */
  const addPatch = (itemId, patch) => {
    const key = String(itemId ?? '').trim();
    if (!key) return;
    enriched.set(key, { ...(enriched.get(key) ?? {}), ...patch });
  };

  const compatRes = await client.getGoodsCompatibilityInformation(credentials).catch((e) => {
    if (e instanceof VttAuthError) throw e;
    return { supported: false, items: [], reason: e.message };
  });
  if (compatRes.supported && compatRes.items.length) {
    store.saveRaw('compatibility', compatRes.items);
    const byItem = normalizeCompatibility(compatRes.items);
    for (const [itemId, entries] of byItem) {
      /* Строка Compatibility из ItemDto НЕ затирается: это данные
         поставщика, и они остаются как есть. Разобранные по полям модели
         кладутся рядом — витрина предпочитает их, а строка остаётся
         запасным вариантом там, где операция недоступна. */
      addPatch(itemId, {
        compatibilityDetailed: entries,
        compatibilityLabels: entries.map(compatibilityLabel).filter(Boolean),
      });
    }
    enrich.compatibility = { supported: true, rows: compatRes.items.length, items: byItem.size };
    logger?.info('Совместимость получена из GetGoodsCompatibilityInformation', { товаров: byItem.size });
  } else {
    enrich.compatibility = { supported: false, reason: compatRes.reason ?? null };
  }

  const attrRes = await client.getAdditionalAttributes(credentials).catch((e) => {
    if (e instanceof VttAuthError) throw e;
    return { supported: false, items: [], reason: e.message };
  });
  if (attrRes.supported && attrRes.items.length) {
    store.saveRaw('attributes', attrRes.items);
    const byItem = normalizeAttributes(attrRes.items);
    for (const [itemId, attrs] of byItem) addPatch(itemId, { attributes: attrs });
    enrich.attributes = { supported: true, rows: attrRes.items.length, items: byItem.size };
  } else {
    enrich.attributes = { supported: false, reason: attrRes.reason ?? null };
  }

  /* Официальное членство в категориях. Ходим по листьям дерева: у корней
     товаров обычно нет, а лишние вызовы — это лишняя нагрузка на чужой
     сервис. */
  if (official) {
    const leaves = [...finalTree.nodes.values()].filter((n) => n.children.length === 0);
    const membership = new Map();
    let failed = 0;
    for (const leaf of leaves) {
      const res = await client.getCategoryItems(credentials, leaf.id).catch((e) => {
        if (e instanceof VttAuthError) throw e;
        return { supported: false, items: [], reason: e.message };
      });
      if (!res.supported) { failed += 1; continue; }
      for (const raw of res.items) {
        const id = raw.Id === undefined || raw.Id === null ? '' : String(raw.Id).trim();
        if (id) membership.set(id, leaf.id);
      }
    }
    if (membership.size) {
      let moved = 0, confirmed = 0;
      for (const [itemId, catId] of membership) {
        if (assignedCats.get(itemId) !== catId) moved += 1; else confirmed += 1;
        /* Источник раскладки записывается всегда, даже когда официальное
           членство лишь подтвердило уже выбранную категорию: иначе по
           карточке потом не понять, откуда взялась категория — из текста
           Group или из официальной операции. */
        addPatch(itemId, { categoryId: catId, categorySource: 'GetCategoryItems' });
        assignedCats.set(itemId, catId);
      }
      enrich.categoryMembership = { supported: true, leaves: leaves.length, failed, items: membership.size, corrected: moved, confirmed };
      logger?.info('Членство в категориях уточнено через GetCategoryItems', { товаров: membership.size, исправлено: moved, подтверждено: confirmed });
    } else {
      enrich.categoryMembership = { supported: false, leaves: leaves.length, failed, reason: 'метод не вернул товаров' };
    }
  } else {
    enrich.categoryMembership = { supported: false, reason: 'нет официального дерева категорий' };
  }

  /*
    Связанные товары. Операция поштучная — по одному вызову на карточку, —
    поэтому она единственная, у которой есть предел и параллельность:
    на каталоге в десятки тысяч строк безлимитный обход означал бы десятки
    тысяч запросов к чужому сервису за один синк. Предел задаётся
    конфигурацией (relatedItems.limit, 0 — без предела) и честно
    показывается в отчёте, чтобы «связей нет» нельзя было спутать с
    «до них не дошли».
  */
  const relatedCfg = { enabled: true, limit: 0, concurrency: 4, ...(config.relatedItems ?? {}) };
  if (relatedCfg.enabled === false) {
    enrich.related = { supported: false, reason: 'отключено в конфигурации' };
  } else {
    const ids = [...seen];
    const targets = relatedCfg.limit > 0 ? ids.slice(0, relatedCfg.limit) : ids;
    let requested = 0, withLinks = 0, links = 0, failed = 0, unsupported = null;

    const fetchOne = async (id) => {
      requested += 1;
      const res = await client.getRelatedItems(credentials, id).catch((e) => {
        if (e instanceof VttAuthError) throw e;
        return { supported: false, items: [], reason: e.message };
      });
      if (!res.supported) { failed += 1; unsupported ??= res.reason ?? null; return false; }
      const related = normalizeRelated(res.items).filter((x) => x !== id);
      if (related.length) { addPatch(id, { related }); withLinks += 1; links += related.length; }
      return true;
    };

    /*
      Сначала один пробный вызов, и только потом обход каталога. Отказ по
      правам одинаков для всех товаров, и без пробы он повторился бы
      столько раз, сколько в каталоге строк: пятьдесят тысяч заведомо
      бесполезных запросов к чужому сервису. Проба даёт ответ за один.
    */
    const probed = targets.length ? await fetchOne(targets[0]) : true;
    if (!probed) {
      enrich.related = { supported: false, reason: unsupported ?? 'операция недоступна', requested };
      logger?.warn('GetRelatedItems недоступен этой учётной записи, обход пропущен', { причина: unsupported });
    } else {
      let cursor = 1;
      const worker = async () => {
        while (cursor < targets.length) await fetchOne(targets[cursor++]);
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(relatedCfg.concurrency, Math.max(targets.length - 1, 1))) }, worker),
      );
      enrich.related = {
        supported: true,
        requested,
        ofTotal: ids.length,
        limited: targets.length < ids.length,
        items: withLinks,
        links,
        failed,
      };
      logger?.info('Связанные товары', { запрошено: requested, сосвязями: withLinks, ошибок: failed });
    }
  }

  /* Один проход по накопленным патчам: каждая карточка переписывается
     ровно один раз, независимо от того, сколько операций её дополнили. */
  let patched = 0, orphan = 0;
  for (const [itemId, patch] of enriched) {
    if (store.patchItem(itemId, patch, { now: stamp })) patched += 1; else orphan += 1;
  }
  enrich.applied = { items: patched, unknownIds: orphan };
  if (orphan) logger?.warn('Дополнительные операции вернули товары, которых нет в выгрузке', { количество: orphan });

  const deactivated = store.deactivateMissing(seen, { complete, now: stamp, syncId });

  const report = {
    syncId,
    finishedAt: now(),
    complete,
    portions: totals.portions,
    rowsReceived: totals.rowsReceived,
    unique: seen.size,
    duplicates: totals.duplicates,
    withoutId: totals.withoutId,
    added: totals.added,
    updated: totals.updated,
    unchanged: totals.unchanged,
    skipped: totals.skipped,
    hidden: deactivated.hidden.length,
    hiddenSkipped: deactivated.skipped ? deactivated.reason : null,
    categories: {
      source: finalTree.source,
      supported: catsResult.supported,
      reason: catsResult.reason ?? null,
      nodes: finalTree.nodes.size,
      issues: finalTree.issues,
      mapped: catReport.mapped,
      byNameFallback: catReport.byNameFallback,
      unmapped: catReport.unmapped.length,
      ambiguous: catReport.ambiguous.length,
    },
    incomplete,
    enrich,
  };

  store.saveReport(`full-${stamp.replace(/[:.]/g, '-')}`, {
    ...report, unmappedDetails: catReport.unmapped, ambiguousDetails: catReport.ambiguous,
  });
  store.saveReport('last-full', report);
  store.saveState({
    lastFullSync: stamp,
    resume: null,
    categoriesSource: finalTree.source,
    categories: flattenTree(finalTree, assignedCats),
  });
  logger?.info('Полная синхронизация завершена', {
    added: report.added, updated: report.updated, unchanged: report.unchanged, hidden: report.hidden,
  });
  return report;
}

/* Оперативные данные: цена и три независимых остатка. Ничего не
   складывается и ничего, кроме этих полей, не трогается. */
export async function runtimeSync({ client, credentials, store, logger, config, now = () => new Date().toISOString() }) {
  const syncId = `runtime-${now()}`;
  const fetchPortion = (from, to) => withRetry(
    () => client.getRuntimeItemsPortion(credentials, from, to),
    {
      attempts: config.retryAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      onRetry: ({ attempt, attempts, delay, error }) =>
        logger?.warn(`Повтор оперативной порции ${from}..${to} (${attempt}/${attempts}) через ${delay} мс: ${error.message}`),
    },
  ).then((portion) => { store.saveRaw('runtime', portion.items); return portion; });

  const download = await downloadAll(fetchPortion, {
    portionSize: config.portionSize,
    onProgress: (p) => logger?.info(`Оперативная порция ${p.portions}: строк ${p.rowsReceived}`),
  });
  const stamp = now();
  const rows = download.items.map((raw) => normalizeRuntime(raw, { now: stamp }));
  const res = store.upsertRuntime(rows, { now: stamp });

  const report = {
    syncId, finishedAt: stamp,
    portions: download.portions, rowsReceived: download.rowsReceived,
    updated: res.updated.length,
    unknown: res.unknown.length,
    unknownSample: res.unknown.slice(0, 20),
  };
  store.saveReport('last-runtime', report);
  store.saveState({ lastRuntimeSync: stamp });
  logger?.info('Оперативная синхронизация завершена', { updated: report.updated, unknown: report.unknown });
  return report;
}

/* Единая точка запуска: блокировка, предупреждение о HTTP, маскировка. */
export async function runSync(mode, { config, credentials, storeRoot, fetchImpl, sink = console, now }) {
  const redact = makeRedactor(credentials);
  const logger = makeLogger({ redact, sink });
  const risk = httpRisk(config.serviceUrl);
  if (risk.risk) logger.warn(risk.message);

  const store = new VttStore(storeRoot);
  const lock = new RunLock(`${storeRoot}/.sync.lock`);
  lock.acquire();
  try {
    const client = new VttClient({
      url: config.serviceUrl, namespace: config.namespace,
      timeoutMs: config.timeoutMs, fetchImpl,
    });
    if (mode === 'diagnose') return await diagnose({ client, credentials, store, logger });
    if (mode === 'full') return await fullSync({ client, credentials, store, logger, config, ...(now ? { now } : {}) });
    if (mode === 'runtime') return await runtimeSync({ client, credentials, store, logger, config, ...(now ? { now } : {}) });
    throw new Error(`Неизвестный режим синхронизации: ${mode}`);
  } finally {
    lock.release();
  }
}
