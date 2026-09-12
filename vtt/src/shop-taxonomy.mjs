/*
  Раскладка ассортимента VTT по разделам витрины.

  Почему таблицей, а не регулярками. Раньше раздел витрины угадывался по
  тексту названия, и всё, что не совпало ни с одним шаблоном, молча падало
  в «Картриджи лазерные». На реальной выгрузке это означало бы, что
  фотобумага, отвёртки и принтеры лежат среди лазерных картриджей — и
  заметить это было бы нечем. Здесь соответствие задано явно для каждого
  из пятнадцати корневых разделов поставщика, а всё, чего в таблице нет,
  уходит в «Прочее» и попадает в отчёт под своим именем.

  Марка техники берётся из поля Vendor, а не из разбора названия: это
  структурное поле, оно заполнено у 97% позиций и содержит ровно 33
  значения. Написания у поставщика свои («Kyocera-Mita», «SAMSUNG BY HP»),
  поэтому они приводятся к идентификаторам витрины таблицей, а не
  подстрокой: подстрока «Konica» нашлась бы и в «Konica Minolta», и в
  «Minolta», разведя один бренд по двум разделам.
*/

/* Корневой раздел VTT → раздел витрины. */
export const ROOT_TO_SHOP = new Map([
  ['Картриджи для лазерной печати', 'laser'],
  ['Картриджи для струйной печати', 'ink'],
  ['Картриджи матричные и ленты красящие', 'matrix'],
  ['Тонеры/ Девелоперы', 'toner'],
  ['Чернила', 'inks'],
  ['Запчасти для ремонта техники', 'zip'],
  ['Запчасти для восстановления картриджей', 'zip'],
  ['Чипы', 'zip'],
  ['Фотобарабаны и комплекты фотобарабанов', 'zip'],
  ['Компьютер. запчасти и аксессуары', 'zip'],
  ['Бумага и пленки', 'paper'],
  ['Чистящие средства и материалы для обслуживания', 'service'],
  ['Инструменты/пакеты/спецоборудование', 'service'],
  ['Печатающая техника и опции к ней', 'printers'],
  ['Прочие расходные материалы', 'other'],
]);

export const FALLBACK_SHOP_CAT = 'other';

/* Разделы витрины, которых не было в исходном каталоге магазина: их
   добавляет импорт, и без них ассортимент пришлось бы прятать. */
export const IMPORTED_SHOP_CATS = [
  { id: 'paper', name: 'Бумага и плёнки', desc: 'Фотобумага, плёнки и носители для печати',
    seo: 'Фотобумага, самоклеящиеся и прозрачные плёнки, носители для струйной и лазерной печати из ассортимента поставщика.' },
  { id: 'service', name: 'Обслуживание и инструмент', desc: 'Чистящие средства, инструменты, упаковка',
    seo: 'Чистящие средства, материалы для обслуживания печатающей техники, инструмент и спецоборудование сервисного инженера.' },
  { id: 'printers', name: 'Печатающая техника', desc: 'Принтеры, МФУ и опции к ним',
    seo: 'Печатающая техника и опции к ней из ассортимента поставщика: принтеры, МФУ, лотки и дополнительные модули.' },
  { id: 'other', name: 'Прочее', desc: 'Позиции вне основных разделов',
    seo: 'Позиции ассортимента, которые не относятся ни к одному из основных разделов каталога.' },
];

/* Vendor поставщика → бренд витрины. */
export const VENDOR_TO_BRAND = new Map([
  ['HP', 'hp'],
  ['SAMSUNG BY HP', 'samsung'],
  ['Kyocera-Mita', 'kyocera'],
  ['Canon', 'canon'],
  ['Xerox', 'xerox'],
  ['Samsung', 'samsung'],
  ['Brother', 'brother'],
  ['Epson', 'epson'],
  ['Pantum', 'pantum'],
  ['Ricoh', 'ricoh'],
  ['Sharp', 'sharp'],
  ['OKI', 'oki'],
  ['Konica Minolta', 'konica'],
  ['Konica', 'konica'],
  ['Minolta', 'konica'],
  ['Lexmark', 'lexmark'],
  ['Panasonic', 'panasonic'],
  ['Toshiba', 'toshiba'],
  ['Катюша', 'katusha'],
  ['IBM', 'ibm'],
  ['Lomond', 'lomond'],
  ['Deli', 'deli'],
  ['Avision', 'avision'],
  ['F+ imaging', 'fplus'],
  ['RISO', 'riso'],
  ['Lenovo', 'lenovo'],
  ['Huawei', 'huawei'],
  ['Sindoh', 'sindoh'],
  ['Cisco', 'cisco'],
  ['Olivetti', 'olivetti'],
]);

/* Марки, у которых в каталоге магазина нет логотипа и описания: их имена
   нужны, чтобы фильтр показывал «Lomond», а не «lomond». */
export const IMPORTED_BRAND_NAMES = {
  ibm: 'IBM', lomond: 'Lomond', deli: 'Deli', avision: 'Avision', fplus: 'F+ imaging',
  riso: 'RISO', lenovo: 'Lenovo', huawei: 'Huawei', sindoh: 'Sindoh', cisco: 'Cisco',
  olivetti: 'Olivetti', universal: 'Универсальные',
};

export const FALLBACK_BRAND = 'universal';

/*
  Раскладка одного товара. Возвращает не только результат, но и статус:
  без него «попал в Прочее» невозможно отличить от «так и задумано».
*/
export function shopCategoryOf(item) {
  const root = (item.categoryRoot ?? '').trim();
  if (!root) return { id: FALLBACK_SHOP_CAT, status: 'no-root' };
  const id = ROOT_TO_SHOP.get(root);
  return id ? { id, status: 'mapped' } : { id: FALLBACK_SHOP_CAT, status: 'unknown-root', root };
}

export function shopBrandOf(item) {
  const vendor = (item.compatibleBrand ?? '').trim();
  if (!vendor) return { id: FALLBACK_BRAND, status: 'no-vendor' };
  const id = VENDOR_TO_BRAND.get(vendor);
  return id ? { id, status: 'mapped' } : { id: FALLBACK_BRAND, status: 'unknown-vendor', vendor };
}

/* Сводка по всему набору — то, что уходит в отчёт сборки. */
export function taxonomyReport(items) {
  const cats = {}, brands = {}, unknownRoots = {}, unknownVendors = {};
  let noRoot = 0, noVendor = 0;
  for (const item of items) {
    const c = shopCategoryOf(item);
    cats[c.id] = (cats[c.id] ?? 0) + 1;
    if (c.status === 'unknown-root') unknownRoots[c.root] = (unknownRoots[c.root] ?? 0) + 1;
    if (c.status === 'no-root') noRoot += 1;
    const b = shopBrandOf(item);
    brands[b.id] = (brands[b.id] ?? 0) + 1;
    if (b.status === 'unknown-vendor') unknownVendors[b.vendor] = (unknownVendors[b.vendor] ?? 0) + 1;
    if (b.status === 'no-vendor') noVendor += 1;
  }
  const sort = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  return { cats: sort(cats), brands: sort(brands), unknownRoots: sort(unknownRoots), unknownVendors: sort(unknownVendors), noRoot, noVendor };
}
