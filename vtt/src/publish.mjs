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
import { slugify, REQUIRED_FOR_CARD, isDamagedPackage } from './normalize.mjs';
import { colorTitle, colorPhrase } from './colors.mjs';

export const DESCRIPTION_VERSION = 2;

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
  Список совместимых моделей. Берётся ТОЛЬКО из структурного источника —
  GetGoodsCompatibilityInformation, где бренд и модель приходят
  отдельными полями.

  Свободный текст Compatibility сюда не попадает, и это решение по фактам
  реальной выгрузки: в одном и том же поле у VTT лежат и списки моделей
  («LJ 3052/3055/3390/3392 CLJ M375/M475»), и состояние товара
  («Повреждённая упаковка»), и примечания («с чипом», «Позиция снята с
  производства»). Разрезание по разделителям дало бы карточке чипы
  «Повреждённая упаковка» и «3055» — то есть выдуманную совместимость.
  Текст показывается как есть, отдельным полем, за подписью поставщика.
*/
export function modelsOf(item) {
  return item.compatibilityLabels ?? item.compatibility ?? [];
}

/*
  Совместимость из названия.

  Название у VTT построено единообразно: «<тип> <марка> (<артикул>) для
  <техника>, <цвет>, <ресурс>». Часть после «для» — это слова самого
  поставщика о том, к чему товар подходит, и единственный источник таких
  сведений у 6 681 позиции: структурная совместимость по этому каталогу
  не приходит вовсе.

  Разбор намеренно трусливый. Мы отрезаем только хвост из цвета, ресурса
  и служебных пометок — то, что стоит последними запятыми и распознаётся
  списком. Ничего не переставляем, ничего не дополняем и не режем на
  отдельные модели: «M8124cidn/M8130cidn» остаётся одной фразой, потому
  что делить её на элементы — уже додумывание. Если после отрезания
  хвоста ничего осмысленного не осталось, функция возвращает пустую
  строку и в описании этого предложения просто нет.
*/
const FOR_RE = /(^|[^\p{L}\p{N}])для\s+/iu;
const TAIL_TOKENS = /^(?:[a-zа-яё]{1,4}|\d+(?:[.,]\d+)?\s*[kк]|\d+(?:[.,]\d+)?\s*(?:мл|л|г|кг|шт)\.?|с\s+чипом|без\s+чипа|б\/ч|\d+(?:[.,]\d+)?)$/iu;

export function modelsFromName(name) {
  const text = String(name ?? '');
  const m = FOR_RE.exec(text);
  if (!m) return '';
  let rest = text.slice(m.index + m[0].length).trim();
  rest = rest.replace(/\([^)]*\)\s*$/u, '').trim();
  const parts = rest.split(',').map((s) => s.trim()).filter(Boolean);
  while (parts.length > 1 && TAIL_TOKENS.test(parts[parts.length - 1])) parts.pop();
  const out = parts.join(', ').replace(/[\s.,;-]+$/u, '').trim();
  return out.length >= 3 && out.length <= 140 ? out : '';
}

/*
  Описание карточки.

  Собирается только из полей, которые поставщик действительно прислал.
  Ни гарантий, ни «печатает без полос», ни цены и остатка: цена и остаток
  меняются каждой выгрузкой, и зашитые в текст они устареют молча.

  Габаритов в тексте нет намеренно. В выгрузке есть Width/Height/Depth,
  но единицы не указаны нигде, а сверка GrossVolume с произведением
  сторон сходится лишь у части позиций — значит, «0,38 × 0,45 × 0,57 см»
  было бы утверждением о размере, которого никто не подтверждал. Числа
  остаются в характеристиках без единицы и с оговоркой.

  Текст детерминирован: те же данные дают тот же текст, поэтому diff
  показывает изменения у поставщика, а не перестановку слов.
*/
export function buildDescription(item) {
  const facts = [];
  const used = {};
  const type = typeOf(item);
  const code = item.vendorCode ?? '';

  /* Первое предложение — что это за вещь. Порядок слов зависит от того,
     какие поля есть, поэтому у позиции без марки техники получается не
     та же фраза с подменённым артикулом, а другая фраза. */
  if (code && type) {
    const brand = item.brand ? ` ${item.brand}` : '';
    const forBrand = item.compatibleBrand ? ` для техники ${item.compatibleBrand}` : '';
    facts.push(`${code} — ${type.toLowerCase()}${brand}${forBrand}.`);
    used.type = 1; used.vendorCode = 1;
    if (item.brand) used.brand = 1;
    if (item.compatibleBrand) used.compatibleBrand = 1;
  } else if (type) {
    facts.push(`${type}${item.brand ? ` ${item.brand}` : ''}.`);
    used.type = 1;
  }

  const models = modelsOf(item);
  if (models.length) {
    const list = models.slice(0, 12).join(', ');
    const more = models.length > 12 ? ` и ещё ${models.length - 12} моделей` : '';
    facts.push(`Совместимость по данным поставщика: ${list}${more}.`);
    used.compatibility = 1;
  } else {
    const fromName = modelsFromName(item.name);
    if (fromName) {
      facts.push(`Поставщик указывает совместимость: ${fromName}.`);
      used.compatibilityFromName = 1;
    }
  }

  const colorText = colorPhrase(item.color);
  const resource = item.resource ? `заявленный ресурс — ${fmt(item.resource)} страниц` : '';
  const volume = item.volumeMl ? `объём — ${fmt(item.volumeMl)} мл` : '';
  const measure = resource || volume;
  if (colorText && measure) {
    facts.push(`Цвет — ${colorText}, ${measure}.`);
    used.color = 1; used[resource ? 'resource' : 'volumeMl'] = 1;
  } else if (colorText) {
    facts.push(`Цвет — ${colorText}.`);
    used.color = 1;
  } else if (measure) {
    facts.push(`${measure[0].toUpperCase()}${measure.slice(1)}.`);
    used[resource ? 'resource' : 'volumeMl'] = 1;
  }

  /* Свободная строка поставщика идёт под его подписью и без разбора: в
     ней лежат и «с чипом», и «Позиция снята с производства». */
  const note = String(item.compatibilityText ?? '').trim();
  if (note && !used.compatibility && note !== modelsFromName(item.name)) {
    facts.push(`Примечание поставщика: ${note.replace(/\.$/, '')}.`);
    used.compatibilityText = 1;
  }

  if (item.originalNumber && item.originalNumber !== code) {
    facts.push(`Оригинальный номер: ${item.originalNumber}.`);
    used.originalNumber = 1;
  }

  const pack = [];
  if (item.inPackage && item.inPackage > 1) { pack.push(`в упаковке ${fmt(item.inPackage)} шт.`); used.inPackage = 1; }
  if (item.grossWeight) { pack.push(`вес одной штуки ${fmt(item.grossWeight)} кг`); used.grossWeight = 1; }
  else if (item.weight) { pack.push(`вес ${fmt(item.weight)} кг`); used.weight = 1; }
  if (pack.length) facts.push(`${pack[0][0].toUpperCase()}${pack[0].slice(1)}${pack[1] ? `, ${pack[1]}` : ''}.`);

  if (item.categoryRoot || item.category) {
    const path = [item.categoryRoot, item.category].filter(Boolean).join(' / ');
    facts.push(`Раздел поставщика: ${path}.`);
    used.category = 1;
  }
  if (item.barcode) { facts.push(`Штрихкод: ${item.barcode}.`); used.barcode = 1; }

  return {
    text: facts.join(' '),
    /* Из каких полей собран текст — чтобы было видно, почему описание
       короткое, и что можно дополнить редакционной правкой. */
    basedOn: Object.keys(used),
    version: DESCRIPTION_VERSION,
  };
}

/*
  Марка в тексте. Границы заданы явно, а не через \b: в JavaScript \b
  считает «словом» только латиницу с цифрами, поэтому у кириллического
  слова границы нет вовсе и такая проверка молча ничего не находит.
*/
const BOUND = '(^|[^\\p{L}\\p{N}])';
const markRe = (mark) => new RegExp(`${BOUND}${String(mark).replace(/-/g, '[-\\s]?')}($|[^\\p{L}\\p{N}])`, 'iu');
/* «для», «совместим…», «подходит» открывают хвост о совместимости. */
const COMPAT_TAIL = new RegExp(`${BOUND}(для|совместим\\p{L}*|подходит|под)($|[^\\p{L}\\p{N}])`, 'iu');

/*
  Собственная марка в названии — запасной признак для товаров, у которых
  поставщик не заполнил Brand.

  Смотрим только «производительную» часть названия, до хвоста о
  совместимости. Иначе «Ролик подачи для Hi-Black …» — чужая деталь,
  подходящая к технике Hi-Black, — попала бы на витрину как своя.
  Описание и поле совместимости здесь не участвуют вовсе: слово из
  описания маркой не является.
*/
export function ownBrandInName(name, marks = []) {
  const text = String(name ?? '');
  const tail = text.search(COMPAT_TAIL);
  const head = tail >= 0 ? text.slice(0, tail) : text;
  return marks.some((m) => markRe(m).test(head));
}

/*
  Что попадает на витрину.

  Отбор идёт по Brand из выгрузки — по тому, кто товар произвёл. Ни
  Vendor, ни раздел витрины для этого не годятся: Vendor у VTT означает
  марку принтера, к которому товар подходит, и по нему в каталог попал бы
  весь чужой ассортимент, совместимый с HP или Canon.

  Товары с незаполненным Brand спасаются по названию, но только по
  списку марок, у которых название однозначно: Hi-Black, Hi-Image,
  Hi-Color, NetProduct — придуманные имена, их ни с чем не спутать.
  Content в этот список не входит: это обычное английское слово, и
  встретившись в названии чужого товара оно протащило бы его на витрину.
*/
export function matchesFilter(item, filter = {}) {
  /*
    Повреждённая упаковка на витрину не попадает вовсе. Это не вариант
    товара и не «уценка со скидкой»: карточка, поисковая выдача, страница
    для индексации и переключатель цвета такой позиции не создаются.
    Отсев идёт здесь, до присвоения адреса и до сборки семейств, — иначе
    исключённая позиция успела бы занять slug и попасть в комплект
    ссылкой в никуда.

    В сторе такие позиции остаются: это настоящая выгрузка поставщика, и
    терять её из-за решения о витрине нельзя.
  */
  if (filter.excludeDamagedPackage !== false) {
    const damaged = item.packageDamaged ?? isDamagedPackage({
      name: item.name, description: item.supplierDescription, compatibility: item.compatibilityText,
    });
    if (damaged) return false;
  }
  const brands = (filter.brands ?? []).map((s) => String(s).trim().toLowerCase());
  const exclude = (filter.excludeBrands ?? []).map((s) => String(s).trim().toLowerCase());
  const cats = filter.categories ?? [];
  const brand = String(item.brand ?? '').trim().toLowerCase();
  if (exclude.length && exclude.includes(brand)) return false;

  if (brands.length && !brands.includes(brand)) {
    const fb = filter.brandFallback ?? null;
    const weak = (fb?.whenBrandIn ?? []).map((s) => String(s).trim().toLowerCase()).includes(brand);
    if (!(weak && ownBrandInName(item.name, fb?.nameMarks ?? []))) return false;
  }

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

/*
  Цена на витрине.

  Полная выгрузка даёт рублёвую цену (PriceLocal) и её же в валюте
  поставщика (Price). Оперативная выгрузка даёт только валютную — такого
  поля, как PriceLocal, в ItemRuntimeDto нет. Поэтому свежая цена
  переводится в рубли по курсу самой этой позиции, снятому с полной
  выгрузки: PriceLocal / Price. Это курс поставщика, а не придуманный
  нами, и он берётся с той же карточки, а не усредняется по каталогу.

  Если курс снять не с чего (валютной цены в полной выгрузке не было),
  оперативная цена не применяется вовсе: лучше показать вчерашнюю
  рублёвую цену, чем сегодняшнюю в чужой валюте.
*/
export function priceOf(item) {
  const rt = item.runtime ?? {};
  const base = item.price;
  if (rt.priceForeign === undefined || rt.priceForeign === null) {
    return { price: base, retail: undefined, from: 'full' };
  }
  const rate = item.priceForeign > 0 && base > 0 ? base / item.priceForeign : null;
  if (!rate) return { price: base, retail: undefined, from: 'full', note: 'курс неизвестен' };
  return { price: Math.round(rt.priceForeign * rate * 100) / 100, retail: undefined, from: 'runtime', rate };
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
    /* Строка ресурса от поставщика едет рядом с разобранным числом: по
       ней видно, что именно разобрано, а что осталось как есть. */
    lifeTime: item.lifeTime ?? '',
    volumeMl: item.volumeMl ?? null,
    /* Код цвета остаётся кодом: по нему собираются семейства и по нему
       покупатель сверяется с надписью на картридже. Русское название —
       отдельным полем, для показа. */
    color: item.color ?? '',
    colorTitle: colorTitle(item.color),
    chip: null,
    compat: modelsOf(item).join(', '),
    models: modelsOf(item),
    /* Свободный текст поставщика едет отдельным полем и показывается как
       есть: резать его на модели нельзя, но и терять нельзя — у 6 681
       позиции это единственные сведения о совместимости. */
    compatText: item.compatibilityText ?? '',
    compatibleBrand: item.compatibleBrand ?? '',
    equip: '', tech: '', print: '',
    weight: item.weight ?? '',
    grossWeight: item.grossWeight ?? '',
    inPackage: item.inPackage ?? 0,
    barcode: item.barcode ?? '',
    categoryRoot: item.categoryRoot ?? '',
    /* Габариты без единицы измерения: поставщик её не указывает, а
       подписать «см» под 0,38 × 0,45 × 0,57 значит утверждать размер,
       которого никто не подтверждал. */
    dimensions: item.dimensions ?? null,
    grossDimensions: item.grossDimensions ?? null,
    img: usablePhoto(item.photos?.[0]) ? item.photos[0] : PHOTO_PLACEHOLDER,
    images: (item.photos ?? []).filter(usablePhoto),
    /* Адреса в том виде, в каком их прислал поставщик. Витрина ходит по
       https-версии, но исходник нужен для сверки и для этапа загрузки. */
    imagesOriginal: (item.photosOriginal ?? []).filter(usablePhoto),
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
    /* Цены нет — товар не продаётся кнопкой, а показывается «по запросу».
       Ноль в ценнике хуже отсутствия цены: он выглядит как бесплатно. */
    priceOnRequest: !(price > 0),
    priceFrom: (item.runtime ? 'runtime' : 'full'),
    /*
      Зачёркнутой «старой цены» у импортированных товаров нет.
      PriceRetail поставщик присылает в своей валюте, и это его
      рекомендованная розница, а не наша прежняя цена. Пересчитать её в
      рубли можно, но показать как «было 2 040 ₽ — стало 1 825 ₽» —
      значит объявить чужую наценку своей скидкой. Поле остаётся, чтобы
      цифра не потерялась, но на ценник не идёт.
    */
    old: 0,
    priceRetailForeign: item.priceRetailForeign ?? 0,
    priceForeign: item.priceForeign ?? 0,
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
  /*
    Отчёт о неполноте разделён на два. «Не хватает обязательного» — это
    карточка, которую нельзя показывать: без названия, артикула или цены.
    «Не хватает желательного» — это ресурс, фото, описание: карточка
    работает, но беднее. Раньше они шли одной кучей, и на реальной
    выгрузке в неё попадали все девять с половиной тысяч товаров —
    отчёт, в котором всё, не сообщает ничего.
  */
  const report = {
    total: all.size, inactive: 0, filtered: 0, damagedPackage: 0, published: 0,
    incomplete: [], missingRequired: [], noPrice: [], noPhoto: [], noDescription: [], noCompatibility: [],
  };

  for (const item of all.values()) {
    if (item.active === false) { report.inactive += 1; continue; }
    if (!matchesFilter(item, filter)) {
      report.filtered += 1;
      /* Повреждённая упаковка считается отдельно от чужих марок: это
         разные причины, и в отчёте они не должны сливаться. */
      if (item.packageDamaged) report.damagedPackage += 1;
      continue;
    }
    const cat = catById.get(item.categoryId);
    const product = toShopProduct(item, {
      editorial, categoryPath: cat?.path ?? [],
      shopCat: options.shopCat, shopBrand: options.shopBrand,
    });
    if (!product.price) report.noPrice.push(item.id);
    if (product.photoMissing) report.noPhoto.push(item.id);
    if (item.missing?.length) {
      const required = item.missing.filter((f) => REQUIRED_FOR_CARD.includes(f));
      const entry = { id: item.id, name: item.name ?? null, missing: item.missing };
      report.incomplete.push(entry);
      if (required.length) report.missingRequired.push({ ...entry, required });
    }
    if (!item.supplierDescription) report.noDescription.push(item.id);
    if (!item.compatibilityText) report.noCompatibility.push(item.id);
    products.push(product);
    report.published += 1;
  }

  /* Порядок фиксированный: иначе каждая сборка давала бы другой diff при
     тех же данных. */
  products.sort((a, b) => a.id.localeCompare(b.id, 'ru'));
  return { products, report };
}
