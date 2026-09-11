/*
  Стор VTT → товары витрины.

  Здесь проходит граница между «что у поставщика» и «что на сайте».

  Фильтр публикации сужает витрину, но не стор. Полный набор всегда лежит
  в vtt-data целиком: фильтр решает, что показать, и его можно поменять
  без новой выгрузки. Обратное было бы ловушкой — сужение на этапе
  выгрузки незаметно обрезает историю.

  Скрытые товары на витрину не попадают. Товар, пропавший из выгрузки,
  помечен inactive и остаётся в сторе, но в каталоге его нет: продавать
  то, чего у поставщика больше нет, нельзя.

  Описание собирается только из фактов. Каждое предложение опирается на
  конкретное поле ItemDto, и если поля нет — предложения тоже нет.
  Ни характеристик, ни сертификатов, ни гарантий, ни «совместим также с»
  здесь не появляется: выдуманная строка в карточке дороже пустого места.
*/
import { slugify } from './normalize.mjs';

export const DESCRIPTION_VERSION = 1;

/* Тип расходника выводится из категории и названия — но только если он там
   действительно назван. Ничего не додумывается по «похожести». */
const TYPE_RULES = [
  [/тонер-?картридж|тонер\s*картридж/i, 'Тонер-картридж'],
  [/картридж/i, 'Картридж'],
  [/тонер/i, 'Тонер'],
  [/чернил/i, 'Чернила'],
  [/фотобараб|драм|drum/i, 'Фотобарабан'],
  [/термоплён|термоплен|термопленк/i, 'Термоплёнка'],
  [/ролик/i, 'Ролик'],
  [/бумаг/i, 'Бумага'],
];
export function typeOf(item) {
  const hay = `${item.category ?? ''} ${item.name ?? ''}`;
  for (const [re, label] of TYPE_RULES) if (re.test(hay)) return label;
  return item.category ?? null;
}

const fmt = (n) => Number(n).toLocaleString('ru-RU');

/*
  Список совместимых моделей. Источников два, и порядок между ними не
  случаен: GetGoodsCompatibilityInformation отдаёт бренд и модель
  отдельными полями, а строка Compatibility в ItemDto — это свободный
  текст, который приходится резать разделителями. Поэтому официальные
  данные предпочтительнее, а строка остаётся запасным вариантом там, где
  операция недоступна учётной записи. Оба поля хранятся в сторе рядом и не
  затирают друг друга.
*/
export function modelsOf(item) {
  const official = item.compatibilityLabels ?? [];
  if (official.length) return official;
  return item.compatibility ?? [];
}

/*
  Детерминированное описание. При тех же данных получается тот же текст —
  это важно и для повторной сборки, и для того, чтобы diff показывал
  реальные изменения, а не перестановку слов.
*/
export function buildDescription(item) {
  const facts = [];
  const type = typeOf(item);
  const head = [type, item.vendorCode && `${item.vendorCode}`].filter(Boolean).join(' ');

  if (head) {
    const brand = item.brand ? ` производства ${item.brand}` : '';
    facts.push(`${head}${brand}.`);
  }
  if (item.originalNumber) facts.push(`Оригинальный номер: ${item.originalNumber}.`);
  if (item.resource) facts.push(`Заявленный ресурс — ${fmt(item.resource)} страниц.`);
  if (item.color) facts.push(`Цвет: ${item.color.toLowerCase()}.`);

  const models = modelsOf(item);
  if (models.length) {
    const list = models.slice(0, 12).join(', ');
    const more = models.length > 12 ? ` и ещё ${models.length - 12} моделей` : '';
    facts.push(`Совместимость по данным поставщика: ${list}${more}.`);
  }

  const d = item.dimensions;
  if (d && (d.width || d.height || d.depth)) {
    const dims = [d.width, d.height, d.depth].filter((v) => v !== undefined).map((v) => fmt(v)).join(' × ');
    facts.push(`Габариты упаковки: ${dims} см.`);
  }
  if (item.weight) facts.push(`Вес: ${fmt(item.weight)} кг.`);
  if (item.inPackage && item.inPackage > 1) facts.push(`В упаковке ${fmt(item.inPackage)} шт.`);
  if (item.barcode) facts.push(`Штрихкод: ${item.barcode}.`);

  return {
    text: facts.join(' '),
    /* Из каких полей собран текст — чтобы потом было видно, почему
       описание короткое, и чтобы редактор понимал, что можно дополнить. */
    basedOn: Object.keys({
      ...(type ? { type: 1 } : {}), ...(item.vendorCode ? { vendorCode: 1 } : {}),
      ...(item.brand ? { brand: 1 } : {}), ...(item.originalNumber ? { originalNumber: 1 } : {}),
      ...(item.resource ? { resource: 1 } : {}), ...(item.color ? { color: 1 } : {}),
      ...(models.length ? { compatibility: 1 } : {}),
      ...(d && (d.width || d.height || d.depth) ? { dimensions: 1 } : {}),
      ...(item.weight ? { weight: 1 } : {}), ...(item.inPackage > 1 ? { inPackage: 1 } : {}),
      ...(item.barcode ? { barcode: 1 } : {}),
    }),
    version: DESCRIPTION_VERSION,
  };
}

export function matchesFilter(item, filter = {}) {
  const brands = (filter.brands ?? []).map((s) => s.toLowerCase());
  const exclude = (filter.excludeBrands ?? []).map((s) => s.toLowerCase());
  const cats = filter.categories ?? [];
  const brand = (item.brand ?? '').toLowerCase();
  if (exclude.length && exclude.includes(brand)) return false;
  if (brands.length && !brands.includes(brand)) return false;
  if (cats.length && !cats.includes(item.categoryId) && !cats.includes(item.category)) return false;
  return true;
}

/*
  Наличие. Три склада остаются тремя числами, а «в наличии» означает
  строго доступный остаток — не сумму с транзитом: транзит это «будет»,
  а не «есть».
*/
export function availabilityOf(item) {
  const rt = item.runtime ?? {};
  const available = rt.available ?? item.stock?.available ?? 0;
  const transit = rt.transit ?? item.stock?.transit ?? 0;
  const mainOffice = rt.mainOffice ?? item.stock?.mainOffice ?? 0;
  return { available, transit, mainOffice, inStock: available > 0 };
}

/*
  Пригодность ссылки на фото. Битую ссылку лучше отсечь на сборке, чем
  показать покупателю сломанную картинку: у карточки есть корректное
  состояние «фото не передано», и оно честнее пустого прямоугольника.

  Проверяется только форма ссылки — сборка сайта в сеть не ходит.
  Фактическая загрузка и оптимизация выполняются отдельным шагом импорта
  изображений, который и пишет в отчёт недоступные адреса.
*/
export const PHOTO_PLACEHOLDER = '/assets/img/no-photo.svg';

export function usablePhoto(url) {
  if (typeof url !== 'string' || !url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname;
    /* Зарезервированные RFC 2606 имена не резолвятся никогда — такие
       адреса в выгрузке означают «фото нет». */
    if (/\.(invalid|example|test|localhost)$/i.test(host)) return false;
    return true;
  } catch { return false; }
}

export function priceOf(item) {
  const rt = item.runtime ?? {};
  const price = rt.price ?? item.price;
  const retail = rt.priceRetail ?? item.priceRetail;
  return { price, retail };
}

/*
  Товар витрины. Форма совпадает с той, что уже принимает сборщик
  каталога, — иначе пришлось бы переписывать витрину ради нового источника.
  Редакционные правки накладываются поверх и не затираются синком: они
  живут в отдельном файле и применяются здесь, при публикации.
*/
export function toShopProduct(item, { editorial = {}, categoryPath = [], shopCat, shopBrand } = {}) {
  const { price, retail } = priceOf(item);
  const av = availabilityOf(item);
  const description = buildDescription(item);
  const edit = editorial[item.id] ?? {};

  return {
    id: item.slug || slugify(item.id),
    vttId: item.id,
    name: edit.name ?? item.name ?? item.vendorCode ?? item.id,
    code: item.vendorCode ?? '',
    model: (item.vendorCode ?? '').replace(/^HB-/i, ''),
    originalNumber: item.originalNumber ?? '',
    /* Две системы категорий живут рядом и не подменяют друг друга:
       `cat` — раздел витрины (лазерные, струйные, тонеры…), `vttCategoryId`
       и `catPath` — место товара в дереве поставщика. Терять второе нельзя:
       по нему строится отчёт о раскладке и проверяется полнота импорта. */
    cat: shopCat ? shopCat(item) : (item.categoryId ?? ''),
    vttCategoryId: item.categoryId ?? '',
    vttCategory: item.category ?? '',
    catPath: categoryPath,
    brand: shopBrand ? shopBrand(item) : (item.brand ?? ''),
    supplierBrand: item.brand ?? '',
    type: typeOf(item) ?? '',
    res: item.resource ?? null,
    color: item.color ?? '',
    chip: null,
    compat: modelsOf(item).join(', '),
    models: modelsOf(item),
    equip: '', tech: '', print: '',
    weight: item.weight ?? '',
    img: usablePhoto(item.photos?.[0]) ? item.photos[0] : PHOTO_PLACEHOLDER,
    images: (item.photos ?? []).filter(usablePhoto),
    photoMissing: !usablePhoto(item.photos?.[0]),
    /* Три текста живут раздельно и никогда не перезаписывают друг друга. */
    supplierDescription: item.supplierDescription ?? '',
    description: description.text,
    descriptionBasedOn: description.basedOn,
    editorialDescription: edit.description ?? '',
    /* Рейтинг и отзывы у импортированных товаров пустые: настоящих отзывов
       ещё нет, а придумывать их нельзя. Демо-отзывы для preview живут
       отдельно и в эти счётчики не попадают. */
    rate: 0, reviews: 0, pop: 50, badge: '',
    price: price ?? 0,
    old: retail && price && retail > price ? retail : 0,
    stock: av.inStock ? 1 : 0,
    stockDetail: { available: av.available, transit: av.transit, mainOffice: av.mainOffice },
    source: 'vtt',
    missing: item.missing ?? [],
  };
}

/*
  Публикация всего стора. Возвращает и товары, и отчёт: какие пропущены
  фильтром, какие скрыты, у каких не хватает данных для полноценной
  карточки. Отчёт — не украшение: без него «на витрине меньше товаров,
  чем в выгрузке» превращается в расследование.
*/
export function publish(store, options = {}) {
  const { filter = {}, editorial = {}, categories = [] } = options;
  const catById = new Map(categories.map((c) => [c.id, c]));
  const all = store.loadAll();
  const products = [];
  const report = { total: all.size, inactive: 0, filtered: 0, published: 0, incomplete: [], noPrice: [], noPhoto: [] };

  for (const item of all.values()) {
    if (item.active === false) { report.inactive += 1; continue; }
    if (!matchesFilter(item, filter)) { report.filtered += 1; continue; }
    const cat = catById.get(item.categoryId);
    const product = toShopProduct(item, {
      editorial, categoryPath: cat?.path ?? [],
      shopCat: options.shopCat, shopBrand: options.shopBrand,
    });
    if (!product.price) report.noPrice.push(item.id);
    if (product.photoMissing) report.noPhoto.push(item.id);
    if (item.missing?.length) report.incomplete.push({ id: item.id, name: item.name ?? null, missing: item.missing });
    products.push(product);
    report.published += 1;
  }

  /* Порядок фиксированный: иначе каждая сборка давала бы другой diff при
     тех же данных. */
  products.sort((a, b) => a.id.localeCompare(b.id, 'ru'));
  return { products, report };
}
