/*
  ItemDto → нормализованный товар.

  Два правила, которым подчинено всё остальное.

  1. Ничего не терять. Исходный DTO целиком сохраняется в `raw`, а
     нормализованные поля — это удобная проекция поверх него, а не замена.
     Если VTT добавит поле, оно окажется в raw и не потребует миграции.

  2. Ничего не выдумывать. Здесь нет ни одного значения по умолчанию,
     которое подменяло бы факт: нет ресурса — поле просто отсутствует, а
     товар попадает в отчёт о неполных данных. Придуманная характеристика
     в карточке хуже, чем её отсутствие.

  Остатки складываются только для показа «есть/нет» и никогда не
  суммируются в одно число: AvailableQuantity, TransitQuantity и
  MainOfficeQuantity — это три разных склада с разными сроками, и их
  сумма не означает ничего.
*/

/* Названия полей у VTT встречаются в нескольких написаниях, поэтому
   читаем по списку синонимов, а не по одному жёсткому ключу. */
const FIELD = {
  id: ['Id', 'ID', 'ItemId'],
  name: ['Name', 'ItemName'],
  vendorCode: ['Vendor', 'VendorCode', 'Article', 'Code'],
  originalNumber: ['OriginalNumber', 'OriginalNumbers', 'OriginalCode'],
  brand: ['Brand', 'Producer', 'Manufacturer'],
  categoryId: ['GroupId', 'CategoryId', 'GroupID'],
  group: ['Group', 'GroupName'],
  rootGroup: ['RootGroup', 'RootGroupName'],
  description: ['Description'],
  compatibility: ['Compatibility'],
  photoUrl: ['PhotoUrl', 'PhotoURL'],
  photoUrls: ['PhotoUrls', 'PhotoURLs'],
  price: ['Price'],
  priceRetail: ['PriceRetail'],
  available: ['AvailableQuantity'],
  transit: ['TransitQuantity'],
  transitDate: ['TransitDate'],
  mainOffice: ['MainOfficeQuantity'],
  barcode: ['Barcode'],
  color: ['ColorName', 'Color'],
  resource: ['Resource', 'ResourcePages', 'Yield'],
  width: ['Width'],
  height: ['Height'],
  depth: ['Depth'],
  weight: ['Weight'],
  inPackage: ['NumberInPackage', 'QuantityInPackage'],
};

function pick(raw, keys) {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
  }
  return undefined;
}

export function asText(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s === '' ? undefined : s;
}

export function asNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  /* Округление до шести знаков убирает артефакты двоичной дроби: 0.7+0.1
     в выгрузке превращалось в 0.7999999999999999 и в таком виде попадало
     прямо в карточку. Шести знаков хватает любому весу и габариту. */
  return Math.round(n * 1e6) / 1e6;
}

/* Целое неотрицательное: остаток «-1» или «много» — это не количество. */
export function asCount(value) {
  const n = asNumber(value);
  if (n === undefined || n < 0) return undefined;
  return Math.floor(n);
}

/* Списки у SOAP приходят и массивом, и одиночным значением, и строкой с
   разделителями — приводим к массиву без пустых элементов. */
export function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  const flat = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of flat) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      const inner = v.string ?? v.Url ?? v.PhotoUrl ?? Object.values(v)[0];
      out.push(...asList(inner));
      continue;
    }
    for (const part of String(v).split(/[;\n|]+/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return [...new Set(out)];
}

export function slugify(value) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return String(value).toLowerCase()
    .replace(/[а-яё]/g, (c) => map[c] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/* Совместимость — это список моделей принтеров. Формат у VTT свободный,
   поэтому режем по разделителям и чистим, но НЕ достраиваем: если модель
   не указана, она не появится. */
export function parseCompatibility(value) {
  const text = asText(value);
  if (!text) return [];
  return [...new Set(
    text.split(/[,;/\n]+|\s{2,}/)
      .map((s) => s.replace(/^[\s.•·-]+|[\s.•·-]+$/g, '').trim())
      .filter((s) => s.length >= 2 && s.length <= 80),
  )];
}

export const REQUIRED_FOR_CARD = ['name', 'vendorCode', 'price'];
export const RECOMMENDED_FOR_CARD = ['brand', 'category', 'compatibility', 'photos', 'resource'];

export function normalizeItem(raw, { now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('normalizeItem: ожидался объект ItemDto');

  const id = asText(pick(raw, FIELD.id));
  const name = asText(pick(raw, FIELD.name));
  const vendorCode = asText(pick(raw, FIELD.vendorCode));
  const photos = [...new Set([...asList(pick(raw, FIELD.photoUrl)), ...asList(pick(raw, FIELD.photoUrls))])];

  const item = {
    id: id ?? '',
    slug: slugify(vendorCode || name || id || ''),
    name,
    vendorCode,
    originalNumber: asText(pick(raw, FIELD.originalNumber)),
    brand: asText(pick(raw, FIELD.brand)),
    /* Идентификатор категории, если VTT его прислал: раскладка по Id
       точнее и устойчивее, чем по названию. */
    categoryId: asText(pick(raw, FIELD.categoryId)),
    category: asText(pick(raw, FIELD.group)),
    categoryRoot: asText(pick(raw, FIELD.rootGroup)),
    barcode: asText(pick(raw, FIELD.barcode)),
    color: asText(pick(raw, FIELD.color)),
    resource: asCount(pick(raw, FIELD.resource)),
    /* Описание поставщика хранится отдельно и никогда не смешивается с
       нормализованным и редакционным текстом — иначе после синка нельзя
       понять, где чей текст. */
    supplierDescription: asText(pick(raw, FIELD.description)),
    compatibility: parseCompatibility(pick(raw, FIELD.compatibility)),
    photos,
    dimensions: {
      width: asNumber(pick(raw, FIELD.width)),
      height: asNumber(pick(raw, FIELD.height)),
      depth: asNumber(pick(raw, FIELD.depth)),
    },
    weight: asNumber(pick(raw, FIELD.weight)),
    inPackage: asCount(pick(raw, FIELD.inPackage)),
    price: asNumber(pick(raw, FIELD.price)),
    priceRetail: asNumber(pick(raw, FIELD.priceRetail)),
    stock: {
      available: asCount(pick(raw, FIELD.available)),
      transit: asCount(pick(raw, FIELD.transit)),
      mainOffice: asCount(pick(raw, FIELD.mainOffice)),
      transitDate: asText(pick(raw, FIELD.transitDate)),
    },
    syncedAt: now,
  };

  /* Пустые значения не хранятся: так отчёт о неполных данных строится по
     наличию поля, а не по сравнению с «пустым» плейсхолдером. */
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) delete item[k];
  }
  for (const k of Object.keys(item.dimensions)) {
    if (item.dimensions[k] === undefined) delete item.dimensions[k];
  }
  if (!Object.keys(item.dimensions).length) delete item.dimensions;
  for (const k of Object.keys(item.stock)) {
    if (item.stock[k] === undefined) delete item.stock[k];
  }

  item.missing = [
    ...REQUIRED_FOR_CARD.filter((f) => item[f] === undefined),
    ...RECOMMENDED_FOR_CARD.filter((f) => {
      const v = item[f];
      return v === undefined || (Array.isArray(v) && v.length === 0);
    }),
  ];
  return item;
}

/* Оперативные данные приходят отдельным, более частым синком. Три склада
   остаются тремя полями — они не складываются. */
export function normalizeRuntime(raw, { now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('normalizeRuntime: ожидался объект ItemRuntimeDto');
  const out = {
    id: asText(pick(raw, FIELD.id)) ?? '',
    price: asNumber(pick(raw, FIELD.price)),
    priceRetail: asNumber(pick(raw, FIELD.priceRetail)),
    available: asCount(pick(raw, FIELD.available)),
    transit: asCount(pick(raw, FIELD.transit)),
    mainOffice: asCount(pick(raw, FIELD.mainOffice)),
    transitDate: asText(pick(raw, FIELD.transitDate)),
    syncedAt: now,
  };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}
