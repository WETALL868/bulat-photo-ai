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
  /*
    Артикул. Раньше здесь первым стоял `Vendor` — и это была ошибка,
    которую показала реальная выгрузка: `Vendor` у VTT содержит не код
    товара, а марку принтера, под который он подходит (HP, Kyocera-Mita,
    Canon — 33 значения на 9 483 строки). Артикул лежит в `NameAlias`
    (заполнен у всех строк) и дублируется в `OriginalNumber` у 80%.
  */
  vendorCode: ['NameAlias', 'VendorCode', 'Article', 'PartNumber', 'Code'],
  originalNumber: ['OriginalNumber', 'OriginalNumbers', 'OriginalCode'],
  brand: ['Brand', 'Producer', 'Manufacturer'],
  /* Марка техники, к которой подходит товар. Структурное поле — в отличие
     от свободного текста Compatibility, по нему можно фильтровать. */
  compatibleBrand: ['Vendor'],
  groupId: ['GroupId', 'CategoryId', 'GroupID'],
  group: ['Group', 'GroupName'],
  rootGroup: ['RootGroup', 'RootGroupName'],
  description: ['Description'],
  compatibility: ['Compatibility'],
  photoUrl: ['PhotoUrl', 'PhotoURL'],
  photoUrls: ['PhotoUrls', 'PhotoURLs'],
  /*
    Цены. `Price` и `PriceRetail` в выгрузке выражены НЕ в рублях:
    отношение PriceLocal/Price по всем 8 511 строкам с ненулевой ценой
    лежит в диапазоне 84,273–84,333 — это курс, а не разброс цен. Чип за
    0,19 «единиц» и за 16,02 ₽ — одна и та же позиция. Рублёвая цена
    только одна, `PriceLocal`, и именно она идёт на витрину.
  */
  priceLocal: ['PriceLocal'],
  priceForeign: ['Price'],
  priceRetailForeign: ['PriceRetail'],
  available: ['AvailableQuantity'],
  transit: ['TransitQuantity'],
  transitDate: ['TransitDate'],
  mainOffice: ['MainOfficeQuantity'],
  rest: ['RestQuantity'],
  reserved: ['Reserved'],
  barcode: ['Barcode'],
  color: ['ColorName', 'Color'],
  resource: ['Resource', 'ResourcePages', 'Yield'],
  /*
    Ресурс у VTT лежит в `ItemLifeTime`, а не в `Resource` — поля с таким
    именем в выгрузке нет вовсе, и из-за этого 3 273 позиции числились
    «без ресурса». Значение строковое и в трёх видах: «6K» и «1,52К»
    (латинская и кириллическая К — тысячи страниц), голое число
    («300000») и объём («100мл», «14,4 мл») у чернил. Объём страницами не
    является, поэтому разбирается отдельным полем.
  */
  lifeTime: ['ItemLifeTime'],
  /* Габариты и вес одной штуки: у VTT это «Gross*», тогда как Width/
     Height/Depth/Weight описывают транспортную упаковку из
     NumberInPackage штук. Разные величины, и смешивать их нельзя. */
  grossWidth: ['GrossWidth'],
  grossHeight: ['GrossHeight'],
  grossDepth: ['GrossDepth'],
  grossWeight: ['GrossWeight'],
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

/*
  Цена. Отрицательное значение ценой не является: у VTT так помечены 972
  позиции из 9 483 — «-1» вместо суммы. Показать «−1 ₽» на витрине или,
  что хуже, продать за эту сумму нельзя, поэтому такое значение означает
  «цены нет», а карточка честно говорит «по запросу».
*/
export function asPrice(value) {
  const n = asNumber(value);
  return n === undefined || n < 0 ? undefined : n;
}

/* Целое неотрицательное: остаток «-1» или «много» — это не количество. */
export function asCount(value) {
  const n = asNumber(value);
  if (n === undefined || n < 0) return undefined;
  return Math.floor(n);
}

/*
  Ресурс из `ItemLifeTime`.

  Разбираем только то, что написано, и ничего не достраиваем:
    «6K», «2,5K», «1,52К»  → тысячи страниц (К бывает и кириллическая);
    «300000», «600»        → страницы как есть;
    «100мл», «14,4 мл»     → это объём, а не ресурс — см. volumeOf.
  Всё остальное (а таких значений в выгрузке нет) остаётся неразобранным:
  показать непонятную строку как «ресурс» хуже, чем не показать ничего.
*/
export function resourcePages(value) {
  const s = asText(value);
  if (!s) return undefined;
  if (/мл\s*$/i.test(s)) return undefined;
  const k = /^(\d+(?:[.,]\d+)?)\s*[KКkк]$/.exec(s);
  if (k) return Math.round(asNumber(k[1]) * 1000);
  const plain = /^(\d+(?:[.,]\d+)?)$/.exec(s);
  if (plain) return asCount(plain[1]);
  return undefined;
}

/* Объём в миллилитрах — та же строка ItemLifeTime у чернил и тонера. */
export function volumeMl(value) {
  const s = asText(value);
  if (!s) return undefined;
  const m = /^(\d+(?:[.,]\d+)?)\s*мл$/i.exec(s);
  return m ? asNumber(m[1]) : undefined;
}

/*
  Повреждённая упаковка.

  Такие позиции VTT продаёт уценкой и помечает сразу в трёх местах:
  `Description` = «Поврежденная упаковка» (1 522 строки из 9 483),
  `Compatibility` с тем же текстом и пометка в самом названии («Повр.
  упак.», «ПУ», «П/У»). Признаки согласованы между собой, но берём
  объединение: пропустить такую позицию на витрину хуже, чем лишний раз
  проверить.

  Границы слова заданы явно. В JavaScript `\b` считает словом только
  латиницу с цифрами, поэтому у кириллического «ПУ» границы нет вовсе и
  проверка через `\bпу\b` молча не находит ничего.
*/
const PU_BOUND = '(^|[^\\p{L}\\p{N}])';
const PU_END = '($|[^\\p{L}\\p{N}])';
const PU_TEXT = /поврежд[её]нн|поврежденн/iu;
const PU_NAME = new RegExp(
  `${PU_BOUND}(повр\\.?\\s*(?:уп|упак)\\.?|поврежд[её]нн\\p{L}*|поврежденн\\p{L}*|п\\s*[/\\\\]\\s*у|пу)${PU_END}`,
  'iu',
);
export function isDamagedPackage({ name, description, compatibility } = {}) {
  return PU_TEXT.test(String(description ?? ''))
    || PU_TEXT.test(String(compatibility ?? ''))
    || PU_NAME.test(String(name ?? ''));
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
export const RECOMMENDED_FOR_CARD = ['brand', 'category', 'compatibilityText', 'photos', 'resource'];

/*
  Пригодная ссылка на фото. У VTT «нет картинки» выражается строкой
  `dummy.jpg` — так помечены 3 282 товара из 9 483. Если пропустить это
  значение дальше, карточка получит ссылку на несуществующий файл вместо
  честной заглушки, и вместо «фото не передано» покупатель увидит битое
  изображение.
*/
const PHOTO_STUBS = new Set(['dummy.jpg', 'dummy.jpeg', 'dummy.png', 'no-photo.jpg', 'nophoto.jpg']);

/*
  Хосты картинок, у которых проверено наличие HTTPS.

  Поставщик отдаёт адреса по http://, и на странице, открытой по https,
  браузер блокирует такую картинку как смешанный контент — молча, с
  naturalWidth 0 и пустым местом вместо товара. Проверено на живом
  preview: 1240C002 не грузился именно поэтому.

  Схему поднимаем только для хостов из этого списка и только потому, что
  у каждого из них https проверен вручную (b2b.vtt.ru отдаёт ту же
  картинку 646×444 по https). Делать это для любого хоста подряд нельзя:
  сервер без TLS после подмены схемы перестанет отвечать вовсе, и
  рабочая картинка превратится в битую — то есть лечение окажется хуже
  болезни.
*/
export const HTTPS_SAFE_IMAGE_HOSTS = new Set(['b2b.vtt.ru']);

export function upgradePhotoUrl(url) {
  const s = asText(url);
  if (!s) return s;
  const m = /^http:\/\/([^/:]+)(:\d+)?(\/.*)?$/i.exec(s);
  if (!m) return s;
  /* Нестандартный порт не трогаем: 80 по https не слушает никто. */
  if (m[2] && m[2] !== ':80') return s;
  if (!HTTPS_SAFE_IMAGE_HOSTS.has(m[1].toLowerCase())) return s;
  return `https://${m[1]}${m[3] ?? ''}`;
}
export function isPhotoUrl(value) {
  const s = asText(value);
  if (!s) return false;
  if (PHOTO_STUBS.has(s.toLowerCase())) return false;
  return /^https?:\/\/.+\.[a-z0-9]{2,5}(\?|$)/i.test(s);
}

/*
  PhotoUrls приходит из WCF как сериализованный список строк:
  {"string":["http://…jpg","http://…jpg"]}. У 6 201 товара он непустой, и
  до 12 картинок на карточку. Разбирается и как JSON, и как обычный
  список — форма зависит от того, пришли данные из SOAP или из CSV.
*/
export function photoUrlList(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const list = Array.isArray(parsed) ? parsed : (parsed?.string ?? parsed?.Url ?? []);
      return asList(list);
    } catch {
      /* Не JSON — значит обычная строка со ссылками, разбираем как список. */
    }
  }
  return asList(value);
}

export function normalizeItem(raw, { now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('normalizeItem: ожидался объект ItemDto');

  const id = asText(pick(raw, FIELD.id));
  const name = asText(pick(raw, FIELD.name));
  const vendorCode = asText(pick(raw, FIELD.vendorCode));
  /* Исходные адреса поставщика сохраняются отдельно и не подменяются:
     по ним работает этап загрузки картинок и по ним же видно, что
     именно прислал VTT. На витрину идут они же, но по https. */
  const photosOriginal = [...new Set([
    ...asList(pick(raw, FIELD.photoUrl)),
    ...photoUrlList(pick(raw, FIELD.photoUrls)),
  ])].filter(isPhotoUrl);
  const photos = [...new Set(photosOriginal.map(upgradePhotoUrl))];

  const item = {
    id: id ?? '',
    slug: slugify(vendorCode || name || id || ''),
    name,
    vendorCode,
    originalNumber: asText(pick(raw, FIELD.originalNumber)),
    brand: asText(pick(raw, FIELD.brand)),
    compatibleBrand: asText(pick(raw, FIELD.compatibleBrand)),
    /* Идентификатор категории в том виде, в каком его прислал VTT.
       Хранится отдельно от categoryId: categoryId — это уже наше решение
       о разделе витрины (оно может прийти из GetCategoryItems или из
       разбора названий), а groupId — факт от поставщика. Смешивать их в
       одном поле нельзя: тогда по карточке не отличить присланное от
       вычисленного, и изменение у поставщика теряется. */
    groupId: asText(pick(raw, FIELD.groupId)),
    category: asText(pick(raw, FIELD.group)),
    categoryRoot: asText(pick(raw, FIELD.rootGroup)),
    barcode: asText(pick(raw, FIELD.barcode)),
    color: asText(pick(raw, FIELD.color)),
    /* Сначала явное поле ресурса (в реальной выгрузке его нет), затем
       ItemLifeTime. Объём чернил живёт отдельно и ресурсом не
       притворяется. */
    resource: asCount(pick(raw, FIELD.resource)) ?? resourcePages(pick(raw, FIELD.lifeTime)),
    volumeMl: volumeMl(pick(raw, FIELD.lifeTime)),
    /* Строка поставщика сохраняется как есть: по ней видно, что именно
       разобрано в resource, и что осталось неразобранным. */
    lifeTime: asText(pick(raw, FIELD.lifeTime)),
    /* Описание поставщика хранится отдельно и никогда не смешивается с
       нормализованным и редакционным текстом — иначе после синка нельзя
       понять, где чей текст. */
    supplierDescription: asText(pick(raw, FIELD.description)),
    /* Свободный текст поставщика сохраняется целиком и показывается как
       есть. Резать его на «совместимые модели» нельзя: в одном и том же
       поле лежат и списки моделей, и «Повреждённая упаковка», и «с
       чипом», и «Позиция снята с производства». Структурные модели даёт
       отдельная операция GetGoodsCompatibilityInformation. */
    compatibilityText: asText(pick(raw, FIELD.compatibility)),
    photos,
    photosOriginal: photosOriginal.some((u, i) => u !== photos[i]) ? photosOriginal : undefined,
    /*
      Габариты транспортной упаковки. Единицы измерения поставщик НЕ
      указывает, и вычислить их по выгрузке не получается: сверка
      GrossVolume с произведением GrossWidth × GrossHeight × GrossDepth
      сходится лишь у 815 позиций из 878, где заполнены все четыре поля,
      а у остальных расходится в разы. Поэтому числа хранятся и
      показываются без единицы: подпись «см» при 0,38 × 0,45 × 0,57 —
      это утверждение о размере, которого никто не подтверждал.
    */
    dimensions: {
      width: asNumber(pick(raw, FIELD.width)),
      height: asNumber(pick(raw, FIELD.height)),
      depth: asNumber(pick(raw, FIELD.depth)),
    },
    /* Габариты и вес одной штуки — отдельно от упаковки. */
    grossDimensions: {
      width: asNumber(pick(raw, FIELD.grossWidth)),
      height: asNumber(pick(raw, FIELD.grossHeight)),
      depth: asNumber(pick(raw, FIELD.grossDepth)),
    },
    grossWeight: asNumber(pick(raw, FIELD.grossWeight)),
    weight: asNumber(pick(raw, FIELD.weight)),
    inPackage: asCount(pick(raw, FIELD.inPackage)),
    /* Повреждённая упаковка. Признак снимается на нормализации, а не на
       публикации: он приходит от поставщика, и место ему рядом с
       остальными его фактами. */
    packageDamaged: isDamagedPackage({
      name: pick(raw, FIELD.name),
      description: pick(raw, FIELD.description),
      compatibility: pick(raw, FIELD.compatibility),
    }) || undefined,
    /* Рублёвая цена — единственная, которую можно показать покупателю.
       Валютная сохраняется отдельно и в рубли не пересчитывается: курс
       поставщика — его дело, а придуманный курс на витрине был бы
       ошибкой в деньгах. */
    price: asPrice(pick(raw, FIELD.priceLocal)) ?? asPrice(pick(raw, FIELD.priceForeign)),
    /* Откуда взята цена, видно в самой карточке. Если PriceLocal в ответе
       не пришёл, цена берётся из Price — но помечается как валюта
       неподтверждённая, и это уходит в отчёт публикации. Молча показать
       двадцать один «рубль» вместо тысячи семисот — ошибка в деньгах, и
       она не должна быть незаметной. */
    priceSource: asPrice(pick(raw, FIELD.priceLocal)) !== undefined ? 'PriceLocal'
      : (asPrice(pick(raw, FIELD.priceForeign)) !== undefined ? 'Price' : undefined),
    priceForeign: asPrice(pick(raw, FIELD.priceForeign)),
    priceRetailForeign: asPrice(pick(raw, FIELD.priceRetailForeign)),
    stock: {
      available: asCount(pick(raw, FIELD.available)),
      transit: asCount(pick(raw, FIELD.transit)),
      mainOffice: asCount(pick(raw, FIELD.mainOffice)),
      rest: asCount(pick(raw, FIELD.rest)),
      reserved: asCount(pick(raw, FIELD.reserved)),
      transitDate: asText(pick(raw, FIELD.transitDate)),
    },
    syncedAt: now,
  };

  /* Пустые значения не хранятся: так отчёт о неполных данных строится по
     наличию поля, а не по сравнению с «пустым» плейсхолдером. */
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) delete item[k];
  }
  for (const key of ['dimensions', 'grossDimensions']) {
    if (!item[key]) continue;
    for (const k of Object.keys(item[key])) {
      if (item[key][k] === undefined) delete item[key][k];
    }
    if (!Object.keys(item[key]).length) delete item[key];
  }
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

/*
  ItemRuntimeDto по официальному WSDL — ровно пять полей:
  Id, Price, AvailableQuantity, TransitQuantity, MainOfficeQuantity.
  PriceRetail и TransitDate в оперативном DTO НЕТ: раньше я их здесь ждал,
  и это было предположение. Они приходят только в ItemDto.

  Важнее другое, и это видно только на реальных данных. PriceLocal в
  оперативном DTO тоже нет — а `Price` там та же валютная цена, что и в
  ItemDto: 21,27 против 1 793,06 ₽ у одной и той же позиции. Положить её
  в поле рублёвой цены значило бы уронить ценник каталога в восемьдесят
  четыре раза. Поэтому здесь она и называется валютной, а перевод в рубли
  делает витрина — по курсу самого поставщика, снятому с этой же позиции
  на полной выгрузке.

  Три склада остаются тремя полями и не суммируются.
*/
export function normalizeRuntime(raw, { now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('normalizeRuntime: ожидался объект ItemRuntimeDto');
  const out = {
    id: asText(pick(raw, FIELD.id)) ?? '',
    priceForeign: asNumber(pick(raw, FIELD.priceForeign)),
    available: asCount(pick(raw, FIELD.available)),
    transit: asCount(pick(raw, FIELD.transit)),
    mainOffice: asCount(pick(raw, FIELD.mainOffice)),
    syncedAt: now,
  };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}

/*
  CompatibilityDto = ItemId, ModelBrand, ModelCategoryName, ModelName.

  Это заметно лучше строки Compatibility: бренд и модель приходят
  отдельными полями, поэтому и подбор по принтеру, и фильтры строятся на
  данных, а не на разборе текста разделителями. Строку оставляем запасным
  вариантом — на случай, если метод недоступен учётной записи.
*/
export function normalizeCompatibility(rows = []) {
  const byItem = new Map();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const itemId = asText(pick(raw, ['ItemId', 'Id']));
    if (!itemId) continue;
    const entry = {
      brand: asText(pick(raw, ['ModelBrand'])),
      categoryName: asText(pick(raw, ['ModelCategoryName'])),
      model: asText(pick(raw, ['ModelName'])),
    };
    if (!entry.brand && !entry.model) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    const list = byItem.get(itemId);
    /* Один и тот же принтер приходит по нескольку раз — например, из
       разных категорий модели. На витрине это был бы дубликат. */
    const key = `${entry.brand ?? ''}|${entry.model ?? ''}`;
    if (!list.some((x) => `${x.brand ?? ''}|${x.model ?? ''}` === key)) list.push(entry);
  }
  return byItem;
}

/* Человекочитаемая модель: «Kyocera ECOSYS M2035dn». Бренд не дублируется,
   если он уже входит в название модели. */
export function compatibilityLabel(entry) {
  const brand = entry.brand ?? '';
  const model = entry.model ?? '';
  if (!brand) return model;
  if (!model) return brand;
  return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`;
}

/*
  AdditionalAttributeDto = CategoryId, ItemId, IntValue, StringValue.

  У атрибута нет имени — только категория, к которой он относится, и одно
  из двух значений. Поэтому он сохраняется как есть и НЕ превращается в
  «характеристику с подписью»: придумать подпись значило бы выдумать смысл,
  которого в данных нет. Показывать такие значения на карточке можно будет
  только после того, как VTT подтвердит, что означает каждый CategoryId.
*/
export function normalizeAttributes(rows = []) {
  const byItem = new Map();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const itemId = asText(pick(raw, ['ItemId', 'Id']));
    if (!itemId) continue;
    const attr = {
      categoryId: asText(pick(raw, ['CategoryId'])),
      intValue: asNumber(pick(raw, ['IntValue'])),
      stringValue: asText(pick(raw, ['StringValue'])),
    };
    for (const k of Object.keys(attr)) if (attr[k] === undefined) delete attr[k];
    if (attr.intValue === undefined && attr.stringValue === undefined) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(attr);
  }
  return byItem;
}

/* Связанные товары: только идентификаторы. Карточки для них уже есть в
   сторе, дублировать их незачем. */
export function normalizeRelated(rows = []) {
  return [...new Set(rows.map((r) => asText(pick(r ?? {}, ['Id', 'ItemId']))).filter(Boolean))];
}
