/*
  Импорт каталога из выгрузки CSV.

  Зачем это рядом с SOAP-клиентом. Клиент готов и покрыт тестами, но egress
  к api.vtt.ru из этой среды закрыт, а полная реальная выгрузка у нас уже
  есть — её сделали учётной записью пользователя и отдали файлом. Чтобы не
  плодить второй конвейер, CSV входит в тот же путь: сырой ряд → normalize
  → categories → store. Всё, что гарантирует SOAP-ветка — идемпотентность,
  сохранность сырых данных, отчёт о раскладке, — работает и здесь, потому
  что это тот же код.

  Разбор по RFC 4180. Разделитель — точка с запятой, поля в кавычках
  содержат и разделитель, и переводы строк: в реальной выгрузке 9 483
  товара занимают 14 485 физических строк. Построчное чтение разорвало бы
  каждую вторую карточку с многострочной совместимостью.
*/

/* BOM в начале файла ломает имя первой колонки: она становится "﻿Id"
   и товар остаётся без идентификатора. Поэтому он снимается явно. */
export function parseCsv(text, { separator = ';' } = {}) {
  if (typeof text !== 'string') throw new TypeError('parseCsv: ожидалась строка');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      /* Удвоенная кавычка внутри поля — это одна кавычка, а не конец. */
      if (text[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === separator) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* Ряды → объекты с исходными именами колонок. Имена не переименовываются:
   это сырой слой, и он должен читаться так же, как файл поставщика. */
export function rowsToObjects(rows) {
  if (!rows.length) return { columns: [], items: [] };
  const columns = rows[0].map((c) => c.trim());
  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some((v) => v !== '')) continue;
    const obj = {};
    for (let c = 0; c < columns.length; c++) obj[columns[c]] = row[c] ?? '';
    items.push(obj);
  }
  return { columns, items };
}

export function readCsvCatalog(text, options) {
  return rowsToObjects(parseCsv(text, options));
}
