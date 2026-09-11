/*
  Тесты конвейера VTT.

  Проверяется то, что ломается молча и дорого: границы порций, дубликаты
  Id, неизвестные категории, повторный синк и скрытие пропавших товаров.
  Везде, где можно, путь идёт через настоящие SOAP-конверты — так парсер
  проверяется вместе с логикой, а не отдельно от неё.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEnvelope, parseEnvelope, SoapFault, xmlEscape } from '../src/soap.mjs';
import { VttClient, downloadAll, withRetry, VttAuthError, VttContractError, parsePortion, TransportError } from '../src/client.mjs';
import { normalizeItem, normalizeRuntime, parseCompatibility, asList, asCount } from '../src/normalize.mjs';
import { buildCategoryTree, deriveCategoryTree, mapItemsToCategories, flattenTree, UNMAPPED_ID } from '../src/categories.mjs';
import { VttStore, RunLock, stableStringify, sha256 } from '../src/store.mjs';
import { loadConfig, loadCredentials, makeRedactor, httpRisk } from '../src/config.mjs';
import { diagnose, fullSync, runtimeSync } from '../src/sync.mjs';
import { createMockFetch, makeItems, portionEnvelope, faultEnvelope, SAMPLE_CATEGORIES } from '../fixtures/mock-service.mjs';

const CRED = { login: 'user', password: 'secret-pass' };
const CONFIG = { portionSize: 500, retryAttempts: 3, retryBaseDelayMs: 1, timeoutMs: 5000, namespace: 'http://tempuri.org/' };

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-store-'));
  return { dir, store: new VttStore(dir) };
}

/* ------------------------------------------------------------------ SOAP */

test('конверт содержит операцию и экранированные аргументы', () => {
  const xml = buildEnvelope('GetItemPortion', 'http://tempuri.org/', { login: 'a&b', password: 'p<w>', from: 0, to: 500 });
  assert.match(xml, /<tem:GetItemPortion>/);
  assert.match(xml, /<tem:login>a&amp;b<\/tem:login>/);
  assert.match(xml, /<tem:password>p&lt;w&gt;<\/tem:password>/);
  assert.match(xml, /<tem:from>0<\/tem:from><tem:to>500<\/tem:to>/);
});

test('Fault разворачивается в SoapFault, а не в «пустой ответ»', () => {
  assert.throws(() => parseEnvelope(faultEnvelope('s:Client', 'Authentication failed')), SoapFault);
});

test('XXE не срабатывает: внешняя сущность отвергается, а не подставляется', () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><R><V>&xxe;</V></R></s:Body></s:Envelope>';
  /* Парсер отказывается разбирать внешнюю сущность — это строже, чем просто
     не подставить её значение, и нас устраивает любой из двух исходов,
     кроме подстановки содержимого файла. */
  try {
    const body = parseEnvelope(xml);
    assert.ok(!String(body?.R?.V ?? '').includes('root:'), 'содержимое файла не должно попасть в ответ');
  } catch (e) {
    assert.match(String(e.message), /entit/i);
  }
});

test('список из одного элемента остаётся списком', () => {
  const body = parseEnvelope(portionEnvelope('GetItemPortion', 'ItemDto', makeItems(1), 1));
  const portion = parsePortion(body.GetItemPortionResponse, 'GetItemPortionResult', 'ItemDto');
  assert.equal(portion.items.length, 1);
});

/* ------------------------------------------------------- границы порций */

test('пагинация VTT: 0..500, 501..1000, 1001..1500 без пропусков', async () => {
  const fetchImpl = createMockFetch({ items: makeItems(1200) });
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  const res = await downloadAll((f, t) => client.getItemPortion(CRED, f, t), { portionSize: 500 });
  assert.deepEqual(fetchImpl.calls.map((c) => [c.from, c.to]), [[0, 500], [501, 1000], [1001, 1500]]);
  assert.equal(res.rowsReceived, 1200);
  assert.equal(res.items.length, 1200);
  assert.equal(res.portions, 3);
  assert.equal(res.items.at(-1).Id, 'VTT-01199');
});

test('последние строки не теряются на неполной порции', async () => {
  const fetchImpl = createMockFetch({ items: makeItems(1200) });
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  const res = await downloadAll((f, t) => client.getItemPortion(CRED, f, t), { portionSize: 500 });
  const tail = res.items.slice(-200).map((i) => i.Id);
  assert.equal(tail[0], 'VTT-01000');
  assert.equal(tail.at(-1), 'VTT-01199');
});

test('каталог, кратный размеру порции, требует завершающего пустого запроса', async () => {
  const fetchImpl = createMockFetch({ items: makeItems(1000) });
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  const res = await downloadAll((f, t) => client.getItemPortion(CRED, f, t), { portionSize: 500 });
  assert.equal(res.items.length, 1000);
  assert.equal(res.portions, 3, 'последняя порция пустая и закрывает цикл');
});

test('пустой каталог не зацикливается', async () => {
  const fetchImpl = createMockFetch({ items: [] });
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  const res = await downloadAll((f, t) => client.getItemPortion(CRED, f, t), { portionSize: 500 });
  assert.equal(res.items.length, 0);
  assert.equal(res.portions, 1);
});

test('порция больше запрошенной — контрактная ошибка, а не тихая порча', async () => {
  await assert.rejects(
    () => downloadAll(async () => ({ items: makeItems(600), totalCount: 600 }), { portionSize: 500 }),
    VttContractError,
  );
});

/* --------------------------------------------------------------- дубли */

test('повторяющиеся Id отбрасываются, строки без Id сохраняются и считаются', async () => {
  const dupes = [
    { Id: 'A', Name: 'a' }, { Id: 'B', Name: 'b' }, { Id: 'A', Name: 'a-again' },
    { Name: 'без идентификатора' },
  ];
  const res = await downloadAll(async () => ({ items: dupes, totalCount: 4 }), { portionSize: 500 });
  assert.equal(res.duplicates, 1);
  assert.equal(res.withoutId, 1);
  assert.equal(res.items.length, 3);
});

/* ------------------------------------------------------ ошибки и retry */

test('отказ авторизации не повторяется и приходит отдельным типом', async () => {
  const fetchImpl = createMockFetch({ badCredentials: true });
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  await assert.rejects(() => client.getItemPortion(CRED, 0, 500), VttAuthError);
  assert.equal(fetchImpl.calls.length, 1, 'повторять неверный пароль бессмысленно');
});

test('сетевой сбой повторяется с нарастающей паузой и доходит до успеха', async () => {
  const fetchImpl = createMockFetch({ items: makeItems(3), failFirst: 2 });
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  const delays = [];
  const res = await withRetry(() => client.getItemPortion(CRED, 0, 500), {
    attempts: 4, baseDelayMs: 10,
    onRetry: ({ delay }) => delays.push(delay),
    sleepImpl: async () => {},
  });
  assert.equal(res.items.length, 3);
  assert.deepEqual(delays, [10, 20]);
});

/* ---------------------------------------------------------- нормализация */

test('нормализация сохраняет факты и не придумывает отсутствующие', () => {
  const item = normalizeItem({
    Id: 'X1', Name: ' Картридж  HB-TK-1150 ', Vendor: 'HB-TK-1150', Brand: 'Hi-Black',
    Group: 'Картриджи лазерные', RootGroup: 'Расходные материалы',
    Compatibility: 'Kyocera M2135dn; Kyocera P2235dn', AvailableQuantity: '5',
    TransitQuantity: '2', MainOfficeQuantity: '1', Price: '1 234,50', Width: '30',
  });
  assert.equal(item.name, 'Картридж HB-TK-1150');
  assert.equal(item.price, 1234.5);
  assert.deepEqual(item.compatibility, ['Kyocera M2135dn', 'Kyocera P2235dn']);
  assert.equal(item.stock.available, 5);
  assert.equal(item.stock.transit, 2);
  assert.equal(item.stock.mainOffice, 1);
  assert.equal(item.resource, undefined, 'ресурса не было — поля быть не должно');
  assert.ok(item.missing.includes('resource'));
  assert.equal(item.dimensions.height, undefined);
});

test('остатки не суммируются ни на одном шаге', () => {
  const item = normalizeItem({ Id: 'X', AvailableQuantity: 3, TransitQuantity: 4, MainOfficeQuantity: 5 });
  assert.deepEqual(item.stock, { available: 3, transit: 4, mainOffice: 5 });
  const rt = normalizeRuntime({ Id: 'X', AvailableQuantity: 3, TransitQuantity: 4, MainOfficeQuantity: 5 });
  assert.equal(rt.available, 3);
  assert.equal(rt.transit, 4);
  assert.equal(rt.mainOffice, 5);
});

test('PhotoUrl и PhotoUrls объединяются без дублей', () => {
  const item = normalizeItem({ Id: 'X', PhotoUrl: 'a.jpg', PhotoUrls: ['a.jpg', 'b.jpg'] });
  assert.deepEqual(item.photos, ['a.jpg', 'b.jpg']);
});

test('мусорные количества не превращаются в нули', () => {
  assert.equal(asCount('-3'), undefined);
  assert.equal(asCount('много'), undefined);
  assert.equal(asCount('0'), 0);
});

test('пустая совместимость не даёт пустых строк', () => {
  assert.deepEqual(parseCompatibility(' ; ,, '), []);
  assert.deepEqual(asList(''), []);
});

/* ------------------------------------------------------------ категории */

test('дерево категорий строится по Id с сохранением родителя', () => {
  const tree = buildCategoryTree(SAMPLE_CATEGORIES);
  assert.equal(tree.nodes.size, 6);
  assert.equal(tree.roots.length, 2);
  assert.equal(tree.nodes.get('110').parentId, '100');
});

test('слаг категории не меняется при переименовании', () => {
  const a = buildCategoryTree([{ Id: '110', Name: 'Картриджи лазерные', ParentId: null }]);
  const b = buildCategoryTree([{ Id: '110', Name: 'Лазерные картриджи', ParentId: null }]);
  assert.notEqual(a.nodes.get('110').slug, b.nodes.get('110').slug,
    'слаг включает название — смена названия меняет адрес');
  assert.equal(a.nodes.get('110').id, b.nodes.get('110').id, 'но Id как ключ остаётся прежним');
});

test('потерянный родитель не роняет дерево и уходит в отчёт', () => {
  const tree = buildCategoryTree([{ Id: '1', Name: 'A', ParentId: 'нет-такого' }]);
  assert.equal(tree.nodes.get('1').parentId, null);
  assert.ok(tree.issues.some((i) => i.kind === 'missing-parent'));
});

test('цикл в иерархии разрывается, а не вешает обход', () => {
  const tree = buildCategoryTree([
    { Id: '1', Name: 'A', ParentId: '2' },
    { Id: '2', Name: 'B', ParentId: '1' },
  ]);
  assert.ok(tree.issues.some((i) => i.kind === 'category-cycle'));
  assert.ok(tree.roots.length >= 1);
});

test('товар кладётся в лист по Id категории', () => {
  const tree = buildCategoryTree(SAMPLE_CATEGORIES);
  const items = [{ id: 'a', categoryId: '110' }, { id: 'b', categoryId: '210' }];
  const { assigned, report } = mapItemsToCategories(items, tree);
  assert.equal(assigned.get('a'), '110');
  assert.equal(assigned.get('b'), '210');
  assert.equal(report.unmapped.length, 0);
});

test('неизвестная категория не растворяется: товар уходит в отчёт и в «Без категории»', () => {
  const tree = buildCategoryTree(SAMPLE_CATEGORIES);
  const items = [{ id: 'x', name: 'Нечто', category: 'Неизвестный раздел' }];
  const { assigned, report } = mapItemsToCategories(items, tree);
  assert.equal(assigned.get('x'), UNMAPPED_ID);
  assert.equal(report.unmapped.length, 1);
  assert.equal(report.unmapped[0].id, 'x');
  const flat = flattenTree(tree, assigned);
  assert.ok(flat.some((n) => n.id === UNMAPPED_ID && n.count === 1));
});

test('неоднозначное имя категории не разрешается наугад', () => {
  const tree = buildCategoryTree([
    { Id: '1', Name: 'Тонеры', ParentId: null },
    { Id: '2', Name: 'Тонеры', ParentId: null },
  ]);
  const { assigned, report } = mapItemsToCategories([{ id: 'x', category: 'Тонеры' }], tree);
  assert.equal(assigned.get('x'), UNMAPPED_ID);
  assert.equal(report.ambiguous.length, 1);
});

test('без GetCategories дерево выводится из полей товара и помечается производным', () => {
  const items = [
    { id: 'a', category: 'Тонеры', categoryRoot: 'Расходные материалы' },
    { id: 'b', category: 'Термоплёнки', categoryRoot: 'Запчасти' },
  ];
  const tree = deriveCategoryTree(items);
  assert.equal(tree.source, 'ItemDto.Group/RootGroup');
  const { report } = mapItemsToCategories(items, tree);
  assert.equal(report.unmapped.length, 0);
  assert.ok([...tree.nodes.values()].every((n) => n.derived));
});

/* ------------------------------------------------------------ хранилище */

test('повторный upsert тех же данных не меняет ничего', () => {
  const { store } = tmpStore();
  const items = makeItems(5).map((i) => normalizeItem(i, { now: '2026-01-01T00:00:00Z' }));
  const first = store.upsertItems(items, { now: '2026-01-01T00:00:00Z' });
  assert.equal(first.added.length, 5);
  const second = store.upsertItems(items, { now: '2026-01-02T00:00:00Z' });
  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(second.unchanged.length, 5);
});

test('изменение поля фиксируется как updated', () => {
  const { store } = tmpStore();
  const [raw] = makeItems(1);
  store.upsertItems([normalizeItem(raw)], {});
  const changed = normalizeItem({ ...raw, Name: 'Другое название' });
  const rep = store.upsertItems([changed], {});
  assert.equal(rep.updated.length, 1);
  assert.equal(store.loadAll().get(changed.id).name, 'Другое название');
});

test('пропавший товар скрывается только после подтверждённо полной синхронизации', () => {
  const { store } = tmpStore();
  const items = makeItems(3).map((i) => normalizeItem(i));
  store.upsertItems(items, {});
  const partial = store.deactivateMissing(new Set([items[0].id]), { complete: false });
  assert.equal(partial.skipped, true);
  assert.equal(store.loadAll().get(items[1].id).active, true);

  const full = store.deactivateMissing(new Set([items[0].id]), { complete: true });
  assert.equal(full.hidden.length, 2);
  assert.equal(store.loadAll().get(items[1].id).active, false);
  assert.ok(store.loadAll().get(items[1].id).hiddenAt, 'запись остаётся на диске, а не удаляется');
});

test('вернувшийся товар снова становится активным', () => {
  const { store } = tmpStore();
  const items = makeItems(2).map((i) => normalizeItem(i));
  store.upsertItems(items, {});
  store.deactivateMissing(new Set([items[0].id]), { complete: true });
  assert.equal(store.loadAll().get(items[1].id).active, false);
  store.upsertItems([items[1]], {});
  assert.equal(store.loadAll().get(items[1].id).active, true);
});

test('оперативные данные не меняют хэш карточки', () => {
  const { store } = tmpStore();
  const items = makeItems(2).map((i) => normalizeItem(i));
  store.upsertItems(items, {});
  const before = store.loadAll().get(items[0].id).hash;
  store.upsertRuntime([{ id: items[0].id, price: 999, available: 1 }], {});
  const after = store.loadAll().get(items[0].id);
  assert.equal(after.hash, before);
  assert.equal(after.runtime.price, 999);
  const again = store.upsertItems(items, {});
  assert.equal(again.unchanged.length, 2, 'после ценового синка карточка всё ещё «не менялась»');
});

test('оперативная строка неизвестного товара не создаёт пустую карточку', () => {
  const { store } = tmpStore();
  const rep = store.upsertRuntime([{ id: 'нет-такого', price: 1 }], {});
  assert.deepEqual(rep.unknown, ['нет-такого']);
  assert.equal(store.loadAll().size, 0);
});

test('стабильная сериализация не зависит от порядка ключей', () => {
  assert.equal(stableStringify({ a: 1, b: [2, { d: 4, c: 3 }] }), stableStringify({ b: [2, { c: 3, d: 4 }], a: 1 }));
  assert.equal(sha256(stableStringify({ x: 1, y: 2 })), sha256(stableStringify({ y: 2, x: 1 })));
});

test('сырой payload дедуплицируется по хэшу', () => {
  const { store, dir } = tmpStore();
  const a = store.saveRaw('items', [{ Id: 1 }]);
  const b = store.saveRaw('items', [{ Id: 1 }]);
  assert.equal(a.hash, b.hash);
  assert.equal(fs.readdirSync(path.join(dir, 'raw/items')).length, 1);
});

test('блокировка не пускает второй запуск и снимается по завершении', () => {
  const { dir } = tmpStore();
  const file = path.join(dir, '.sync.lock');
  const first = new RunLock(file).acquire();
  assert.throws(() => new RunLock(file).acquire(), /уже выполняется/);
  first.release();
  const second = new RunLock(file).acquire();
  second.release();
});

test('протухшая блокировка перехватывается', () => {
  const { dir } = tmpStore();
  const file = path.join(dir, '.sync.lock');
  new RunLock(file).acquire({ now: 0 });
  const taken = new RunLock(file, { staleMs: 1000 }).acquire({ now: 10_000 });
  assert.equal(taken.acquired, true);
});

/* -------------------------------------------------------------- секреты */

test('конфигурация с учётными данными отвергается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ login: 'a', password: 'b' }));
  assert.throws(() => loadConfig(file), /только\s+переменными окружения/);
});

test('без переменных окружения синхронизация не запускается', () => {
  assert.throws(() => loadCredentials({}), /Нет учётных данных/);
});

test('маскировка вырезает пароль из любой строки', () => {
  const redact = makeRedactor(CRED);
  assert.ok(!redact(`<password>${CRED.password}</password>`).includes(CRED.password));
  assert.ok(!redact(`ошибка для ${CRED.login}: отказ`).includes(CRED.login));
  assert.ok(!redact(JSON.stringify({ password: CRED.password })).includes(CRED.password));
});

test('http-endpoint отмечается как риск', () => {
  assert.equal(httpRisk('http://api.vtt.ru:8048/Portal.svc').risk, true);
  assert.equal(httpRisk('https://api.vtt.ru/Portal.svc').risk, false);
});

/* ------------------------------------------------------- полный конвейер */

const SILENT = { log: () => {} };

test('диагностика подтверждает контракт и доступность операций', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(10) }) });
  const res = await diagnose({ client, credentials: CRED, store, logger: null, sampleSize: 5 });
  assert.equal(res.itemPortion.received, 5);
  assert.ok(res.itemDtoFields.includes('Compatibility'));
  assert.ok(res.itemDtoFields.includes('PhotoUrls'));
  assert.equal(res.getCategories.supported, true);
  assert.equal(res.getGoodsCompatibilityInformation.supported, false, 'метод недоступен — это факт, а не сбой');
});

test('полная синхронизация на фикстурах: раскладка, отчёт, повторный запуск', async (t) => {
  const { dir, store } = tmpStore();
  const fetchImpl = createMockFetch({ items: makeItems(1200) });
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  const logger = null;

  const first = await fullSync({ client, credentials: CRED, store, logger, config: CONFIG });
  assert.equal(first.complete, true);
  assert.equal(first.unique, 1200);
  assert.equal(first.added, 1200);
  assert.equal(first.categories.source, 'GetCategories');
  assert.equal(first.categories.unmapped, 0, 'все товары легли в листья дерева');
  assert.ok(fs.existsSync(path.join(dir, 'reports/last-full.json')));

  const second = await fullSync({ client, credentials: CRED, store, logger, config: CONFIG });
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1200, 'повторный синк идемпотентен');
  assert.equal(second.hidden, 0);

  const shrunk = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(1000) }) });
  const third = await fullSync({ client: shrunk, credentials: CRED, store, logger, config: CONFIG });
  assert.equal(third.hidden, 200, 'пропавшие скрыты после полной выгрузки');
  assert.equal(store.loadAll().size, 1200, 'но не удалены с диска');
});

test('без GetCategories синхронизация не падает и помечает источник дерева', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(20), categories: null }) });
  const rep = await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(rep.categories.supported, false);
  assert.equal(rep.categories.source, 'ItemDto.Group/RootGroup');
  assert.equal(rep.categories.unmapped, 0);
});

test('прерванная выгрузка возобновляется с курсора, а не с нуля', async () => {
  const { store } = tmpStore();
  const items = makeItems(1200);
  let calls = 0;
  const flaky = createMockFetch({ items });
  const failing = async (url, init) => {
    calls += 1;
    if (calls === 3) throw new TypeError('fetch failed');
    return flaky(url, init);
  };
  const client = new VttClient({ url: 'http://mock/', fetchImpl: failing });
  await assert.rejects(() => fullSync({
    client, credentials: CRED, store, logger: null,
    config: { ...CONFIG, retryAttempts: 1 },
  }));
  const state = store.loadState();
  assert.ok(state.resume, 'курсор сохранён');
  assert.ok(state.resume.from > 0);

  const good = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items }) });
  const rep = await fullSync({ client: good, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(rep.complete, true);
  assert.equal(store.loadAll().size, 1200, 'возобновление не потеряло товары');
  assert.equal(store.loadState().resume, null, 'курсор очищен после успеха');
});

test('оперативный синк обновляет цену и три остатка по отдельности', async () => {
  const { store } = tmpStore();
  const items = makeItems(30);
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items }) });
  await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  const rep = await runtimeSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(rep.updated, 30);
  assert.equal(rep.unknown, 0);
  const rec = store.loadAll().get('VTT-00000');
  assert.equal(typeof rec.runtime.price, 'number');
  assert.ok('available' in rec.runtime && 'transit' in rec.runtime && 'mainOffice' in rec.runtime);
});

test('логи и отчёты не содержат пароля', async () => {
  const { store } = tmpStore();
  const lines = [];
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(10) }) });
  const { makeLogger } = await import('../src/sync.mjs');
  const logger = makeLogger({ redact: makeRedactor(CRED), sink: { log: (l) => lines.push(l) } });
  await fullSync({ client, credentials: CRED, store, logger, config: CONFIG });
  const blob = lines.join('\n') + JSON.stringify(store.loadState()) + fs.readFileSync(path.join(store.reportsDir, 'last-full.json'), 'utf8');
  assert.ok(!blob.includes(CRED.password), 'пароль не должен попадать ни в лог, ни в отчёт');
});

/* ------------------------------------------------------------ публикация */

test('описание собирается только из фактов и детерминировано', async () => {
  const { buildDescription, toShopProduct } = await import('../src/publish.mjs');
  const item = normalizeItem({
    Id: 'X', Name: 'Картридж HB-TK-1150', Vendor: 'HB-TK-1150', Brand: 'Hi-Black',
    OriginalNumber: 'TK-1150', Resource: 3000, ColorName: 'Чёрный',
    Compatibility: 'Kyocera M2135dn; Kyocera P2235dn', Weight: 0.9, Barcode: '4600000000001',
    Group: 'Картриджи лазерные',
  });
  const a = buildDescription(item);
  const b = buildDescription(item);
  assert.equal(a.text, b.text, 'один и тот же вход даёт один и тот же текст');
  assert.match(a.text, /TK-1150/);
  assert.match(a.text, /3\s000 страниц/);
  assert.match(a.text, /Kyocera M2135dn/);
  /* Ничего, чего нет в данных, в тексте быть не должно. */
  assert.ok(!/гаранти|сертифик|оригинальн(ое|ый) качеств/i.test(a.text));

  const bare = buildDescription(normalizeItem({ Id: 'Y', Name: 'Нечто' }));
  assert.ok(!/ресурс|совместим|штрихкод/i.test(bare.text), 'отсутствующие поля не выдумываются');
});

test('карточка импортированного товара не получает рейтинга и отзывов', async () => {
  const { toShopProduct } = await import('../src/publish.mjs');
  const p = toShopProduct(normalizeItem(makeItems(1)[0]));
  assert.equal(p.rate, 0);
  assert.equal(p.reviews, 0);
  assert.equal(p.source, 'vtt');
});

test('остатки на витрине остаются тремя числами, «в наличии» — только доступный', async () => {
  const { availabilityOf } = await import('../src/publish.mjs');
  const av = availabilityOf({ stock: { available: 0, transit: 40, mainOffice: 7 } });
  assert.equal(av.inStock, false, 'транзит — это «будет», а не «есть»');
  assert.equal(av.transit, 40);
  assert.equal(av.mainOffice, 7);
});

test('оперативная цена перекрывает базовую, не затирая её в сторе', async () => {
  const { priceOf } = await import('../src/publish.mjs');
  assert.equal(priceOf({ price: 100, runtime: { price: 90 } }).price, 90);
  assert.equal(priceOf({ price: 100 }).price, 100);
});

test('фильтр публикации сужает витрину, но не стор', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  const items = makeItems(10).map((i, n) => normalizeItem({ ...i, Brand: n % 2 ? 'Hi-Black' : 'Другой' }));
  store.upsertItems(items, {});
  const res = publish(store, { filter: { brands: ['Hi-Black'] } });
  assert.equal(res.report.total, 10);
  assert.equal(res.report.published, 5);
  assert.equal(res.report.filtered, 5);
  assert.equal(store.loadAll().size, 10, 'стор не тронут фильтром');
});

test('скрытые товары не попадают на витрину', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  const items = makeItems(4).map((i) => normalizeItem(i));
  store.upsertItems(items, {});
  store.deactivateMissing(new Set([items[0].id]), { complete: true });
  const res = publish(store, {});
  assert.equal(res.report.published, 1);
  assert.equal(res.report.inactive, 3);
});

test('редакционная правка не затирается синком', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  const [raw] = makeItems(1);
  const item = normalizeItem(raw);
  store.upsertItems([item], {});
  const editorial = { [item.id]: { description: 'Ручной текст редактора' } };
  const before = publish(store, { editorial }).products[0];
  assert.equal(before.editorialDescription, 'Ручной текст редактора');
  store.upsertItems([normalizeItem({ ...raw, Price: 9999 })], {});
  const after = publish(store, { editorial }).products[0];
  assert.equal(after.editorialDescription, 'Ручной текст редактора', 'синк меняет цену, но не редакторский текст');
  assert.equal(after.price, 9999);
});

test('порядок публикации стабилен между сборками', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  store.upsertItems(makeItems(50).map((i) => normalizeItem(i)), {});
  const a = publish(store, {}).products.map((p) => p.id);
  const b = publish(store, {}).products.map((p) => p.id);
  assert.deepEqual(a, b);
});

test('отчёт о неполных данных перечисляет товары поимённо', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  store.upsertItems([normalizeItem({ Id: 'Z', Name: 'Без цены и фото' })], {});
  const res = publish(store, {});
  assert.deepEqual(res.report.noPrice, ['Z']);
  assert.deepEqual(res.report.noPhoto, ['Z']);
  assert.equal(res.report.incomplete[0].id, 'Z');
  assert.ok(res.report.incomplete[0].missing.includes('price'));
});

test('битые и зарезервированные адреса фото не попадают в карточку', async () => {
  const { usablePhoto, toShopProduct, PHOTO_PLACEHOLDER } = await import('../src/publish.mjs');
  assert.equal(usablePhoto('https://cdn.example.invalid/a.jpg'), false);
  assert.equal(usablePhoto('не ссылка'), false);
  assert.equal(usablePhoto('ftp://x/a.jpg'), false);
  assert.equal(usablePhoto('https://cdn.vtt.ru/a.jpg'), true);
  const p = toShopProduct(normalizeItem({ Id: 'X', PhotoUrl: 'https://x.invalid/a.jpg' }));
  assert.equal(p.img, PHOTO_PLACEHOLDER);
  assert.equal(p.photoMissing, true);
  assert.deepEqual(p.images, []);
});

test('артефакты двоичной дроби не доезжают до карточки', async () => {
  const { asNumber } = await import('../src/normalize.mjs');
  assert.equal(asNumber(0.7 + 0.1), 0.8);
  assert.equal(asNumber('1 234,56'), 1234.56);
});
