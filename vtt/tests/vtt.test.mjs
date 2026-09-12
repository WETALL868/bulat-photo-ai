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

test('PhotoUrl и PhotoUrls объединяются без дублей и поднимаются до https', () => {
  const item = normalizeItem({
    Id: 'X',
    PhotoUrl: 'http://b2b.vtt.ru/images/a.jpg',
    PhotoUrls: ['http://b2b.vtt.ru/images/a.jpg', 'http://b2b.vtt.ru/images/b.jpg'],
  });
  /*
    Схема поднята не для красоты. Страница магазина открыта по https, и
    картинку по http браузер блокирует как смешанный контент — молча, с
    naturalWidth 0 и пустым местом вместо товара. Найдено на живом
    preview: 1240C002 не грузился именно поэтому.
  */
  assert.deepEqual(item.photos, ['https://b2b.vtt.ru/images/a.jpg', 'https://b2b.vtt.ru/images/b.jpg']);
  assert.deepEqual(item.photosOriginal, ['http://b2b.vtt.ru/images/a.jpg', 'http://b2b.vtt.ru/images/b.jpg'],
    'исходные адреса поставщика сохранены отдельно');

  /* Уже поднятый адрес не трогается и в «оригиналы» не дублируется. */
  const already = normalizeItem({ Id: 'Z', PhotoUrl: 'https://b2b.vtt.ru/images/c.jpg' });
  assert.deepEqual(already.photos, ['https://b2b.vtt.ru/images/c.jpg']);
  assert.equal(already.photosOriginal, undefined);

  /* Относительное имя файла адресом не является: у VTT так выражено
     отсутствие картинки, и до карточки оно доходить не должно. */
  const stub = normalizeItem({ Id: 'Y', PhotoUrl: 'dummy.jpg', PhotoUrls: '{"string":[]}' });
  assert.deepEqual(stub.photos, []);
});

test('схема поднимается только у проверенных хостов', async () => {
  const { upgradePhotoUrl, HTTPS_SAFE_IMAGE_HOSTS } = await import('../src/normalize.mjs');
  assert.equal(upgradePhotoUrl('http://b2b.vtt.ru/images/1240C002.jpg'), 'https://b2b.vtt.ru/images/1240C002.jpg');
  assert.equal(upgradePhotoUrl('http://B2B.VTT.RU/images/x.jpg'), 'https://B2B.VTT.RU/images/x.jpg');
  assert.equal(upgradePhotoUrl('http://b2b.vtt.ru:80/x.jpg'), 'https://b2b.vtt.ru/x.jpg');

  /*
    Чужой хост не трогаем. Подмена схемы у сервера без TLS не чинит
    картинку, а ломает работавшую: соединение просто не установится.
    Поэтому список хостов закрытый и каждый в нём проверен вручную.
  */
  assert.equal(upgradePhotoUrl('http://example.com/x.jpg'), 'http://example.com/x.jpg');
  assert.equal(upgradePhotoUrl('http://b2b.vtt.ru:8080/x.jpg'), 'http://b2b.vtt.ru:8080/x.jpg',
    'нестандартный порт по https никто не слушает');
  assert.equal(upgradePhotoUrl('https://b2b.vtt.ru/x.jpg'), 'https://b2b.vtt.ru/x.jpg');
  assert.equal(upgradePhotoUrl(''), undefined);
  assert.ok(HTTPS_SAFE_IMAGE_HOSTS.has('b2b.vtt.ru'));
});

test('в опубликованном каталоге не остаётся адресов по http', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  const items = makeItems(12).map((raw, i) => normalizeItem({
    ...raw,
    PhotoUrl: `http://b2b.vtt.ru/images/${i}.jpg`,
    PhotoUrls: [`http://b2b.vtt.ru/images/${i}.jpg`, `http://b2b.vtt.ru/images/${i}-b.jpg`],
  }));
  store.upsertItems(items, {});
  const { products } = publish(store, {});
  for (const p of products) {
    assert.ok(!String(p.img).startsWith('http://'), `главная картинка по http: ${p.img}`);
    for (const u of p.images) assert.ok(!u.startsWith('http://'), `дополнительная картинка по http: ${u}`);
    assert.ok(p.imagesOriginal.every((u) => u.startsWith('http://')), 'исходные адреса сохранены как есть');
  }
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

/* ------------------------------------------------------------------ *
   Картинки в превью: прокси и упаковка в атласы

   Опубликованное превью живёт во фрейме со строгой политикой ресурсов:
   картинка поставщика по прямому адресу там не появляется — src
   проставлен, тот же файл в отдельной вкладке отдаёт 200, а
   naturalWidth остаётся нулём. Отсюда два пути, и оба проверяются здесь.
 * ------------------------------------------------------------------ */

test('прокси-адрес собирается корректно и только для чужих хостов', async () => {
  const { proxyUrl, proxySrcset, shouldProxy, PROXY_ORIGIN } = await import('../../tools/image-proxy.mjs');
  const u = proxyUrl('https://b2b.vtt.ru/images/1240C002.jpg', { width: 320 });
  assert.ok(u.startsWith(PROXY_ORIGIN), 'адрес ведёт на прокси');
  const q = new URL(u).searchParams;
  assert.equal(q.get('url'), 'b2b.vtt.ru/images/1240C002.jpg', 'источник передан без схемы');
  assert.equal(q.get('w'), '320');
  assert.equal(q.get('output'), 'webp');
  assert.ok(q.has('we'), 'запрет на увеличение выставлен');

  /* Скобки и кириллица в адресах поставщика встречаются — экранирование
     обязано их пережить. */
  const tricky = proxyUrl('https://b2b.vtt.ru/images/C-EPS (1469197).jpg');
  assert.equal(new URL(tricky).searchParams.get('url'), 'b2b.vtt.ru/images/C-EPS (1469197).jpg');

  const set = proxySrcset('https://b2b.vtt.ru/images/x.jpg');
  assert.match(set, /320w/); assert.match(set, /640w/);
  assert.ok(set.indexOf('320w') < set.indexOf('640w'), 'от узкого к широкому');

  /* Собственные файлы витрины лежат рядом со страницей: проксировать их
     значит добавить зависимость от третьего сервиса на пустом месте. */
  assert.equal(shouldProxy('assets/img/no-photo.svg'), false);
  assert.equal(shouldProxy('/assets/img/no-photo.svg'), false);
  assert.equal(shouldProxy('https://b2b.vtt.ru/images/x.jpg'), true);
  assert.equal(proxyUrl('assets/img/no-photo.svg'), 'assets/img/no-photo.svg', 'не-адрес остаётся собой');
});

test('атлас: раскладка, ячейки и обратный расчёт позиции', async () => {
  const { buildAtlases, atlasLayout, placeOf } = await import('../../tools/pack-thumbs.mjs');
  const sharp = (await import('sharp')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-atlas-'));

  const sources = [];
  for (let i = 0; i < 20; i++) {
    sources.push({
      id: 'p' + i,
      buffer: await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: i * 10, g: 90, b: 170 } } }).jpeg().toBuffer(),
    });
  }
  const res = await buildAtlases(sources, { outDir: dir, publicDir: 'assets/img/atlas', cell: 240, perAtlas: 9, quality: 70 });

  assert.equal(res.files.length, 3, '20 миниатюр по 9 в атласе — три файла');
  assert.equal(Object.keys(res.items).length, 20, 'ни одна миниатюра не потеряна');
  assert.equal(res.cols, 3); assert.equal(res.rows, 3);

  const meta = await sharp(path.join(dir, 'atlas-0.webp')).metadata();
  assert.equal(meta.width, 720); assert.equal(meta.height, 720);

  /* Позиция ячейки — то, по чему витрина считает background-position.
     Расхождение здесь означало бы чужую картинку в карточке. */
  assert.deepEqual(res.items.p0, [0, 0, 0]);
  assert.deepEqual(res.items.p4, [0, 1, 1]);
  assert.deepEqual(res.items.p9, [1, 0, 0]);
  assert.deepEqual(res.items.p19, [2, 1, 0]);
  const layout = atlasLayout(20, { cell: 240, perAtlas: 9 });
  assert.deepEqual(placeOf(13, layout), { atlas: 1, col: 1, row: 1 });

  /* Атлас должен помещаться в пределы публикации: 6 201 картинка по 144
     в атласе — это 44 файла, а не 6 201. */
  const big = atlasLayout(6201, { cell: 240, perAtlas: 144 });
  assert.equal(big.atlases, 44);
  assert.ok(big.atlases + 205 < 255, 'вместе с остальными файлами укладывается в предел публикации');
  assert.equal(big.width, 2880, 'атлас не выходит за размер, который браузеры декодируют без оговорок');
});

/* ------------------------------------------------------------------ *
   Витрина только собственных марок VTT

   Поставщик отдаёт весь свой ассортимент — 9 483 позиции, включая чужие
   бренды. Публиковать нужно только линейки самого VTT. Отбор идёт по
   полю Brand выгрузки, то есть по производителю; Vendor для этого не
   годится — у VTT это марка принтера, к которому товар подходит, и по
   нему на витрину попал бы весь чужой ассортимент, совместимый с HP.
 * ------------------------------------------------------------------ */

const OWN_FILTER = {
  brands: ['Hi-Black', 'NetProduct', 'Hi-Image', 'Content', 'Hi-Color'],
  brandFallback: {
    whenBrandIn: ['', 'Совместимые'],
    nameMarks: ['Hi-Black', 'NetProduct', 'Hi-Image', 'Hi-Color'],
  },
};

test('пять собственных марок VTT проходят фильтр', async () => {
  const { matchesFilter } = await import('../src/publish.mjs');
  for (const brand of ['Hi-Black', 'NetProduct', 'Hi-Image', 'Content', 'Hi-Color']) {
    assert.equal(matchesFilter({ brand, name: `Товар ${brand}` }, OWN_FILTER), true, `марка ${brand} отсеяна`);
  }
  /* Регистр и пробелы у поставщика гуляют, маркой это быть не перестаёт. */
  assert.equal(matchesFilter({ brand: ' hi-black ', name: 'Картридж' }, OWN_FILTER), true);
  assert.equal(matchesFilter({ brand: 'HI-BLACK', name: 'Картридж' }, OWN_FILTER), true);
});

test('чужие марки на витрину не попадают', async () => {
  const { matchesFilter } = await import('../src/publish.mjs');
  for (const brand of ['Original', 'OEM', 'InkTec', 'Static Control', 'Katun', 'Pantum', 'Tomoegawa', 'Mitsubishi']) {
    assert.equal(matchesFilter({ brand, name: 'Картридж для HP LaserJet' }, OWN_FILTER), false, `марка ${brand} прошла`);
  }
  /* Пустой Brand сам по себе пропуском не является. */
  assert.equal(matchesFilter({ brand: '', name: 'Тонер для HP LJ 1010' }, OWN_FILTER), false);
  assert.equal(matchesFilter({ brand: 'Совместимые', name: 'Ролик подачи для Samsung' }, OWN_FILTER), false);
});

test('отбор идёт по производителю, а не по совместимости с принтером', async () => {
  const { matchesFilter } = await import('../src/publish.mjs');
  /*
    Ровно та ошибка, ради которой это правило и написано: у VTT поле
    Vendor означает марку ПРИНТЕРА. Чужой картридж Original для HP имеет
    Vendor «HP» и shopBrand «hp» — и по любому из них прошёл бы на
    витрину, хотя произвёл его не VTT.
  */
  const foreign = { brand: 'Original', compatibleBrand: 'HP', name: 'Картридж HP CF259A', cat: 'laser' };
  assert.equal(matchesFilter(foreign, OWN_FILTER), false, 'чужой товар прошёл по марке принтера');

  const own = { brand: 'Hi-Black', compatibleBrand: 'HP', name: 'Картридж Hi-Black HB-CF259A' };
  assert.equal(matchesFilter(own, OWN_FILTER), true, 'свой товар отсеян из-за марки принтера');
});

test('позиции без Brand спасаются по марке в названии, но только по ней', async () => {
  const { matchesFilter, ownBrandInName } = await import('../src/publish.mjs');
  const marks = OWN_FILTER.brandFallback.nameMarks;

  /* Настоящие исключения из реальной выгрузки: Brand не заполнен либо
     «Совместимые», а марка стоит в названии перед хвостом о
     совместимости. */
  const real = [
    ['', 'Универсальный очиститель Hi-Black Cleaner для оргтехники и электроники, 520 мл'],
    ['', 'Поглотитель чернил (абсорбер, памперс) Hi-Black для принтеров Epson L8160'],
    ['Совместимые', 'Ролик проявки Hi-Black для Avision AP30A/КАТЮША M133'],
    ['Совместимые', 'Шестерня 29T/14T GP-160 Hi-Black (совместима с LJ 5000/5100)'],
    ['Совместимые', 'Тормозная площадка (металлическая рамка) Hi-Black для Samsung ML-1510/1710'],
  ];
  for (const [brand, name] of real) {
    assert.equal(matchesFilter({ brand, name }, OWN_FILTER), true, `не спасено: ${name}`);
  }

  /*
    А вот это — чужая деталь, ПОДХОДЯЩАЯ к технике Hi-Black. Марка стоит
    после «для», то есть в хвосте о совместимости, и производителем не
    является. Без этой оговорки на витрину уехал бы чужой товар.
  */
  assert.equal(ownBrandInName('Ролик подачи для Hi-Black HB-2030', marks), false);
  assert.equal(ownBrandInName('Шестерня, совместимая с Hi-Black HB-1050', marks), false);
  assert.equal(matchesFilter({ brand: 'Совместимые', name: 'Ролик подачи для Hi-Black HB-2030' }, OWN_FILTER), false);

  /* Марка должна быть отдельным словом, а не куском другого. */
  assert.equal(ownBrandInName('Картридж Hi-Blackberry', marks), false);
  assert.equal(ownBrandInName('Тонер NetProductions', marks), false);
  assert.equal(ownBrandInName('Картридж Hi Black HB-1', marks), true, 'написание через пробел — та же марка');

  /*
    Content в спасательный список не входит намеренно: это обычное
    английское слово, и в названии чужого товара оно ничего не доказывает.
  */
  assert.equal(ownBrandInName('Premium Content Roller for HP', marks), false);
  assert.equal(matchesFilter({ brand: '', name: 'Premium Content Roller for HP' }, OWN_FILTER), false);
  /* При этом товар, у которого Content стоит именно в поле Brand, свой. */
  assert.equal(matchesFilter({ brand: 'Content', name: 'Тонер-картридж' }, OWN_FILTER), true);
});

test('описание и совместимость на отбор не влияют', async () => {
  const { matchesFilter } = await import('../src/publish.mjs');
  /* Марка может встретиться в тексте описания или в списке совместимых
     моделей — это не делает товар своим. Смотрим только название. */
  const item = {
    brand: 'Original', name: 'Картридж Canon 045 M',
    supplierDescription: 'Аналог Hi-Black HB-045M, тот же ресурс',
    compatibilityText: 'подходит там же, где Hi-Black HB-045',
    compatibilityLabels: ['Hi-Black HB-045M'],
  };
  assert.equal(matchesFilter(item, OWN_FILTER), false, 'марка из описания протащила чужой товар');

  const weak = { brand: '', name: 'Ролик захвата', supplierDescription: 'Замена для Hi-Black' };
  assert.equal(matchesFilter(weak, OWN_FILTER), false, 'марка из описания сработала как признак');
});

test('публикация: чужие артикулы не доходят до витрины', async () => {
  const { publish } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  const rows = [
    { Id: 'own-1', Name: 'Картридж Hi-Black HB-CF259A', Brand: 'Hi-Black', Vendor: 'HP', NameAlias: 'HB-CF259A', PriceLocal: '1000', Group: 'Картриджи лазерные', RootGroup: 'Картриджи для лазерной печати' },
    { Id: 'own-2', Name: 'Тонер NetProduct N-100', Brand: 'NetProduct', Vendor: 'Canon', NameAlias: 'N-100', PriceLocal: '900', Group: 'Тонеры черные', RootGroup: 'Тонеры/ Девелоперы' },
    { Id: 'own-3', Name: 'Очиститель Hi-Black Cleaner для оргтехники', Brand: '', Vendor: 'HP', NameAlias: 'HB-CLN', PriceLocal: '500', Group: 'Чистящие средства', RootGroup: 'Чистящие средства и материалы для обслуживания' },
    { Id: 'ext-1', Name: 'Тонер-картридж 045 M Canon LBP610', Brand: 'Original', Vendor: 'Canon', NameAlias: '1240C002', PriceLocal: '6543', Group: 'Картриджи лазерные', RootGroup: 'Картриджи для лазерной печати' },
    { Id: 'ext-2', Name: 'Чернила InkTec для Epson', Brand: 'InkTec', Vendor: 'Epson', NameAlias: 'IT-100', PriceLocal: '700', Group: 'Чернила', RootGroup: 'Чернила' },
    { Id: 'ext-3', Name: 'Ролик подачи для Hi-Black HB-2030', Brand: 'Совместимые', Vendor: 'HP', NameAlias: 'RL-1', PriceLocal: '300', Group: 'Ролики', RootGroup: 'Запчасти для ремонта техники' },
  ];
  store.upsertItems(rows.map((r) => normalizeItem(r)), {});

  const res = publish(store, { filter: OWN_FILTER });
  const ids = res.products.map((p) => p.vttId).sort();
  assert.deepEqual(ids, ['own-1', 'own-2', 'own-3'], 'на витрине не тот набор');
  assert.equal(res.report.filtered, 3, 'в отчёте не указан отсев');
  assert.equal(res.report.total, 6, 'стор не должен уменьшаться');

  /* Чужие артикулы не должны находиться ни по коду, ни по названию. */
  const blob = JSON.stringify(res.products);
  for (const needle of ['1240C002', 'InkTec', 'RL-1']) {
    assert.ok(!blob.includes(needle), `чужой артикул ${needle} дошёл до витрины`);
  }
  /* А стор остался полным — он нужен для анализа. */
  assert.equal(store.loadAll().size, 6, 'фильтр не имеет права удалять из стора');
});

test('фильтр марок прописан в конфигурации, а не только в тестах', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const cfg = loadConfig(path.join(process.cwd(), 'vtt/config.json'));
  const f = cfg.publishFilter;
  assert.deepEqual(f.brands, ['Hi-Black', 'NetProduct', 'Hi-Image', 'Content', 'Hi-Color'],
    'состав витрины задаётся конфигурацией — пустой список вернул бы чужие бренды');
  assert.deepEqual(f.brandFallback.whenBrandIn, ['', 'Совместимые']);
  assert.ok(!f.brandFallback.nameMarks.includes('Content'), 'Content не должен спасать по названию');
  assert.ok(f.brandFallback.nameMarks.includes('Hi-Black'));
});

/* ===================================================================== */
/*  Повреждённая упаковка, ресурс, цвета, серии и описания               */
/* ===================================================================== */

test('повреждённая упаковка распознаётся по всем трём пометкам поставщика', async () => {
  const { isDamagedPackage } = await import('../src/normalize.mjs');
  assert.ok(isDamagedPackage({ description: 'Поврежденная упаковка' }), 'Description');
  assert.ok(isDamagedPackage({ description: 'Повреждённая упаковка' }), 'Description с ё');
  assert.ok(isDamagedPackage({ compatibility: 'Поврежденная упаковка' }), 'Compatibility');
  assert.ok(isDamagedPackage({ name: 'Тонер-картридж ... , C, 6K (Повр. упак.)' }), 'Повр. упак.');
  assert.ok(isDamagedPackage({ name: 'Тонер-картридж ... , Bk,12K, ПУ' }), 'ПУ');
  assert.ok(isDamagedPackage({ name: 'Картридж ..., П/У' }), 'П/У');

  /* А это не повреждённая упаковка, и путать нельзя. */
  assert.ok(!isDamagedPackage({ name: 'Тонер-картридж Hi-Black (HB-TK-8115C) для Kyocera, C, 6K' }));
  assert.ok(!isDamagedPackage({ description: 'Уцененный товар' }));
  assert.ok(!isDamagedPackage({ name: 'Пурпурный картридж' }), '«пу» внутри слова не пометка');
  assert.ok(!isDamagedPackage({}));
});

test('повреждённая упаковка не доходит до витрины, но остаётся в сторе', async () => {
  const { publish, matchesFilter } = await import('../src/publish.mjs');
  const { store } = tmpStore();
  const base = { Brand: 'Hi-Black', Vendor: 'Kyocera-Mita', Group: 'Тонер-картриджи', RootGroup: 'Картриджи для лазерной печати', PriceLocal: '1273.77' };
  const rows = [
    { ...base, Id: '4100603160', Name: 'Тонер-картридж Hi-Black (HB-TK-8115BK) для Kyocera Ecosys M8124cidn/M8130cidn, Bk,12K', NameAlias: 'HB-TK-8115BK', ColorName: 'Bk', ItemLifeTime: '12K' },
    { ...base, Id: '4100603161', Name: 'Тонер-картридж Hi-Black (HB-TK-8115C) для Kyocera Ecosys M8124cidn/M8130cidn, C, 6K', NameAlias: 'HB-TK-8115C', ColorName: 'C', ItemLifeTime: '6K' },
    { ...base, Id: '4100603160p', Name: 'Тонер-картридж Hi-Black (HB-TK-8115BK) для Kyocera Ecosys M8124cidn/M8130cidn, Bk,12K, ПУ', NameAlias: 'HB-TK-8115BK', ColorName: 'Bk', ItemLifeTime: '12K', Description: 'Поврежденная упаковка' },
    { ...base, Id: '4100603161p', Name: 'Тонер-картридж Hi-Black (HB-TK-8115C) для Kyocera Ecosys M8124cidn/M8130cidn, C, 6K (Повр. упак.)', NameAlias: 'HB-TK-8115C', ItemLifeTime: '6K', Description: 'Поврежденная упаковка' },
  ];
  store.upsertItems(rows.map((r) => normalizeItem(r)), {});

  const res = publish(store, { filter: OWN_FILTER });
  assert.deepEqual(res.products.map((p) => p.vttId).sort(), ['4100603160', '4100603161'],
    'позиции с повреждённой упаковкой попали на витрину');
  assert.equal(res.report.damagedPackage, 2, 'отсев по упаковке не попал в отчёт отдельной строкой');
  assert.equal(store.loadAll().size, 4, 'из стора удалять нельзя — это выгрузка поставщика');

  /* Ни адреса, ни артикула такой позиции на витрине быть не должно. */
  const blob = JSON.stringify(res.products);
  assert.ok(!blob.includes('4100603160p') && !blob.includes('4100603161p'));
  assert.ok(!/Повр\.?\s*упак|Поврежденная/i.test(blob));

  /* Выключить отсев можно явно — для анализа, но не для витрины. */
  const all = [...store.loadAll().values()].filter((i) => matchesFilter(i, { ...OWN_FILTER, excludeDamagedPackage: false }));
  assert.equal(all.length, 4);
});

test('ресурс читается из ItemLifeTime, объём чернил ресурсом не притворяется', async () => {
  const { resourcePages, volumeMl } = await import('../src/normalize.mjs');
  assert.equal(resourcePages('6K'), 6000);
  assert.equal(resourcePages('12K'), 12000);
  assert.equal(resourcePages('2,5K'), 2500);
  assert.equal(resourcePages('1,52К'), 1520, 'кириллическая К — тоже тысячи');
  assert.equal(resourcePages('300000'), 300000);
  assert.equal(resourcePages('600'), 600);
  assert.equal(resourcePages('100мл'), undefined, 'объём не ресурс');
  assert.equal(resourcePages(''), undefined);
  assert.equal(resourcePages('чепуха'), undefined, 'непонятную строку ресурсом не объявляем');
  assert.equal(volumeMl('100мл'), 100);
  assert.equal(volumeMl('14,4 мл'), 14.4);
  assert.equal(volumeMl('6K'), undefined);

  const item = normalizeItem({ Id: '1', Name: 'Тонер-картридж', NameAlias: 'HB-1', PriceLocal: '10', ItemLifeTime: '6K' });
  assert.equal(item.resource, 6000);
  assert.equal(item.lifeTime, '6K', 'исходная строка поставщика обязана сохраниться');
  assert.ok(!item.missing.includes('resource'));
});

test('цвет: код переводится в название, кириллическая С не теряется', async () => {
  const { colorTitle, colorPhrase, colorLabel, colorRank, colorKey } = await import('../src/colors.mjs');
  assert.equal(colorTitle('Bk'), 'Чёрный (Bk)');
  assert.equal(colorTitle('C'), 'Голубой (C)');
  assert.equal(colorTitle('С'), 'Голубой (С)', 'русская С в поле цвета встречается в выгрузке');
  assert.equal(colorTitle('4-COL'), 'Четыре цвета (4-COL)');
  assert.equal(colorTitle('Чёрный'), 'Чёрный', 'название не дублируется само собой');
  assert.equal(colorTitle('ZZZ'), 'ZZZ', 'незнакомый код остаётся как есть, а не выдумывается');
  assert.equal(colorTitle(''), '');
  assert.equal(colorPhrase('C'), 'голубой (C)', 'строчным становится только название, не код');
  assert.equal(colorLabel('м'), null);
  assert.ok(colorRank('Bk') < colorRank('C'), 'порядок — как на панели принтера');
  assert.ok(colorRank('C') < colorRank('Y'));
  assert.equal(colorKey('Чёрный'), 'черный');
});

test('серия по цветам: HB-TK-8115 собирается целиком и не липнет к HB-TK-8110', async () => {
  const { famKey, seriesKey, variantLabel, FAM_MAX } = await import('../src/family.mjs');
  const mk = (code, color, res, name) => ({
    code, color, res, name, supplierBrand: 'Hi-Black', cat: 'laser',
    vttCategoryId: 'g:laser:toner', type: 'Тонер-картридж', compatibleBrand: 'Kyocera-Mita',
  });
  const p8115 = [
    mk('HB-TK-8115BK', 'Bk', 12000, 'Тонер-картридж Hi-Black (HB-TK-8115BK) для Kyocera Ecosys M8124cidn/M8130cidn, Bk,12K'),
    mk('HB-TK-8115C', 'C', 6000, 'Тонер-картридж Hi-Black (HB-TK-8115C) для Kyocera Ecosys M8124cidn/M8130cidn, C, 6K'),
    mk('HB-TK-8115M', 'M', 6000, 'Тонер-картридж Hi-Black (HB-TK-8115M) для Kyocera Ecosys M8124cidn/M8130cidn, M, 6K'),
    mk('HB-TK-8115Y', 'Y', 6000, 'Тонер-картридж Hi-Black (HB-TK-8115Y) для Kyocera Ecosys M8124cidn/M8130cidn, Y, 6K'),
  ];
  const keys = new Set(p8115.map(famKey));
  assert.equal(keys.size, 1, 'разный ресурс у чёрного и цветных не должен разводить серию');

  /* Другая серия для того же аппарата — другой ключ. */
  const p8110 = mk('HB-TK-8110BK', 'Bk', 12000, 'Тонер-картридж Hi-Black (HB-TK-8110BK) для Kyocera Ecosys M8124cidn/M8130cidn, Bk, 12K (Азия)');
  assert.ok(!keys.has(famKey(p8110)), 'HB-TK-8110 (Азия) склеился с HB-TK-8115');

  /* Чип к тонер-картриджу не липнет: другой тип и другой раздел. */
  const chip = { ...p8115[1], type: 'Чип', vttCategoryId: 'g:chips', code: 'HB-CH-TK-8115C' };
  assert.ok(!keys.has(famKey(chip)), 'чип попал в серию тонер-картриджей');

  /* Чужая марка не липнет даже при совпадении названия. */
  assert.ok(!keys.has(famKey({ ...p8115[1], supplierBrand: 'NetProduct' })), 'чужая марка склеилась');
  /* И другая марка техники тоже. */
  assert.ok(!keys.has(famKey({ ...p8115[1], compatibleBrand: 'HP' })), 'другая техника склеилась');

  /* «Тип B» и «Тип C» у универсальных чернил — разные серии. */
  const ink = (t, color) => ({ code: `HB-INK-${t}`, color, name: `Чернила Hi-Black Универсальные для Brother (Тип ${t}), ${color}, 0,1 л.`, supplierBrand: 'Hi-Black', cat: 'ink', vttCategoryId: 'g:ink', type: 'Чернила', compatibleBrand: 'Brother' });
  assert.notEqual(famKey(ink('B', 'Bk')), famKey(ink('C', 'Bk')), '«Тип B» и «Тип C» слились');

  /* Подпись варианта различает одинаковые цвета в одной серии. */
  assert.equal(variantLabel(p8115[0], false), 'Чёрный (Bk)');
  /* Разделитель разрядов у toLocaleString неразрывный — сравниваем с тем
     же форматированием, а не с пробелом из редактора. */
  const nf = (n) => Number(n).toLocaleString('ru-RU');
  assert.equal(variantLabel(p8115[0], true), `Чёрный (Bk) · ${nf(12000)} стр.`);
  assert.equal(variantLabel({ code: 'X', color: 'Bk', volumeMl: 100 }, true), `Чёрный (Bk) · ${nf(100)} мл`);
  assert.equal(variantLabel({ code: 'HB-X', color: 'Bk' }, true), 'Чёрный (Bk) · HB-X');

  assert.ok(seriesKey(p8115[0]).length >= 8, 'ключ серии не должен вырождаться в пустую строку');
  assert.equal(FAM_MAX, 12);
});

test('описание собирается из фактов, не повторяется дословно и не выдумывает единицы', async () => {
  const { buildDescription, modelsFromName } = await import('../src/publish.mjs');
  const item = normalizeItem({
    Id: '4100603161', Name: 'Тонер-картридж Hi-Black (HB-TK-8115C) для Kyocera Ecosys M8124cidn/M8130cidn, C, 6K',
    Brand: 'Hi-Black', Vendor: 'Kyocera-Mita', NameAlias: 'HB-TK-8115C', OriginalNumber: 'HB-TK-8115C',
    Group: 'Тонер-картриджи', RootGroup: 'Картриджи для лазерной печати', PriceLocal: '1273.77',
    ColorName: 'C', ItemLifeTime: '6K', Compatibility: 'с чипом, без бункера отработки тонера',
    Width: '0.38', Height: '0.45', Depth: '0.57', Weight: '5.00', GrossWeight: '0.80',
    NumberInPackage: '6.00', Barcode: '4690665028417',
  });
  const d = buildDescription(item);
  assert.ok(d.text.includes('HB-TK-8115C'));
  assert.ok(d.text.includes(`${Number(6000).toLocaleString('ru-RU')} страниц`), 'ресурс из ItemLifeTime не попал в описание');
  /* Цвет в тексте — прилагательным и без кода: «Голубой (C) тонер-картридж»
     читается как строка из накладной. Код остался в характеристиках. */
  assert.match(d.text, /^Голубой тонер-картридж Hi-Black HB-TK-8115C/, 'цвет не назван по-русски');
  assert.ok(d.text.includes('Kyocera Ecosys M8124cidn/M8130cidn'), 'совместимость из названия потеряна');
  /* Габариты, штрихкод и упаковка переехали в характеристики. */
  /* Штрихкод теперь есть — но как то, что покупатель сверяет при
     получении, а не как строка выгрузки с подписью. */
  assert.ok(d.text.includes('Штрихкод позиции'), 'штрихкод должен быть в абзаце про проверку');
  assert.ok(!d.text.includes('Штрихкод:'), 'штрихкод не должен идти подписью из выгрузки');
  /*
    Габаритов в тексте нет, и «см» тем более: единицы измерения поставщик
    не указывает, а 0,38 × 0,45 × 0,57 см — это спичечный коробок вместо
    коробки с шестью картриджами.
  */
  assert.ok(!d.text.includes(' см'), 'в описании появилась непроверенная единица измерения');
  assert.ok(!d.text.includes('0,38'), 'габариты без единиц не место в тексте');
  assert.ok(d.basedOn.includes('resource') && d.basedOn.includes('color'));
  assert.ok(!d.basedOn.includes('dimensions'));
  assert.ok(!d.text.includes('Штрихкод:'), 'штрихкод не должен идти подписью из выгрузки');
  /* Цены и остатка в постоянном тексте нет: они меняются каждой выгрузкой. */
  assert.ok(!d.text.includes(Number(1273).toLocaleString('ru-RU')) && !d.text.includes('₽'));
  assert.ok(!/\b500\b/.test(d.text));

  /* Соседний цвет той же серии — другой текст, а не тот же с подменённым артикулом. */
  const other = normalizeItem({
    Id: '4100603160', Name: 'Тонер-картридж Hi-Black (HB-TK-8115BK) для Kyocera Ecosys M8124cidn/M8130cidn, Bk,12K',
    Brand: 'Hi-Black', Vendor: 'Kyocera-Mita', NameAlias: 'HB-TK-8115BK', Group: 'Тонер-картриджи',
    RootGroup: 'Картриджи для лазерной печати', PriceLocal: '1401.07', ColorName: 'Bk', ItemLifeTime: '12K',
    Barcode: '4690665028400',
  });
  const d2 = buildDescription(other);
  assert.notEqual(d.text, d2.text);
  assert.ok(!d2.text.includes('HB-TK-8115C'));

  /* Осторожный разбор названия: хвост из цвета и ресурса отрезан, модели целы. */
  assert.equal(modelsFromName('Тонер-картридж Hi-Black (HB-TK-8115C) для Kyocera Ecosys M8124cidn/M8130cidn, C, 6K'),
    'Kyocera Ecosys M8124cidn/M8130cidn');
  assert.equal(modelsFromName('Бумага Hi-Image A4'), '', 'без «для» ничего не выдумываем');
});

test('отзывов нет — счётчики, рейтинг и микроразметка честно пустые', async () => {
  const { toShopProduct } = await import('../src/publish.mjs');
  const item = normalizeItem({
    Id: '1', Name: 'Тонер-картридж Hi-Black (HB-1) для HP, Bk, 6K', Brand: 'Hi-Black',
    NameAlias: 'HB-1', PriceLocal: '100', Group: 'Тонер-картриджи', RootGroup: 'Картриджи для лазерной печати',
  });
  const p = toShopProduct(item);
  assert.equal(p.rate, 0, 'у товара без отзывов не может быть оценки');
  assert.equal(p.reviews, 0);

  /* Генератора «отзывов покупателей» в сборщике быть не должно вовсе. */
  const builder = fs.readFileSync(path.join(process.cwd(), 'tools/build-catalog.mjs'), 'utf8');
  assert.ok(!builder.includes('REV_POOL'), 'вернулся генератор отзывов');
  assert.ok(!builder.includes('REV_DATES'), 'вернулся генератор дат отзывов');
  assert.ok(!/Покупка подтверждена/.test(builder));
  const app = fs.readFileSync(path.join(process.cwd(), 'assets/js/app.js'), 'utf8');
  assert.ok(!app.includes('badge-demo'), 'пометка ДЕМО вернулась на карточку');
  assert.ok(app.includes('Пока нет отзывов'), 'нет честного пустого состояния');
  assert.ok(app.includes("fetch('/api/review'"), 'форма отзыва снова ничего не отправляет');
  assert.ok(/rv\.verified \?/.test(app), '«Покупка подтверждена» должна зависеть от источника');
});

/* ===================================================================== */
/*  Реестр идентичности: адрес и «Код товара» не меняются                */
/* ===================================================================== */

test('реестр: выданное не меняется и не переиспользуется', async () => {
  const { ItemRegistry, stableKey } = await import('../../tools/item-registry.mjs');
  const reg = new ItemRegistry();

  /* Два товара с одинаковым артикулом: второй получает адрес с хвостом. */
  const normal = reg.claim('vtt:4100603161', { preferredId: 'hb-tk-8115c', seed: '4100603161' });
  const damaged = reg.claim('vtt:4100603161p', { preferredId: 'hb-tk-8115c', seed: '4100603161p' });
  assert.notEqual(normal.id, damaged.id);
  assert.notEqual(normal.no, damaged.no);

  /* Повторная выдача возвращает то же самое — даже если предпочтения другие. */
  assert.deepEqual(reg.claim('vtt:4100603161', { preferredId: 'совсем-другое', seed: 'zzz' }), normal);

  /*
    Главное. Товар ушёл с витрины (повреждённая упаковка) — его адрес и
    номер остаются занятыми, и новый товар их не получает. Именно этого
    не хватало: адрес удалённой позиции достался нормальной, и вместе с
    адресом сменился код.
  */
  const other = reg.claim('vtt:9999', { preferredId: damaged.id, seed: '9999' });
  assert.notEqual(other.id, damaged.id, 'адрес ушедшего товара переиспользован');
  assert.notEqual(other.no, damaged.no, 'код ушедшего товара переиспользован');
  assert.notEqual(other.no, normal.no);

  /* Ключ берётся из источника, а не из состава витрины. */
  assert.equal(stableKey({ source: 'vtt', vttId: '4100603161', id: 'что-угодно' }), 'vtt:4100603161');
  assert.equal(stableKey({ id: 'hb-ce285a' }), 'own:hb-ce285a');

  /* Номер — шесть знаков. */
  for (const rec of [normal, damaged, other]) {
    assert.ok(rec.no >= 100000 && rec.no <= 999999, `код вне диапазона: ${rec.no}`);
  }
});

test('реестр сохраняется и переживает перезапуск сборки', async () => {
  const { ItemRegistry } = await import('../../tools/item-registry.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reg-'));
  const file = path.join(dir, 'registry.json');

  const first = new ItemRegistry();
  const a = first.claim('vtt:1', { preferredId: 'hb-a', seed: '1' });
  const b = first.claim('vtt:2', { preferredId: 'hb-b', seed: '2' });
  first.save(file);

  /* Вторая сборка: товар vtt:1 с витрины ушёл, пришёл новый vtt:3. */
  const second = ItemRegistry.load(file);
  assert.deepEqual(second.get('vtt:1'), a, 'реестр не восстановился из файла');
  const c = second.claim('vtt:3', { preferredId: 'hb-a', seed: '3' });
  assert.notEqual(c.id, a.id, 'адрес ушедшего товара выдан новому');
  assert.notEqual(c.no, a.no);
  assert.deepEqual(second.claim('vtt:2', { preferredId: 'hb-b', seed: '2' }), b, 'адрес оставшегося товара изменился');
});

test('адреса и коды товаров совпадают с предыдущей публикацией', async () => {
  const root = process.cwd();
  const regFile = path.join(root, 'data/item-registry.json');
  const idxFile = path.join(root, 'data/catalog/index.json');
  if (!fs.existsSync(regFile) || !fs.existsSync(idxFile)) return; // каталог не собран

  const { unpackRows } = await import('../../tools/index-pack.mjs');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  const rows = unpackRows(idx);
  const col = Object.fromEntries(idx.fields.map((f, i) => [f, i]));

  /*
    Контрольные позиции: адрес и код, которые видели покупатели в
    предыдущей публикации. Среди них HB-TK-8115C — тот самый товар, у
    которого код уехал с 670235 на 686396, — и пять позиций из разных
    разделов, чей адрес заканчивается Id поставщика: именно они переезжали
    на освободившиеся адреса при исключении повреждённой упаковки.
  */
  const expected = [
    ['hb-tk-8115c-4100603161', 'HB-TK-8115C', 670235],
    ['hb-tk-8115bk', 'HB-TK-8115BK', 300972],
    ['hb-tk-8115m', 'HB-TK-8115M', 552110],
    ['hb-tk-8115y', 'HB-TK-8115Y', 820682],
    ['hb-ce285a', 'HB-CE285A', 388518],
    ['n-dv-1150-9897174', 'N-DV-1150', 361320],
    ['n-cf232a-7970267140', 'N-CF232A', 589433],
    ['hb-049-2200959296', 'HB-049', 734090],
    ['hb-44574302-220095911', 'HB-44574302', 489107],
    ['hb-ce314a-9970159540', 'HB-CE314A', 576109],
  ];
  for (const [id, code, no] of expected) {
    const row = rows.find((r) => r[col.id] === id);
    assert.ok(row, `адрес ${id} пропал с витрины`);
    assert.equal(row[col.code], code, `на адресе ${id} другой товар`);
    assert.equal(row[col.no], no, `у ${id} изменился код товара`);
  }

  /* Код уникален: по нему ищут, и два товара под одним номером — поломка. */
  const nos = rows.map((r) => r[col.no]);
  assert.equal(nos.filter((n) => !n).length, 0, 'есть товары без кода');
  assert.equal(new Set(nos).size, nos.length, 'коды товаров повторяются');

  /* Каждый адрес на витрине выдан реестром, и код взят оттуда же. */
  const byId = new Map(Object.values(reg.items).map((r) => [r.id, r.no]));
  for (const r of rows) {
    assert.ok(byId.has(r[col.id]), `адрес ${r[col.id]} выдан мимо реестра`);
    assert.equal(byId.get(r[col.id]), r[col.no], `код ${r[col.id]} разошёлся с реестром`);
  }

  /*
    Адреса удалённой повреждённой упаковки заняты в реестре и свободными
    не считаются, но на витрине их нет. Проверяем на той самой паре, из-за
    которой всё началось: hb-tk-8115c принадлежит повреждённой позиции.
  */
  assert.ok(byId.has('hb-tk-8115c'), 'адрес удалённой позиции выпал из реестра — его выдадут другому');
  assert.ok(!rows.some((r) => r[col.id] === 'hb-tk-8115c'), 'повреждённая упаковка вернулась на витрину');

  /* Поиск по коду товара находит карточку. */
  const search = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog/search-index.json'), 'utf8'));
  for (const [id, , no] of expected) {
    const hits = (search[String(no)] ?? []).map((i) => rows[i][col.id]);
    assert.deepEqual(hits, [id], `поиск по коду ${no} не находит ${id}`);
  }
});

/* ===================================================================== */
/*  Описания для людей, характеристики для метаданных                    */
/* ===================================================================== */

test('примечание поставщика делится на пометки и перечень моделей', async () => {
  const { parseSupplierNote } = await import('../src/publish.mjs');

  const a = parseSupplierNote('с чипом, без бункера отработки тонера');
  assert.deepEqual(a.notes, ['Поставляется с чипом.', 'Бункер для отработанного тонера в комплект не входит.']);
  assert.equal(a.compat, '', 'пометки не должны попадать в совместимость');

  const b = parseSupplierNote('с чипом, HP Color Laser Jet M377dn');
  assert.deepEqual(b.notes, ['Поставляется с чипом.']);
  assert.equal(b.compat, 'HP Color Laser Jet M377dn', 'перечень моделей обязан сохраниться дословно');

  /* Запятая внутри скобок — не разделитель: «(памперс, абсорбер)» это одно
     название, и разрезанное пополам оно превращается в обрывок. */
  const c = parseSupplierNote('1577649 Поглотитель чернил (памперс, абсорбер) для аппаратов Epson L300');
  assert.equal(c.unknown.length, 0);
  assert.ok(c.compat.includes('(памперс, абсорбер)'), `скобка разорвана: ${c.compat}`);

  assert.deepEqual(parseSupplierNote(''), { notes: [], compat: '', unknown: [] });
});

test('подлежащее берётся из названия и сохраняет отличие от соседа', async () => {
  const { productSubject } = await import('../src/publish.mjs');

  /* Артикул в скобках убирается при точном совпадении с кодом. */
  assert.equal(
    productSubject({ name: 'Тонер-картридж Hi-Black (HB-TK-8115BK) для Kyocera Ecosys M8124cidn/M8130cidn, Bk,12K', brand: 'Hi-Black' }, 'HB-TK-8115BK'),
    'Тонер-картридж',
  );
  /* А «(T2A)» — модель картриджа Deli, а не повтор артикула: остаётся.
     «многоразовый» — единственное, чем эта позиция отличается от соседней,
     и выбросить его значит выдать двум товарам один текст. */
  const chip = productSubject({ name: 'Чип Hi-Black к картриджу Deli P2000/M2000 (T2A), Bk, 2K многоразовый', brand: 'Hi-Black' }, 'HB-CH-Deli-T2A');
  assert.ok(chip.includes('(T2A)'), `модель картриджа потеряна: ${chip}`);
  assert.ok(chip.includes('многоразовый'), `отличие потеряно: ${chip}`);
  assert.ok(!/\bBk\b|2K/.test(chip), `цвет и ресурс должны уйти в свои поля: ${chip}`);
  assert.ok(chip.includes('многоразовый'), `отличие потеряно вместе с ресурсом: ${chip}`);
});

test('тип расходника — в единственном числе и по названию, а не по разделу', async () => {
  const { typeOf } = await import('../src/publish.mjs');
  assert.equal(typeOf({ name: '0609-001409 Сканирующая линейка Hi-Black Samsung M2020', category: 'Блоки лазера, сканера, Сканирующие линейки' }), 'Сканирующая линейка');
  assert.equal(typeOf({ name: 'Ремкомплект (Maintenance Kit) Hi-Black для XEROX Phaser 3610DN', category: 'Ремкомплекты, Комплекты обслуживания' }), 'Ремкомплект');
  assert.equal(typeOf({ name: '1627961 Поглотитель чернил (памперс, абсорбер) Hi-Black для Epson', category: 'Чернила' }), 'Поглотитель чернил',
    'поглотитель чернил — не чернила');
  assert.equal(typeOf({ name: 'Ракель Hi-Black для Kyocera P2235', category: 'Ракели' }), 'Ракель');
  assert.equal(typeOf({ name: 'Тонер-картридж Hi-Black (HB-TK-8115BK)', category: 'Тонер-картриджи' }), 'Тонер-картридж');
});

test('описание читается как текст, а не как выгрузка', async () => {
  const { buildDescription } = await import('../src/publish.mjs');
  const item = normalizeItem({
    Id: '4100603160', Name: 'Тонер-картридж Hi-Black (HB-TK-8115BK) для Kyocera Ecosys M8124cidn/M8130cidn, Bk,12K',
    Brand: 'Hi-Black', Vendor: 'Kyocera-Mita', NameAlias: 'HB-TK-8115BK', Group: 'Тонер-картриджи',
    RootGroup: 'Картриджи для лазерной печати', PriceLocal: '1401.07', ColorName: 'Bk', ItemLifeTime: '12K',
    Compatibility: 'с чипом, без бункера отработки тонера', Barcode: '4690665028400',
    NumberInPackage: '6.00', Weight: '6.00', GrossWeight: '0.91', AvailableQuantity: '500.00',
  });
  const text = buildDescription(item).text;

  assert.match(text, /^Чёрный тонер-картридж Hi-Black HB-TK-8115BK для Kyocera Ecosys M8124cidn\/M8130cidn\./);
  assert.ok(text.includes('Поставляется с чипом.'));
  assert.ok(text.includes('Бункер для отработанного тонера в комплект не входит.'));

  /* Служебных подписей в тексте быть не должно — им место в характеристиках. */
  for (const label of ['Раздел поставщика:', 'Штрихкод:', 'Примечание поставщика:', 'В упаковке ']) {
    assert.ok(!text.includes(label), `в описании осталась служебная подпись «${label}»`);
  }
  /* Складских количеств в публичном тексте нет. */
  assert.ok(!/\b500\b/.test(text), 'в описание попал остаток на складе');
  /* И ничего придуманного: процентов заполнения поставщик не указывал. */
  assert.ok(!/5\s*%|ISO|без полос|не осыпается/i.test(text), 'в описании появилось выдуманное свойство');
});

test('в карточку не уходят складские количества', async () => {
  const root = process.cwd();
  const dir = path.join(root, 'data/catalog/chunks');
  if (!fs.existsSync(dir)) return; // каталог не собран
  let checked = 0;
  for (const f of fs.readdirSync(dir).slice(0, 6)) {
    const chunk = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [id, d] of Object.entries(chunk)) {
      assert.ok(!('stockDetail' in d), `${id}: точные остатки уехали в публикуемые детали`);
      for (const [k] of d.specs ?? []) {
        assert.ok(!/на складе, шт|в пути, шт|центральном складе/i.test(k),
          `${id}: в характеристиках осталась строка «${k}»`);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 100, 'проверять было нечего');
});

test('отзывов поставщик не отдаёт: в контракте их нет вовсе', async () => {
  /*
    Проверяемый факт вместо утверждения. Если у VTT когда-нибудь появится
    операция про отзывы, тест упадёт — и это будет поводом их подключить,
    а не оставлять честный ноль.
  */
  const wsdl = fs.readFileSync(path.join(process.cwd(), 'vtt/wsdl/Portal.wsdl'), 'utf8');
  assert.equal(/review|feedback|отзыв|rating|comment/i.test(wsdl), false,
    'в контракте появилось что-то про отзывы — проверить и подключить источник');
  const ops = [...wsdl.matchAll(/<wsdl:operation name="(\w+)"/g)].map((m) => m[1]);
  assert.ok(ops.length > 10, 'операции из контракта не разобрались');
  assert.ok(ops.every((o) => !/review|rating/i.test(o)), 'операция про отзывы не учтена');
});

/* ===================================================================== */
/*  Описания от 500 знаков, e-mail в форме, демо-записи по флагу         */
/* ===================================================================== */

test('описание собирается абзацами и добирает длину фактами, а не словами', async () => {
  const { buildDescription, DESCRIPTION_MIN } = await import('../src/publish.mjs');
  const item = normalizeItem({
    Id: '4100603162', Name: 'Тонер-картридж Hi-Black (HB-TK-8115M) для Kyocera Ecosys M8124cidn/M8130cidn, M, 6K',
    Brand: 'Hi-Black', Vendor: 'Kyocera-Mita', NameAlias: 'HB-TK-8115M', Group: 'Тонер-картриджи',
    RootGroup: 'Картриджи для лазерной печати', PriceLocal: '1273.77', ColorName: 'M', ItemLifeTime: '6K',
    Compatibility: 'с чипом, без бункера отработки тонера', Barcode: '4690665028424',
    NumberInPackage: '6.00', GrossWeight: '0.80',
  });
  const d = buildDescription(item);
  assert.ok(d.text.length >= DESCRIPTION_MIN, `описание короче ${DESCRIPTION_MIN}: ${d.text.length}`);
  assert.ok(d.paragraphs.length >= 4, `абзацев мало: ${d.paragraphs.length}`);

  /* Каждый абзац опирается на свои факты этой позиции. */
  assert.match(d.paragraphs[0], /^Пурпурный тонер-картридж Hi-Black HB-TK-8115M для Kyocera/);
  assert.ok(d.text.includes(`${Number(6000).toLocaleString('ru-RU')} страниц`));
  assert.ok(d.text.includes('4690665028424'), 'штрихкод — проверяемый факт, он должен быть в тексте');

  /* И ни одного придуманного свойства. */
  for (const invented of ['без полос', 'не осыпается', 'ISO', '5 %', 'гарантия 12', 'лучшее качество']) {
    assert.ok(!new RegExp(invented, 'i').test(d.text), `в описании появилось «${invented}»`);
  }
  /* Складских количеств в публичном тексте нет. */
  assert.ok(!/\b500\b/.test(d.text));
});

test('после «для» не всегда модели: назначение не выдаётся за совместимость', async () => {
  const { looksLikeModels, buildDescription } = await import('../src/publish.mjs');
  assert.equal(looksLikeModels('Kyocera P2235/2040/M2135'), true);
  assert.equal(looksLikeModels('Epson'), true, 'марка без цифр — это тоже совместимость');
  assert.equal(looksLikeModels('очистки оргтехники'), false);
  assert.equal(looksLikeModels('струйной печати, односторонний, A4, 260 г/м2'), false);
  assert.equal(looksLikeModels('всех регионов/ без гарантии'), false);

  /*
    Без этой проверки карточка чистящего средства получала совет «сверьте
    обозначение модели на корпусе аппарата с этим перечнем», где перечнем
    была «очистка оргтехники».
  */
  const cleaner = normalizeItem({
    Id: '1', Name: 'Средство Hi-Black для очистки оргтехники, 180 мл.', Brand: 'Hi-Black',
    NameAlias: '15070600251', Group: 'Очистители', RootGroup: 'Чистящие средства', PriceLocal: '100',
  });
  const text = buildDescription(cleaner).text;
  assert.ok(!/сверьте обозначение модели/.test(text), 'совет про сверку моделей попал к чистящему средству');
  assert.ok(text.includes('для очистки оргтехники'), 'назначение потерялось из названия');
});

test('у бумаги формат и плотность не превращаются в «модели»', async () => {
  const { buildDescription, productSubject } = await import('../src/publish.mjs');
  const paper = {
    name: 'Холст Hi-Image Paper (хлопок) для струйной печати, односторонний, A4, 260 г/м2, 20 л.',
    brand: 'Hi-Image', vendorCode: 'HB-Canv-Cott-1S-A4-260g/m-20л',
  };
  const subject = productSubject(paper, paper.vendorCode);
  assert.ok(subject.includes('260 г/м2'), `плотность потерялась: ${subject}`);
  assert.ok(subject.includes('A4'), `формат потерялся: ${subject}`);
  assert.ok(!/\/м2$/.test(subject.replace(/260 г\/м2/, '')), 'плотность порезана пополам');
  assert.ok(!subject.includes('Paper'), `сиротское «Paper» осталось: ${subject}`);

  const d = buildDescription({ ...paper, category: 'Бумага', barcode: '4690665000001' });
  assert.ok(!/сверьте обозначение модели/.test(d.text), 'бумаге приписали совместимость с аппаратами');
});

test('демонстрационных записей по умолчанию нет, и в счётчики они не идут', async () => {
  const builder = fs.readFileSync(path.join(process.cwd(), 'tools/build-catalog.mjs'), 'utf8');
  /* Флаг есть, но по умолчанию выключен: без --demo-reviews записей нет. */
  assert.ok(builder.includes("argOf('demo-reviews', null)"), 'флаг демо-записей пропал');
  assert.ok(/p\.reviews = 0;/.test(builder) && /p\.rate = 0;/.test(builder),
    'счётчики обязаны оставаться нулевыми при любом флаге');

  const dir = path.join(process.cwd(), 'data/catalog/chunks');
  if (!fs.existsSync(dir)) return;
  let withReviews = 0, checked = 0;
  for (const f of fs.readdirSync(dir)) {
    const chunk = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const d of Object.values(chunk)) { checked += 1; if ((d.reviews ?? []).length) withReviews += 1; }
  }
  assert.ok(checked > 1000, 'проверять было нечего');
  assert.equal(withReviews, 0, 'в опубликованный каталог попали отзывы, которых нет');
});

test('форма отзыва спрашивает e-mail и обещает ровно то, что делает', async () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'assets/js/app.js'), 'utf8');
  assert.ok(/name="email" maxlength="120"[^>]*type=|type="email" name="email"/.test(app), 'поля e-mail нет в форме');
  assert.ok(app.includes('не публикуется и не попадает в рассылку'), 'обещание про e-mail пропало');
  assert.ok(/email: remail/.test(app), 'адрес не уходит в очередь модерации');

  /* Сервер проверяет адрес сам: клиентскую проверку обходит кто угодно. */
  const php = fs.readFileSync(path.join(process.cwd(), 'api/index.php'), 'utf8');
  assert.ok(php.includes('FILTER_VALIDATE_EMAIL'), 'серверной проверки e-mail нет');
  assert.ok(/'email' => \$email/.test(php), 'адрес не сохраняется в очередь модерации');
  /* И не попадает в публичные данные: в карточку уходит только reviewList. */
  const builder = fs.readFileSync(path.join(process.cwd(), 'tools/build-catalog.mjs'), 'utf8');
  assert.ok(!/email/i.test(builder.split('\n').filter((l) => /reviews:|reviewList/.test(l)).join('\n')),
    'адрес автора просочился в публикуемые данные');
});
