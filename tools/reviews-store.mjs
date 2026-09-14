/*
  Очередь отзывов → публикуемый live/reviews.json.

  Один модуль на сборку каталога и на инструмент модерации: иначе два
  места решали бы, что публиковать, и считали бы среднюю оценку — и
  однажды разошлись бы.

  Та же логика повторена в api/reviews-store.php: модерация идёт на
  сервере, где Node нет. Расхождение между ними ловит тест «PHP и сборка
  дают одинаковый live/reviews.json».
*/
import fs from 'node:fs';
import path from 'node:path';

/* Одна запись очереди в том виде, в каком её показывают покупателю. */
function publicReview(rv) {
  const rate = Number(rv.rate);
  if (!(rate >= 1 && rate <= 5)) return null;
  const text = String(rv.text ?? '').trim();
  if (text.length < 20) return null;
  const d = new Date(rv.createdAt);
  const at = Number.isNaN(d.getTime()) ? 0 : d.getTime();
  /*
    Поля перечислены поимённо, а не копируются целиком. Адрес автора и
    его IP лежат в той же записи, и «скопировать всё, кроме пары полей»
    однажды пропустило бы новое поле на витрину.
  */
  const out = {
    name: String(rv.name ?? '').trim() || 'Покупатель',
    rate: Math.round(rate),
    text,
    date: at ? String(d.getUTCDate()).padStart(2, '0') + '.' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + d.getUTCFullYear() : '',
    verified: rv.verified === true,
  };
  for (const k of ['city', 'printer', 'plus', 'minus']) {
    const v = String(rv[k] ?? '').trim();
    if (v) out[k] = v;
  }
  const reply = typeof rv.reply === 'string' ? rv.reply.trim() : String(rv.reply?.text ?? '').trim();
  if (reply) out.reply = reply;
  return { ...out, __at: at };
}

/**
 * Прочитать очередь и собрать то, что уходит на витрину.
 *
 * @param {string} dir папка очереди
 * @param {Set<string>|null} ids идентификаторы товаров витрины; отзыв об
 *        ушедшей позиции не публикуется, но и не теряется молча
 */
export function readReviewQueue(dir, ids = null) {
  const byProduct = new Map();
  const stats = { published: 0, pending: 0, rejected: 0, orphan: 0, broken: 0 };
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    : [];
  for (const f of files) {
    let rv;
    try { rv = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { stats.broken += 1; continue; }
    if (!rv || typeof rv !== 'object') { stats.broken += 1; continue; }
    if (rv.status === 'rejected') { stats.rejected += 1; continue; }
    if (rv.status !== 'approved') { stats.pending += 1; continue; }
    const pub = publicReview(rv);
    if (!pub) { stats.broken += 1; continue; }
    const product = String(rv.product ?? '');
    if (ids && !ids.has(product)) { stats.orphan += 1; continue; }
    if (!byProduct.has(product)) byProduct.set(product, []);
    byProduct.get(product).push(pub);
    stats.published += 1;
  }
  const items = {};
  for (const id of [...byProduct.keys()].sort()) {
    const list = byProduct.get(id);
    /* Новые сверху. При равном времени порядок задаёт текст — иначе две
       записи одной секунды меняются местами от запуска к запуску. */
    list.sort((a, b) => b.__at - a.__at || a.text.localeCompare(b.text));
    items[id] = {
      count: list.length,
      /* Средняя считается один раз и здесь: витрина и микроразметка
         берут готовое число, поэтому разойтись им негде. */
      rate: Math.round(list.reduce((a, r) => a + r.rate, 0) / list.length * 10) / 10,
      list: list.map(({ __at, ...rest }) => rest),
    };
  }
  return { updatedAt: new Date().toISOString(), items, stats, files: files.length };
}

/** Строка отчёта — одинаковая у сборки и у инструмента модерации. */
export function reviewsSummary(result, dirLabel) {
  const s = result.stats;
  return `отзывы: опубликовано ${s.published} на ${Object.keys(result.items).length} товарах` +
    (s.pending ? `, ждут модерации ${s.pending}` : '') +
    (s.rejected ? `, отклонено ${s.rejected}` : '') +
    (s.orphan ? `, ОТ УШЕДШИХ ТОВАРОВ ${s.orphan}` : '') +
    (s.broken ? `, НЕ РАЗОБРАНО ${s.broken}` : '') +
    (result.files ? '' : ` (очередь ${dirLabel} пуста)`);
}

/** Записать live/reviews.json так, чтобы читатель не увидел половину файла. */
export function writeLiveReviews(file, result) {
  const payload = JSON.stringify({ updatedAt: result.updatedAt, items: result.items });
  const tmp = file + '.' + Math.random().toString(36).slice(2) + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, file);
  return payload.length;
}
