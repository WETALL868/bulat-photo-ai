/*
  Реестр идентичности товара: адрес и код товара.

  Зачем он нужен, стало понятно дорогой ценой. Раньше и адрес карточки, и
  «Код товара» вычислялись из текущего состава каталога: адрес — из
  артикула с числовым хвостом при совпадении, код — хешем от адреса.
  Пока состав не менялся, это работало. Стоило исключить из витрины 1 228
  позиций с повреждённой упаковкой — и 449 нормальных товаров переехали
  на освободившиеся адреса, а вместе с адресом сменили и код. HB-TK-8115C
  был 670235, стал 686396; покупатель, который знал старый код, перестал
  находить товар.

  Вывод простой: адрес и код — это не производные от состава каталога, а
  собственность товара. Раз выданные, они принадлежат ему навсегда.

  Поэтому здесь лежит реестр: стабильный ключ товара → выданные ему адрес
  и номер. Ключ берётся из источника и от состава витрины не зависит: у
  импортированных это Id поставщика, у товаров прототипа — их
  собственный идентификатор.

  Два правила, ради которых всё и затевалось:

    • Однажды выданное не меняется. Есть запись в реестре — берём из неё,
      что бы ни случилось с составом каталога.

    • Однажды выданное не переиспользуется. Запись остаётся в реестре и
      после того, как товар ушёл с витрины, — именно так адрес удалённой
      повреждённой упаковки не достаётся нормальному товару. Вернётся
      позиция в выгрузку — получит обратно свои адрес и номер.

  Файл реестра коммитится вместе с кодом: это не кэш, который можно
  пересобрать, а история выданных номеров. Потерять его — значит
  перенумеровать магазин.
*/
import fs from 'node:fs';
import path from 'node:path';

export const REGISTRY_VERSION = 1;

/* Диапазон «Кода товара»: шесть знаков, как у соседей по рынку. */
export const NO_MIN = 100000;
export const NO_MAX = 999999;
const NO_RANGE = NO_MAX - NO_MIN + 1;

/* Тот же fnv-1a, которым витрина считала код раньше: благодаря этому у
   товара, впервые попавшего в реестр из старого каталога, номер совпадает
   с тем, что покупатель видел до появления реестра. */
export function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/*
  Стабильный ключ. У импортированного товара это Id поставщика — он не
  зависит ни от артикула (артикулы у VTT повторяются), ни от состава
  витрины. У товара прототипа источник — он сам.
*/
export function stableKey(product) {
  if (product.source === 'vtt' || product.vttId) return `vtt:${product.vttId}`;
  return `own:${product.id}`;
}

export class ItemRegistry {
  constructor(data = null) {
    this.data = data && data.items ? data : { version: REGISTRY_VERSION, items: {} };
    this.byId = new Map();
    this.usedNo = new Set();
    for (const [key, rec] of Object.entries(this.data.items)) {
      this.byId.set(rec.id, key);
      this.usedNo.add(rec.no);
    }
    this.issued = 0;
  }

  static load(file) {
    if (!fs.existsSync(file)) return new ItemRegistry();
    try {
      return new ItemRegistry(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      /* Битый реестр — это потеря номеров, а не мелочь: лучше упасть на
         сборке, чем молча перенумеровать магазин. */
      throw new Error(`реестр идентификаторов не прочитан (${file}): ${e.message}`);
    }
  }

  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    /* Ключи сортируются: иначе diff реестра показывал бы перестановку
       строк вместо того, что действительно изменилось. */
    const items = {};
    for (const key of Object.keys(this.data.items).sort()) items[key] = this.data.items[key];
    const out = { version: REGISTRY_VERSION, updatedAt: new Date().toISOString(), count: Object.keys(items).length, items };
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
  }

  get size() { return Object.keys(this.data.items).length; }
  get(key) { return this.data.items[key] ?? null; }
  hasId(id) { return this.byId.has(id); }

  /*
    Выдать товару адрес и номер.

    Уже выдавали — возвращаем то же самое, не глядя на предпочтения: в
    этом весь смысл реестра.

    Не выдавали — подбираем. Адрес берём желаемый; если он уже занят (в том
    числе товаром, которого сейчас нет на витрине), дописываем хвост из
    seed, как делалось раньше. Номер начинаем с хеша seed и идём вперёд до
    первого свободного — так у товара из старого каталога получается
    ровно его прежний номер, а у нового номер выходит без совпадений.
  */
  claim(key, { preferredId, seed } = {}) {
    const have = this.data.items[key];
    if (have) return have;

    const base = String(preferredId || seed || key);
    let id = base;
    if (this.byId.has(id)) {
      const tail = String(seed || '').replace(/^-+|-+$/g, '');
      id = `${base}-${tail}`.replace(/-+$/, '');
      let n = 2;
      while (this.byId.has(id)) id = `${base}-${tail}-${n++}`.replace(/--+/g, '-');
    }

    let no = NO_MIN + (fnv1a(seed || id) % NO_RANGE);
    let guard = 0;
    while (this.usedNo.has(no)) {
      no = NO_MIN + ((no - NO_MIN + 1) % NO_RANGE);
      if (++guard > NO_RANGE) throw new Error('свободных кодов товара не осталось');
    }

    const rec = { id, no };
    this.data.items[key] = rec;
    this.byId.set(id, key);
    this.usedNo.add(no);
    this.issued += 1;
    return rec;
  }
}
