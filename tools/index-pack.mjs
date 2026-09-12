/*
  Сжатие индекса каталога и обратный разбор.

  Индекс — первое, что скачивает браузер, и на девяти с половиной тысячах
  товаров прямая запись даёт два с половиной мегабайта. Сокращение здесь
  делает три вещи, и ни одна ничего не теряет: разбор восстанавливает
  строку в точности.

    1. Словари для повторяющихся колонок. Разделов десять, марок двадцать
       восемь, типов девяносто один — вместо строки в каждой из 9 579
       строк хранится номер в словаре.
    2. Общая часть адреса картинки выносится в таблицу префиксов, в
       строке остаётся хвост.
    3. Слаг, совпавший с идентификатором, не хранится вовсе: он совпадает
       у подавляющего большинства товаров.

  Тот же разбор написан и в assets/js/catalog.js — там он нужен в
  браузере. Формат один и тот же и проверяется тестом на круговой обход.
*/

export const DICT_FIELDS = ['cat', 'brand', 'type', 'color', 'badge', 'src'];
export const IMG_BASES = ['http://b2b.vtt.ru/images/', 'https://b2b.vtt.ru/images/', 'assets/img/'];
/* Управляющий символ, которого не бывает в адресе: по нему разбор
   отличает сжатую ссылку от обычной. */
export const IMG_MARK = '';

export function packIndex(fields, rows, { dictFields = DICT_FIELDS, imgBases = IMG_BASES } = {}) {
  const dicts = {}, lookup = {};
  for (const f of dictFields) { dicts[f] = []; lookup[f] = new Map(); }
  const col = Object.fromEntries(fields.map((f, i) => [f, i]));

  const packed = rows.map((row) => {
    const out = row.slice();
    for (const f of dictFields) {
      const i = col[f];
      if (i === undefined) continue;
      const v = out[i];
      /* Отсутствующее значение остаётся null и в словарь не попадает.
         Пустая строка — попадает: это не то же самое, что «значения
         нет», и подмена одного другим не пережила бы обратный разбор. */
      if (v === null || v === undefined) { out[i] = null; continue; }
      if (!lookup[f].has(v)) { lookup[f].set(v, dicts[f].length); dicts[f].push(v); }
      out[i] = lookup[f].get(v);
    }
    if (col.slug !== undefined && col.id !== undefined && out[col.slug] === out[col.id]) out[col.slug] = 0;
    if (col.img !== undefined && typeof out[col.img] === 'string') {
      const url = out[col.img];
      const b = imgBases.findIndex((base) => url.startsWith(base));
      if (b >= 0) out[col.img] = `${IMG_MARK}${b}${url.slice(imgBases[b].length)}`;
    }
    return out;
  });
  return { fields, dictFields, dicts, imgBases, packed: 1, rows: packed };
}

/* Возвращает строки в исходном виде. Несжатый файл проходит насквозь —
   так старый каталог читается тем же кодом. */
export function unpackRows(index) {
  if (index.packed !== 1) return index.rows;
  const { fields, dicts, dictFields = DICT_FIELDS, imgBases = IMG_BASES } = index;
  const col = Object.fromEntries(fields.map((f, i) => [f, i]));
  const byCol = new Map();
  for (const f of dictFields) if (col[f] !== undefined) byCol.set(col[f], dicts[f] ?? []);

  return index.rows.map((row) => {
    const out = row.slice();
    for (const [i, dict] of byCol) if (typeof out[i] === 'number') out[i] = dict[out[i]];
    if (col.slug !== undefined && out[col.slug] === 0) out[col.slug] = out[col.id];
    if (col.img !== undefined && typeof out[col.img] === 'string' && out[col.img][0] === IMG_MARK) {
      out[col.img] = imgBases[Number(out[col.img][1])] + out[col.img].slice(2);
    }
    return out;
  });
}
