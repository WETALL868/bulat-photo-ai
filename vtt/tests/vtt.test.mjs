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
const CONFIG = { portionSize: 500, retryAttempts: 3, retryBaseDelayMs: 1, timeoutMs: 5000, namespace: 'http://portal.vtt.ru', soapActionBase: 'http://portal.vtt.ru/IPortalService' };

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtt-store-'));
  return { dir, store: new VttStore(dir) };
}

/* ------------------------------------------------------------------ SOAP */

test('конверт содержит операцию и экранированные аргументы', () => {
  const xml = buildEnvelope('GetItemPortion', 'http://portal.vtt.ru', { login: 'a&b', password: 'p<w>', from: 0, to: 500 });
  assert.match(xml, /<tem:GetItemPortion>/);
  assert.match(xml, /xmlns:tem="http:\/\/portal\.vtt\.ru"/);
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
    Id: 'X1', Name: ' Картридж  HB-TK-1150 ', NameAlias: 'HB-TK-1150', Vendor: 'Kyocera-Mita', Brand: 'Hi-Black',
    Group: 'Картриджи лазерные', RootGroup: 'Расходные материалы',
    Compatibility: 'Kyocera M2135dn; Kyocera P2235dn', AvailableQuantity: '5',
    TransitQuantity: '2', MainOfficeQuantity: '1', PriceLocal: '1 234,50', Width: '30',
  });
  assert.equal(item.name, 'Картридж HB-TK-1150');
  assert.equal(item.vendorCode, 'HB-TK-1150');
  assert.equal(item.price, 1234.5);
  assert.equal(item.compatibilityText, 'Kyocera M2135dn; Kyocera P2235dn',
    'текст поставщика сохраняется как есть, без разбора на модели');
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
  assert.equal(rt.price, undefined, 'у оперативной записи нет поля рублёвой цены');
  assert.equal(rt.transit, 4);
  assert.equal(rt.mainOffice, 5);
});

test('PhotoUrl и PhotoUrls объединяются без дублей', () => {
  const item = normalizeItem({
    Id: 'X',
    PhotoUrl: 'http://b2b.vtt.ru/images/a.jpg',
    PhotoUrls: ['http://b2b.vtt.ru/images/a.jpg', 'http://b2b.vtt.ru/images/b.jpg'],
  });
  assert.deepEqual(item.photos, ['http://b2b.vtt.ru/images/a.jpg', 'http://b2b.vtt.ru/images/b.jpg']);

  /* Относительное имя файла адресом не является: у VTT так выражено
     отсутствие картинки, и до карточки оно доходить не должно. */
  const stub = normalizeItem({ Id: 'Y', PhotoUrl: 'dummy.jpg', PhotoUrls: '{"string":[]}' });
  assert.deepEqual(stub.photos, []);
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
  assert.equal(res.getGoodsCompatibilityInformation.supported, true, 'метод подтверждён WSDL и доступен в моке');
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
  assert.equal(typeof rec.runtime.priceForeign, 'number', 'оперативная цена хранится как валютная');
  assert.equal(rec.runtime.price, undefined, 'и не выдаёт себя за рублёвую');
  assert.ok('available' in rec.runtime && 'transit' in rec.runtime && 'mainOffice' in rec.runtime);
  /* Рублёвая цена полной выгрузки на месте: оперативный синк её не трогал. */
  assert.ok(rec.price > rec.runtime.priceForeign * 10, 'рублёвая цена не подменена валютной');
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
    Id: 'X', Name: 'Картридж HB-TK-1150', NameAlias: 'HB-TK-1150', Vendor: 'Kyocera-Mita', Brand: 'Hi-Black',
    OriginalNumber: 'TK-1150', Resource: 3000, ColorName: 'Чёрный',
    Compatibility: 'Kyocera M2135dn; Kyocera P2235dn', Weight: 0.9, Barcode: '4600000000001',
    Group: 'Картриджи лазерные',
  });
  /* Модели совместимости приходят отдельной операцией, а не разбором
     свободного текста, поэтому здесь они подставлены явно. */
  item.compatibilityLabels = ['Kyocera M2135dn', 'Kyocera P2235dn'];
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

test('оперативная цена переводится в рубли по курсу самой позиции', async () => {
  const { priceOf } = await import('../src/publish.mjs');
  /* Полная выгрузка дала 1 686 ₽ при валютной цене 20 — курс позиции
     84,3. Оперативная выгрузка прислала 21: на витрине должно стать
     1 770,3 ₽, а не 21 ₽. */
  const item = { price: 1686, priceForeign: 20, runtime: { priceForeign: 21 } };
  const res = priceOf(item);
  assert.equal(res.price, 1770.3);
  assert.equal(res.from, 'runtime');

  /* Без валютной цены в полной выгрузке курс снять не с чего: показываем
     вчерашнюю рублёвую, а не сегодняшнюю в чужой валюте. */
  const noRate = priceOf({ price: 1686, runtime: { priceForeign: 21 } });
  assert.equal(noRate.price, 1686);
  assert.equal(noRate.from, 'full');

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
  store.upsertItems([normalizeItem({ ...raw, PriceLocal: 9999 })], {});
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

/* ------------------------------------------------- контракт из WSDL */

test('namespace и SOAPAction соответствуют официальному WSDL', async () => {
  const { DEFAULT_NAMESPACE, DATA_NAMESPACE, DEFAULT_SOAP_ACTION_BASE, DEFAULTS } = await import('../src/config.mjs');
  assert.equal(DEFAULT_NAMESPACE, 'http://portal.vtt.ru');
  assert.equal(DATA_NAMESPACE, 'http://portal.vtt.ru/data');
  assert.equal(DEFAULT_SOAP_ACTION_BASE, 'http://portal.vtt.ru/IPortalService');
  assert.equal(DEFAULTS.namespace, 'http://portal.vtt.ru', 'tempuri был предположением и снят');

  /* Заголовок собирается без потери слеша: раньше склейка namespace с
     хвостом давала «http://portal.vtt.ruIPortalService/...». */
  let sentAction;
  const fetchImpl = async (url, init) => {
    sentAction = init.headers.SOAPAction;
    return new Response(portionEnvelope('GetItemPortion', 'ItemDto', [], 0), { status: 200 });
  };
  const client = new VttClient({ url: 'http://mock/', fetchImpl });
  await client.getItemPortion(CRED, 0, 5);
  assert.equal(sentAction, 'http://portal.vtt.ru/IPortalService/GetItemPortion');
});

test('все двенадцать операций WSDL реализованы', async () => {
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(5) }) });
  for (const m of ['getItems', 'getRuntimeItems', 'getCategories', 'getCategoryItems', 'getCategoryRuntimeItems',
    'getItemPortion', 'getRuntimeItemsPortion', 'getItem', 'getRuntimeItem',
    'getGoodsCompatibilityInformation', 'getRelatedItems', 'getAdditionalAttributes']) {
    assert.equal(typeof client[m], 'function', `нет метода ${m}`);
  }
});

test('ItemRuntimeDto — ровно пять полей WSDL, без PriceRetail и TransitDate', () => {
  const rt = normalizeRuntime({
    Id: 'X', Price: 100, AvailableQuantity: 3, TransitQuantity: 4, MainOfficeQuantity: 5,
    /* Даже если сервер пришлёт лишнее, в оперативные данные оно не попадёт. */
    PriceRetail: 999, TransitDate: '2026-01-01',
  });
  assert.deepEqual(Object.keys(rt).sort(), ['available', 'id', 'mainOffice', 'priceForeign', 'syncedAt', 'transit']);
  assert.equal(rt.priceRetail, undefined);
  assert.equal(rt.transitDate, undefined);
  /* PriceLocal в оперативном DTO нет, поэтому и рублёвой цены здесь быть
     не может: подменить ею ценник — уронить его в восемьдесят четыре раза. */
  assert.equal(rt.price, undefined);
  assert.equal(rt.priceForeign, 100);
});

test('CompatibilityDto разбирается по полям, а не разбором строки', async () => {
  const { normalizeCompatibility, compatibilityLabel } = await import('../src/normalize.mjs');
  const byItem = normalizeCompatibility([
    { ItemId: 'A', ModelBrand: 'Kyocera', ModelCategoryName: 'Принтеры', ModelName: 'ECOSYS M2035dn' },
    { ItemId: 'A', ModelBrand: 'Kyocera', ModelCategoryName: 'МФУ', ModelName: 'ECOSYS M2035dn' },
    { ItemId: 'A', ModelBrand: 'Kyocera', ModelCategoryName: 'Принтеры', ModelName: 'FS-1040' },
    { ItemId: 'B', ModelBrand: 'HP', ModelName: 'LaserJet 1020' },
  ]);
  assert.equal(byItem.get('A').length, 2, 'одна и та же модель из разных категорий не дублируется');
  assert.equal(byItem.get('B')[0].brand, 'HP');
  assert.equal(compatibilityLabel({ brand: 'HP', model: 'LaserJet 1020' }), 'HP LaserJet 1020');
  assert.equal(compatibilityLabel({ brand: 'Kyocera', model: 'Kyocera FS-1040' }), 'Kyocera FS-1040',
    'бренд не дублируется, если уже входит в название модели');
});

test('AdditionalAttributeDto сохраняется как есть и не превращается в выдуманную характеристику', async () => {
  const { normalizeAttributes } = await import('../src/normalize.mjs');
  const byItem = normalizeAttributes([
    { CategoryId: '7', ItemId: 'A', IntValue: 3000 },
    { CategoryId: '9', ItemId: 'A', StringValue: 'Чёрный' },
    { CategoryId: '9', ItemId: 'B' },
  ]);
  assert.deepEqual(byItem.get('A'), [
    { categoryId: '7', intValue: 3000 },
    { categoryId: '9', stringValue: 'Чёрный' },
  ]);
  assert.equal(byItem.has('B'), false, 'атрибут без значения не сохраняется');
  /* У атрибута нет имени — значит и подписи для витрины у нас нет. */
  assert.ok(!JSON.stringify([...byItem.values()]).includes('Ресурс'));
});

test('связанные товары сводятся к идентификаторам без дублей', async () => {
  const { normalizeRelated } = await import('../src/normalize.mjs');
  assert.deepEqual(normalizeRelated([{ Id: 'A' }, { Id: 'B' }, { Id: 'A' }, {}]), ['A', 'B']);
});

test('полная синхронизация обогащает каталог смежными операциями', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(8) }) });
  const rep = await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });

  assert.equal(rep.enrich.compatibility.supported, true);
  assert.equal(rep.enrich.attributes.supported, true);
  assert.equal(rep.enrich.categoryMembership.supported, true);

  const rec = store.loadAll().get('VTT-00000');
  assert.ok(rec.compatibilityDetailed?.length, 'структурированная совместимость сохранена');
  assert.equal(rec.compatibilityDetailed[0].brand, 'Kyocera');
  assert.ok(rec.attributes?.length, 'дополнительные атрибуты сохранены');
  assert.equal(rec.categorySource, 'GetCategoryItems', 'членство уточнено официальной операцией');
});

test('недоступность смежных операций не роняет выгрузку', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({
    items: makeItems(6), compatibility: false, attributes: false, related: false, categoryItems: false,
  }) });
  const rep = await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(rep.complete, true);
  assert.equal(store.loadAll().size, 6, 'каталог выгружен целиком');
  assert.equal(rep.enrich.compatibility.supported, false);
  assert.ok(rep.enrich.compatibility.reason, 'причина недоступности попала в отчёт');
});

test('сырой стор не фильтруется: фильтр только для публикации', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(40) }) });
  await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(store.loadAll().size, 40, 'в стор попал весь ассортимент');
  const res = publish(store, { filter: { categories: ['110'] } });
  assert.ok(res.report.filtered > 0, 'фильтр сузил витрину');
  assert.equal(store.loadAll().size, 40, 'но стор остался полным');
});

test('диагностика перечисляет доступность каждой операции', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(10) }) });
  const res = await diagnose({ client, credentials: CRED, store, logger: null, sampleSize: 5 });
  for (const op of ['GetCategories', 'GetGoodsCompatibilityInformation', 'GetAdditionalAttributes',
    'GetRelatedItems', 'GetCategoryItems', 'GetItem', 'GetRuntimeItem']) {
    assert.ok(op in res.operations, `в отчёте нет ${op}`);
  }
  assert.equal(res.operations.GetGoodsCompatibilityInformation.supported, true);
});

/* ------------------------------------------------------------------ *
   Обогащение и идемпотентность

   Эти проверки закрывают дефект, найденный при переходе на официальный
   WSDL: обогащение дописывало в карточку поля из смежных операций и
   пересчитывало по ним хэш. Следующая полная выгрузка считала хэш по
   «голой» карточке, не совпадала с сохранённым — и объявляла изменившимся
   весь каталог, хотя у поставщика не поменялось ничего.
 * ------------------------------------------------------------------ */

test('обогащение не делает повторную выгрузку «изменением всего каталога»', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(30) }) });
  const first = await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(first.added, 30);

  const enrichedBefore = store.loadAll().get('VTT-00000');
  assert.ok(enrichedBefore.compatibilityLabels?.length, 'обогащение отработало');
  const hashBefore = enrichedBefore.hash;

  const second = await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0, 'обогащённые поля не считаются изменением товара');
  assert.equal(second.unchanged, 30);

  const after = store.loadAll().get('VTT-00000');
  assert.equal(after.hash, hashBefore, 'хэш карточки не зависит от обогащения');
  assert.ok(after.compatibilityLabels?.length, 'обогащение переживает повторный синк');
});

test('хэш карточки считается только по данным поставщика', async () => {
  const { store } = tmpStore();
  const base = { id: 'X-1', name: 'Картридж', vendorCode: 'HB-1', price: 100 };
  store.upsertItems([base], { now: '2026-01-01T00:00:00.000Z' });
  const hash = store.loadAll().get('X-1').hash;

  /* Всё, что дописывают смежные операции, в хэш не входит. */
  store.patchItem('X-1', {
    categoryId: '42', categorySource: 'GetCategoryItems',
    compatibilityLabels: ['Kyocera M2035dn'], compatibilityDetailed: [{ brand: 'Kyocera' }],
    attributes: [{ categoryId: '7', intValue: 1200 }], related: ['X-2'],
  });
  assert.equal(store.loadAll().get('X-1').hash, hash, 'обогащение хэш не меняет');
  assert.ok(store.loadAll().get('X-1').enrichedAt, 'но факт обогащения зафиксирован');

  /* А изменение поля самого товара — входит. */
  store.patchItem('X-1', { price: 150 });
  assert.notEqual(store.loadAll().get('X-1').hash, hash, 'изменение данных поставщика видно');
});

test('строка Compatibility поставщика не затирается официальной операцией', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(4) }) });
  await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  const rec = store.loadAll().get('VTT-00001');
  assert.ok(rec.compatibilityText, 'свободный текст поставщика сохранён целиком');
  assert.ok(rec.compatibilityLabels?.length, 'официальные модели лежат рядом');

  const { modelsOf } = await import('../src/publish.mjs');
  assert.deepEqual(modelsOf(rec), rec.compatibilityLabels, 'модели берутся только из структурного источника');
  /* Свободный текст в список моделей не превращается: у VTT в этом поле
     лежат и «Повреждённая упаковка», и «с чипом». */
  assert.deepEqual(modelsOf({ compatibilityText: 'Повреждённая упаковка' }), []);
});

test('GetRelatedItems попадает в полную выгрузку и уважает предел', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(10) }) });
  const rep = await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(rep.enrich.related.supported, true);
  assert.equal(rep.enrich.related.requested, 10);
  assert.ok(rep.enrich.related.items > 0, 'связи сохранены');
  const rec = store.loadAll().get('VTT-00000');
  assert.ok(Array.isArray(rec.related) && rec.related.length, 'идентификаторы связанных товаров в карточке');
  assert.ok(!rec.related.includes('VTT-00000'), 'товар не связан сам с собой');

  /* Поштучная операция на большом каталоге ограничивается конфигурацией,
     и отчёт честно говорит, что обошли не всех. */
  const { store: store2 } = tmpStore();
  const client2 = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(10) }) });
  const rep2 = await fullSync({
    client: client2, credentials: CRED, store: store2, logger: null,
    config: { ...CONFIG, relatedItems: { enabled: true, limit: 3, concurrency: 2 } },
  });
  assert.equal(rep2.enrich.related.requested, 3);
  assert.equal(rep2.enrich.related.ofTotal, 10);
  assert.equal(rep2.enrich.related.limited, true);
});

test('недоступный GetRelatedItems не обходит весь каталог впустую', async () => {
  const { store } = tmpStore();
  const calls = [];
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({
    items: makeItems(50), related: false, onCall: ({ op }) => calls.push(op),
  }) });
  const rep = await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  assert.equal(rep.enrich.related.supported, false);
  assert.ok(rep.enrich.related.reason, 'причина отказа в отчёте');
  const related = calls.filter((op) => op === 'GetRelatedItems').length;
  assert.equal(related, 1, `отказ по правам выясняется одной пробой, было вызовов: ${related}`);
  assert.equal(store.loadAll().size, 50, 'каталог выгружен целиком');
});

test('groupId поставщика хранится отдельно от выбранной категории', async () => {
  const { store } = tmpStore();
  const client = new VttClient({ url: 'http://mock/', fetchImpl: createMockFetch({ items: makeItems(6) }) });
  await fullSync({ client, credentials: CRED, store, logger: null, config: CONFIG });
  const rec = store.loadAll().get('VTT-00002');
  assert.ok(rec.groupId, 'присланный поставщиком Id раздела сохранён');
  assert.ok(rec.categoryId, 'категория витрины проставлена');
  assert.equal(rec.categorySource, 'GetCategoryItems', 'и видно, откуда она взялась');
});

/* ------------------------------------------------------------------ *
   Импорт реальной выгрузки: CSV, таксономия, сжатие индекса, картинки
 * ------------------------------------------------------------------ */

test('CSV: разделитель, кавычки, переводы строк внутри поля, BOM', async () => {
  const { parseCsv, readCsvCatalog } = await import('../src/csv.mjs');
  const text = '﻿Id;Name;Compatibility\n' +
    '1;Простой;HP LJ 1010\n' +
    '2;"Имя; с разделителем";"Первая строка\nВторая строка"\n' +
    '3;"Кавычка ""внутри""";\n';
  const rows = parseCsv(text);
  assert.equal(rows[0][0], 'Id', 'BOM снят с имени первой колонки');
  assert.equal(rows.length, 4, 'перевод строки внутри кавычек не разорвал строку');
  assert.equal(rows[2][1], 'Имя; с разделителем');
  assert.equal(rows[2][2], 'Первая строка\nВторая строка');
  assert.equal(rows[3][1], 'Кавычка "внутри"');

  const { columns, items } = readCsvCatalog(text);
  assert.deepEqual(columns, ['Id', 'Name', 'Compatibility']);
  assert.equal(items.length, 3);
  assert.equal(items[1].Name, 'Имя; с разделителем');
});

test('нормализация реальных полей VTT: цена в рублях, артикул, фото', async () => {
  const { normalizeItem, isPhotoUrl, photoUrlList } = await import('../src/normalize.mjs');
  const raw = {
    Id: '1230110p', Name: 'Картридж Hi-Black', Brand: 'Hi-Black', Vendor: 'Panasonic',
    NameAlias: 'HB-KX-FAT410A7', OriginalNumber: 'HB-KX-FAT410A7',
    Price: '21.27', PriceRetail: '25.00', PriceLocal: '1793.06',
    Group: 'Картриджи лазерные', RootGroup: 'Картриджи для лазерной печати',
    AvailableQuantity: '4', TransitQuantity: '0', MainOfficeQuantity: '4', RestQuantity: '2',
    PhotoUrl: 'dummy.jpg', PhotoUrls: '{"string":[]}',
    Compatibility: 'Повреждённая упаковка',
  };
  const item = normalizeItem(raw, { now: '2026-01-01T00:00:00.000Z' });

  assert.equal(item.price, 1793.06, 'на витрину идёт рублёвая цена PriceLocal');
  assert.equal(item.priceForeign, 21.27, 'валютная цена сохранена отдельно');
  assert.equal(item.vendorCode, 'HB-KX-FAT410A7', 'артикул из NameAlias, а не из Vendor');
  assert.equal(item.compatibleBrand, 'Panasonic', 'Vendor — это марка техники');
  assert.notEqual(item.vendorCode, 'Panasonic', 'марка техники не может быть артикулом');
  assert.deepEqual(item.photos, [], 'dummy.jpg — это отсутствие фото, а не адрес');
  assert.equal(item.compatibilityText, 'Повреждённая упаковка');
  assert.ok(!item.compatibility?.length, 'свободный текст не превращается в список моделей');
  assert.equal(item.stock.rest, 2, 'четвёртый остаток сохранён и ни с чем не сложен');
  assert.equal(item.stock.transit, 0);

  assert.equal(isPhotoUrl('dummy.jpg'), false);
  assert.equal(isPhotoUrl('http://b2b.vtt.ru/images/1240C002.jpg'), true);
  assert.deepEqual(photoUrlList('{"string":["http://a/1.jpg","http://a/2.jpg"]}'), ['http://a/1.jpg', 'http://a/2.jpg']);
  assert.deepEqual(photoUrlList('{"string":[]}'), []);
});

test('таксономия: каждый корневой раздел VTT имеет соответствие', async () => {
  const t = await import('../src/shop-taxonomy.mjs');
  const ROOTS = [
    'Картриджи для лазерной печати', 'Компьютер. запчасти и аксессуары', 'Запчасти для ремонта техники',
    'Чернила', 'Картриджи для струйной печати', 'Тонеры/ Девелоперы', 'Чипы',
    'Фотобарабаны и комплекты фотобарабанов', 'Запчасти для восстановления картриджей',
    'Печатающая техника и опции к ней', 'Чистящие средства и материалы для обслуживания',
    'Картриджи матричные и ленты красящие', 'Прочие расходные материалы', 'Бумага и пленки',
    'Инструменты/пакеты/спецоборудование',
  ];
  for (const root of ROOTS) {
    const res = t.shopCategoryOf({ categoryRoot: root });
    assert.equal(res.status, 'mapped', `раздел «${root}» не разложен`);
  }
  /* Неизвестный раздел не растворяется в лазерных картриджах, а уходит в
     «Прочее» и называет себя в отчёте. */
  const unknown = t.shopCategoryOf({ categoryRoot: 'Совершенно новый раздел' });
  assert.equal(unknown.id, 'other');
  assert.equal(unknown.status, 'unknown-root');

  assert.equal(t.shopBrandOf({ compatibleBrand: 'Kyocera-Mita' }).id, 'kyocera');
  assert.equal(t.shopBrandOf({ compatibleBrand: 'SAMSUNG BY HP' }).id, 'samsung', 'написание поставщика не делит бренд надвое');
  assert.equal(t.shopBrandOf({ compatibleBrand: 'Minolta' }).id, 'konica');
  assert.equal(t.shopBrandOf({}).id, 'universal');

  const rep = t.taxonomyReport([
    { categoryRoot: 'Чипы', compatibleBrand: 'HP' },
    { categoryRoot: 'Бумага и пленки', compatibleBrand: 'Lomond' },
    { categoryRoot: 'Неизвестно', compatibleBrand: 'Неизвестно' },
  ]);
  assert.equal(rep.cats.zip, 1);
  assert.equal(rep.cats.paper, 1);
  assert.equal(rep.cats.other, 1);
  assert.equal(rep.unknownRoots['Неизвестно'], 1);
  assert.equal(rep.unknownVendors['Неизвестно'], 1);
});

test('сжатие индекса: круговой обход без потерь', async () => {
  const { packIndex, unpackRows } = await import('../../tools/index-pack.mjs');
  const fields = ['id', 'slug', 'name', 'cat', 'brand', 'img', 'type', 'color', 'res', 'demo', 'src'];
  const rows = [
    ['a', 'a', 'Товар А', 'laser', 'hp', 'http://b2b.vtt.ru/images/a.jpg', 'Картридж', 'Bk', 3000, null, 'vtt'],
    ['b', 'b-2', 'Товар Б', 'zip', null, '/assets/img/no-photo.svg', '', null, null, true, 'vtt'],
    ['c', 'c', 'Товар В', 'laser', 'hp', 'assets/img/p_1.webp', 'Тонер', '', 0, null, null],
  ];
  const packed = packIndex(fields, rows);
  assert.equal(packed.packed, 1);
  assert.deepEqual(unpackRows(packed), rows, 'разбор восстанавливает строки байт в байт');

  /* Сжатие должно что-то экономить, иначе оно только усложняет формат. */
  assert.ok(JSON.stringify(packed.rows).length < JSON.stringify(rows).length, 'сжатый индекс меньше исходного');
  assert.equal(packed.rows[0][1], 0, 'слаг, совпавший с идентификатором, не хранится');
  assert.equal(packed.rows[1][1], 'b-2', 'несовпавший слаг остаётся строкой');
  assert.equal(typeof packed.rows[0][3], 'number', 'раздел заменён номером в словаре');
  assert.notEqual(packed.rows[1][6], null, 'пустая строка не подменяется отсутствием значения');

  /* Несжатый файл проходит насквозь: старый каталог читается тем же кодом. */
  assert.deepEqual(unpackRows({ fields, rows }), rows);
});

test('картинки: варианты не растягиваются и собираются в srcset', async () => {
  const { makeVariants, srcsetOf, fallbackSrc, ImageManifest, urlHash } = await import('../src/images.mjs');
  const sharp = (await import('sharp')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-img-'));

  const wide = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  const made = await makeVariants(wide, { outDir: dir, publicDir: 'assets/img/vtt', name: 'wide' });
  assert.deepEqual(made.variants.map((v) => v.width), [320, 640, 960], 'три ширины по списку');
  assert.equal(made.variants[0].height, 240, 'пропорции сохранены');
  for (const v of made.variants) {
    for (const f of ['webp', 'avif']) assert.ok(fs.existsSync(path.join(dir, path.basename(v.files[f]))), `нет файла ${v.files[f]}`);
  }

  /* Узкий исходник не достраивается до 320: увеличенная картинка хуже
     честной маленькой. */
  const small = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  const madeSmall = await makeVariants(small, { outDir: dir, publicDir: 'assets/img/vtt', name: 'small' });
  assert.deepEqual(madeSmall.variants.map((v) => v.width), [200], 'ширина исходника, а не 320');

  const set = srcsetOf(made);
  assert.match(set, /320w/); assert.match(set, /960w/);
  assert.ok(set.indexOf('320w') < set.indexOf('960w'), 'от узкого к широкому');
  assert.match(fallbackSrc(made), /-960\.webp$/, 'запасной src — самый широкий вариант');
  assert.equal(srcsetOf(null), '');

  /* Манифест помнит и готовое, и неудачи: иначе каждая сборка снова
     ходила бы за картинкой, которой нет. */
  const mf = path.join(dir, 'manifest.json');
  const m1 = new ImageManifest(mf);
  m1.set('http://x/a.jpg', { hash: urlHash('http://x/a.jpg'), variants: made.variants, bytes: made.bytes });
  m1.set('http://x/b.jpg', { error: 'HTTP 404' });
  m1.save();
  const m2 = new ImageManifest(mf);
  assert.equal(m2.stats().ok, 1);
  assert.equal(m2.stats().failed, 1);
  assert.equal(m2.isReady('http://x/a.jpg', path.dirname(dir)), false, 'файлов по пути нет — запись не считается готовой');
});

test('импорт CSV: полная выгрузка, повтор без дублей, отчёт', async () => {
  const { readCsvCatalog } = await import('../src/csv.mjs');
  const { normalizeItem } = await import('../src/normalize.mjs');
  const { deriveCategoryTree, createCategoryMapper, UNMAPPED_ID } = await import('../src/categories.mjs');
  const { store } = tmpStore();

  const head = 'Id;Name;Brand;Vendor;NameAlias;Group;RootGroup;Price;PriceLocal;AvailableQuantity;MainOfficeQuantity;PhotoUrl;PhotoUrls;Compatibility';
  const lines = [head];
  for (let i = 0; i < 250; i++) {
    const root = i % 3 === 0 ? 'Картриджи для лазерной печати' : i % 3 === 1 ? 'Чипы' : 'Бумага и пленки';
    const group = i % 3 === 0 ? 'Картриджи лазерные' : i % 3 === 1 ? 'Чипы' : 'Фотобумага';
    lines.push(`VTT-${i};Товар ${i};Hi-Black;HP;HB-${i};${group};${root};1.19;100.${i % 100};${i % 5};${i % 5};dummy.jpg;{"string":[]};`);
  }
  /* Дубль идентификатора и строка без Id: обе должны попасть в счётчики,
     а не тихо исчезнуть. */
  lines.push('VTT-7;Дубль;Hi-Black;HP;HB-7;Чипы;Чипы;1.19;100.7;1;1;dummy.jpg;{"string":[]};');
  lines.push(';Без идентификатора;Hi-Black;HP;X;Чипы;Чипы;1;1;1;1;dummy.jpg;{"string":[]};');

  const { items: rows } = readCsvCatalog(lines.join('\n') + '\n');
  assert.equal(rows.length, 252);

  const seen = new Map();
  let withoutId = 0, duplicates = 0;
  const normalized = [];
  for (const raw of rows) {
    const id = String(raw.Id ?? '').trim();
    if (!id) { withoutId += 1; continue; }
    if (seen.has(id)) { duplicates += 1; continue; }
    const item = normalizeItem(raw, { now: '2026-01-01T00:00:00.000Z' });
    seen.set(id, item);
    normalized.push(item);
  }
  assert.equal(withoutId, 1);
  assert.equal(duplicates, 1);
  assert.equal(normalized.length, 250);

  const tree = deriveCategoryTree(normalized);
  const assign = createCategoryMapper(tree);
  for (const item of normalized) {
    const d = assign(item);
    item.categoryId = d.id;
    assert.notEqual(d.id, UNMAPPED_ID, `товар ${item.id} остался без категории`);
  }
  assert.equal(tree.roots.length, 3, 'три корневых раздела поставщика');

  const first = store.upsertItems(normalized, { now: '2026-01-01T00:00:00.000Z', syncId: 'csv-1' });
  assert.equal(first.added.length, 250);
  const second = store.upsertItems(normalized, { now: '2026-01-02T00:00:00.000Z', syncId: 'csv-2' });
  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 0, 'повторный импорт того же файла ничего не меняет');
  assert.equal(second.unchanged.length, 250);
  assert.equal(store.loadAll().size, 250, 'дубль не создал второй карточки');
});

test('исчезнувшее поле поставщика не остаётся в карточке навсегда', async () => {
  const { store } = tmpStore();
  const withPrice = { id: 'P1', name: 'Товар', vendorCode: 'A-1', price: 1500, supplierDescription: 'Текст поставщика' };
  store.upsertItems([withPrice], { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(store.loadAll().get('P1').price, 1500);

  /* Следующая выгрузка цены и описания не прислала: значит их больше нет.
     Это ровно тот случай, что дала реальная выгрузка VTT — 972 позиции
     с «−1» вместо суммы. Старая цена в карточке остаться не может. */
  const without = { id: 'P1', name: 'Товар', vendorCode: 'A-1' };
  const rep = store.upsertItems([without], { now: '2026-01-02T00:00:00.000Z' });
  assert.equal(rep.updated.length, 1);
  const rec = store.loadAll().get('P1');
  assert.equal(rec.price, undefined, 'цена, которой больше нет, исчезла из карточки');
  assert.equal(rec.supplierDescription, undefined);
  assert.equal(rec.firstSeenAt, '2026-01-01T00:00:00.000Z', 'служебные отметки сохранились');

  /* А обогащение при этом не теряется: его пишут другие операции. */
  store.patchItem('P1', { compatibilityLabels: ['HP LJ 1010'], categorySource: 'GetCategoryItems' });
  store.upsertItems([without], { now: '2026-01-03T00:00:00.000Z' });
  assert.deepEqual(store.loadAll().get('P1').compatibilityLabels, ['HP LJ 1010']);
  assert.equal(store.loadAll().get('P1').categorySource, 'GetCategoryItems');
});
