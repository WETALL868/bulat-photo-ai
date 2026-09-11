/*
  Мок сервиса VTT: отвечает настоящими SOAP-конвертами.

  Смысл именно в конвертах, а не в подмене клиента объектом. Мок
  подставляется на уровне fetch, поэтому через него проходит весь
  настоящий путь: сборка конверта, HTTP-вызов, разбор XML, разворачивание
  DTO, классификация ошибок. Подмени мы клиент целиком — этот путь остался
  бы непроверенным, и первая же встреча с живым VTT стала бы первой
  проверкой парсера.

  Мок воспроизводит фактическую пагинацию VTT: запрос 0..N отдаёт строки
  [0, N), а запрос N+1..M — строки [N, M). Именно это поведение подтверждено
  рабочим клиентом-референсом и его тестами.
*/
import { xmlEscape } from '../src/soap.mjs';

export const SAMPLE_CATEGORIES = [
  { Id: '100', Name: 'Расходные материалы', ParentId: null },
  { Id: '110', Name: 'Картриджи лазерные', ParentId: '100' },
  { Id: '120', Name: 'Тонеры', ParentId: '100' },
  { Id: '130', Name: 'Картриджи струйные', ParentId: '100' },
  { Id: '200', Name: 'Запчасти', ParentId: null },
  { Id: '210', Name: 'Термоплёнки', ParentId: '200' },
];

/* Номенклатура выдумана как тестовая, но форма записи повторяет реальный
   ItemDto: те же имена полей и те же типы значений. */
function makeItem(i) {
  const brands = ['Hi-Black', 'Hi-Black', 'Hi-Black'];
  const groups = [
    { id: '110', name: 'Картриджи лазерные', root: 'Расходные материалы' },
    { id: '120', name: 'Тонеры', root: 'Расходные материалы' },
    { id: '130', name: 'Картриджи струйные', root: 'Расходные материалы' },
    { id: '210', name: 'Термоплёнки', root: 'Запчасти' },
  ];
  const g = groups[i % groups.length];
  const colors = ['Чёрный', 'Голубой', 'Пурпурный', 'Жёлтый'];
  return {
    Id: `VTT-${String(i).padStart(5, '0')}`,
    Name: `Картридж Hi-Black HB-TK-${1100 + i} для Kyocera ECOSYS M${2035 + i}dn`,
    Vendor: `HB-TK-${1100 + i}`,
    OriginalNumber: `TK-${1100 + i}`,
    Brand: brands[i % brands.length],
    Group: g.name,
    GroupId: g.id,
    RootGroup: g.root,
    Description: `Картридж для лазерной печати. Совместим с перечисленными моделями.`,
    Compatibility: `Kyocera ECOSYS M${2035 + i}dn; Kyocera ECOSYS P${2035 + i}dn; Kyocera FS-${1040 + i}`,
    PhotoUrl: `https://example.invalid/vtt/photo/${i}.jpg`,
    PhotoUrls: [`https://example.invalid/vtt/photo/${i}.jpg`, `https://example.invalid/vtt/photo/${i}-b.jpg`],
    Price: 1200 + i * 7,
    PriceRetail: 1500 + i * 9,
    AvailableQuantity: i % 13,
    TransitQuantity: i % 5,
    MainOfficeQuantity: i % 3,
    TransitDate: '2026-10-01',
    Barcode: `46000000${String(i).padStart(5, '0')}`,
    ColorName: colors[i % colors.length],
    Resource: 1500 + (i % 7) * 1000,
    Width: 30 + (i % 5),
    Height: 12 + (i % 4),
    Depth: 9 + (i % 3),
    Weight: 0.7 + (i % 5) / 10,
    NumberInPackage: 1,
  };
}

export function makeItems(count) {
  return Array.from({ length: count }, (_, i) => makeItem(i));
}

function itemToXml(item, element) {
  const parts = [];
  for (const [k, v] of Object.entries(item)) {
    if (v === null || v === undefined) { parts.push(`<a:${k} i:nil="true"/>`); continue; }
    if (Array.isArray(v)) {
      parts.push(`<a:${k}>${v.map((x) => `<b:string>${xmlEscape(x)}</b:string>`).join('')}</a:${k}>`);
      continue;
    }
    parts.push(`<a:${k}>${xmlEscape(v)}</a:${k}>`);
  }
  return `<a:${element}>${parts.join('')}</a:${element}>`;
}

export function portionEnvelope(operation, element, items, totalCount) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<s:Body>' +
    `<${operation}Response xmlns="http://portal.vtt.ru">` +
    `<${operation}Result xmlns:a="http://portal.vtt.ru/data" ` +
    'xmlns:b="http://schemas.microsoft.com/2003/10/Serialization/Arrays" ' +
    'xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    `<a:TotalCount>${totalCount}</a:TotalCount>` +
    `<a:Items>${items.map((it) => itemToXml(it, element)).join('')}</a:Items>` +
    `</${operation}Result>` +
    `</${operation}Response>` +
    '</s:Body></s:Envelope>';
}

/* Списочные операции WSDL отдают просто массив DTO, без TotalCount —
   в отличие от порционных. */
export function listEnvelope(operation, element, rows) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    `<${operation}Response xmlns="http://portal.vtt.ru">` +
    `<${operation}Result xmlns:a="http://portal.vtt.ru/data" ` +
    'xmlns:b="http://schemas.microsoft.com/2003/10/Serialization/Arrays" ' +
    'xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    rows.map((r) => itemToXml(r, element)).join('') +
    `</${operation}Result></${operation}Response></s:Body></s:Envelope>`;
}

export function faultEnvelope(code, text) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
    `<faultcode>${xmlEscape(code)}</faultcode><faultstring>${xmlEscape(text)}</faultstring>` +
    '</s:Fault></s:Body></s:Envelope>';
}

function categoriesEnvelope(cats) {
  const body = cats.map((c) =>
    `<a:CategoryDto><a:Id>${xmlEscape(c.Id)}</a:Id><a:Name>${xmlEscape(c.Name)}</a:Name>` +
    (c.ParentId ? `<a:ParentId>${xmlEscape(c.ParentId)}</a:ParentId>` : '<a:ParentId i:nil="true"/>') +
    '</a:CategoryDto>').join('');
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<GetCategoriesResponse xmlns="http://portal.vtt.ru">' +
    '<GetCategoriesResult xmlns:a="http://portal.vtt.ru/data" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    body + '</GetCategoriesResult></GetCategoriesResponse></s:Body></s:Envelope>';
}

/* Разбор запроса нужен, чтобы мок реагировал на реальные аргументы:
   именно так проверяется, что клиент послал правильные from/to. */
function readArg(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? m[1] : undefined;
}
function operationOf(xml) {
  const m = xml.match(/<soap:Body><(?:\w+:)?(\w+)>/);
  return m ? m[1] : '';
}

/*
  Фабрика fetch-совместимого мока.

  options:
    items          — набор ItemDto
    categories     — ответ GetCategories, либо null чтобы операция была «недоступна»
    compatibility  — true/false доступности GetGoodsCompatibilityInformation
    failFirst      — сколько первых вызовов уронить сетевой ошибкой (проверка retry)
    badCredentials — вернуть Fault авторизации
*/
export function createMockFetch({
  items = makeItems(1200),
  categories = SAMPLE_CATEGORIES,
  compatibility = true,
  attributes = true,
  related = true,
  categoryItems = true,
  failFirst = 0,
  badCredentials = false,
  onCall,
} = {}) {
  let failures = 0;
  const calls = [];
  const mock = async (url, init) => {
    const xml = String(init?.body ?? '');
    const op = operationOf(xml);
    const from = Number(readArg(xml, 'from'));
    const to = Number(readArg(xml, 'to'));
    calls.push({ op, from, to });
    onCall?.({ op, from, to, xml });

    if (failures < failFirst) { failures += 1; throw new TypeError('fetch failed'); }
    if (badCredentials) {
      return new Response(faultEnvelope('s:Client', 'Authentication failed: неверный логин или пароль'), { status: 500 });
    }
    if (op === 'GetCategories') {
      if (!categories) return new Response(faultEnvelope('s:Client', 'Method not found'), { status: 500 });
      return new Response(categoriesEnvelope(categories), { status: 200 });
    }
    if (op === 'GetGoodsCompatibilityInformation') {
      if (!compatibility) return new Response(faultEnvelope('s:Client', 'Method not allowed for this account'), { status: 500 });
      const itemId = readArg(xml, 'itemId');
      const rows = (itemId ? items.filter((i) => i.Id === itemId) : items).flatMap((i) => [
        { ItemId: i.Id, ModelBrand: 'Kyocera', ModelCategoryName: 'Принтеры', ModelName: `ECOSYS M${2035 + Number(String(i.Id).slice(-3))}dn` },
        { ItemId: i.Id, ModelBrand: 'Kyocera', ModelCategoryName: 'МФУ', ModelName: `ECOSYS P${2035 + Number(String(i.Id).slice(-3))}dn` },
      ]);
      return new Response(listEnvelope('GetGoodsCompatibilityInformation', 'CompatibilityDto', rows), { status: 200 });
    }
    if (op === 'GetAdditionalAttributes') {
      if (!attributes) return new Response(faultEnvelope('s:Client', 'Method not allowed for this account'), { status: 500 });
      const itemId = readArg(xml, 'itemId');
      const rows = (itemId ? items.filter((i) => i.Id === itemId) : items).map((i) => ({
        CategoryId: '7', ItemId: i.Id, IntValue: i.Resource, StringValue: i.ColorName,
      }));
      return new Response(listEnvelope('GetAdditionalAttributes', 'AdditionalAttributeDto', rows), { status: 200 });
    }
    if (op === 'GetRelatedItems') {
      if (!related) return new Response(faultEnvelope('s:Client', 'Method not allowed for this account'), { status: 500 });
      const itemId = readArg(xml, 'itemId');
      const idx = items.findIndex((i) => i.Id === itemId);
      const rows = idx >= 0 ? items.slice(idx + 1, idx + 3) : [];
      return new Response(listEnvelope('GetRelatedItems', 'ItemDto', rows), { status: 200 });
    }
    if (op === 'GetCategoryItems' || op === 'GetCategoryRuntimeItems') {
      if (!categoryItems) return new Response(faultEnvelope('s:Client', 'Method not allowed for this account'), { status: 500 });
      const catId = readArg(xml, 'categoryId');
      const rows = items.filter((i) => String(i.GroupId) === String(catId));
      const el = op === 'GetCategoryItems' ? 'ItemDto' : 'ItemRuntimeDto';
      return new Response(listEnvelope(op, el, rows), { status: 200 });
    }
    if (op === 'GetItem' || op === 'GetRuntimeItem') {
      const itemId = readArg(xml, 'itemId');
      const rows = items.filter((i) => i.Id === itemId);
      return new Response(listEnvelope(op, op === 'GetItem' ? 'ItemDto' : 'ItemRuntimeDto', rows), { status: 200 });
    }
    /* Фактические границы VTT: 0..N отдаёт [0,N), далее N+1..M отдаёт [N,M). */
    const first = from === 0 ? 0 : from - 1;
    const slice = items.slice(first, to);
    const element = op === 'GetRuntimeItemsPortion' ? 'ItemRuntimeDto' : 'ItemDto';
    const payload = op === 'GetRuntimeItemsPortion'
      /* ItemRuntimeDto по WSDL — ровно пять полей. PriceRetail и
         TransitDate в оперативном DTO нет, и мок их не выдумывает. */
      ? slice.map((i) => ({
          Id: i.Id, Price: i.Price,
          AvailableQuantity: i.AvailableQuantity, TransitQuantity: i.TransitQuantity,
          MainOfficeQuantity: i.MainOfficeQuantity,
        }))
      : slice;
    return new Response(portionEnvelope(op, element, payload, Math.min(to, items.length)), { status: 200 });
  };
  mock.calls = calls;
  return mock;
}
