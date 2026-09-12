/*
  Картинки товаров: загрузка, кэш, оптимизация.

  Отдельный этап, а не часть выгрузки. Причин две. Каталог из девяти с
  половиной тысяч позиций ссылается на шесть с лишним тысяч картинок, и
  тянуть их внутри синхронизации значит поставить весь импорт в
  зависимость от чужого файлового сервера. И наоборот: переобработать
  картинки под новые размеры можно, не трогая каталог.

  Исходные адреса не подменяются. В сторе остаётся ровно то, что прислал
  поставщик, а соответствие «адрес → локальные файлы» живёт отдельным
  манифестом. Поэтому этап можно выкинуть и собрать витрину как раньше.

  Ничего не растягивается. Размер меньше целевого не достраивается до
  него: увеличенная картинка выглядит хуже исходной, и показывать
  замыленный кадр вместо честного маленького нельзя. Если исходник уже,
  чем ширина из списка, эта ширина просто не создаётся.
*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WIDTHS = [320, 640, 960];
export const FORMATS = ['webp', 'avif'];

export function urlHash(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

function extOf(url) {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(url));
  const ext = (m?.[1] ?? 'jpg').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'].includes(ext) ? ext : 'jpg';
}

/*
  Манифест. Ключ — исходный адрес: именно по нему сборка витрины
  подставляет локальные файлы, и именно он остаётся единственной связью с
  поставщиком. Хранит и неудачи: без них следующий запуск снова полез бы
  за картинкой, которой нет, и так на каждой сборке.
*/
export class ImageManifest {
  constructor(file) {
    this.file = path.resolve(file);
    this.data = { version: 1, updatedAt: null, items: {} };
    if (fs.existsSync(this.file)) {
      try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* битый манифест не повод терять картинки */ }
    }
    this.data.items ??= {};
  }

  get(url) { return this.data.items[url] ?? null; }

  /* Готовой считается запись, у которой есть хотя бы один вариант и файлы
     которой на месте: удалённый файл должен приводить к пересборке, а не
     к ссылке в никуда. */
  isReady(url, root) {
    const rec = this.get(url);
    if (!rec?.variants?.length) return false;
    return rec.variants.every((v) => Object.values(v.files ?? {}).every((rel) => fs.existsSync(path.join(root, rel))));
  }

  set(url, record) { this.data.items[url] = record; }

  save() {
    this.data.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  stats() {
    const items = Object.values(this.data.items);
    return {
      total: items.length,
      ok: items.filter((i) => i.variants?.length).length,
      failed: items.filter((i) => i.error).length,
      bytes: items.reduce((a, i) => a + (i.bytes ?? 0), 0),
    };
  }
}

/* Скачивание одной картинки. Таймаут обязателен: чужой сервер вправе
   держать соединение сколько угодно, а этап не вправе висеть вечно. */
export async function fetchImage(url, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('пустой ответ');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/*
  Обработка одного исходника в набор вариантов.

  sharp подключается по требованию: без этапа картинок он не нужен, и
  сборка витрины не должна падать из-за отсутствия необязательной
  зависимости.
*/
export async function makeVariants(buffer, { outDir, publicDir, name, widths = WIDTHS, formats = FORMATS, sharpImpl } = {}) {
  const sharp = sharpImpl ?? (await import('sharp')).default;
  const image = sharp(buffer, { failOn: 'none' });
  const meta = await image.metadata();
  const srcWidth = meta.width ?? 0;
  const srcHeight = meta.height ?? 0;
  if (!srcWidth || !srcHeight) throw new Error('не удалось прочитать размеры изображения');

  fs.mkdirSync(outDir, { recursive: true });
  const variants = [];
  let bytes = 0;

  /* Целевые ширины: только те, что не больше исходной. Плюс сама исходная
     ширина, если она меньше самой маленькой цели — иначе у крошечной
     картинки не осталось бы ни одного варианта. */
  let targets = widths.filter((w) => w <= srcWidth);
  if (!targets.length) targets = [srcWidth];

  for (const width of targets) {
    const height = Math.round((srcHeight / srcWidth) * width);
    const files = {};
    for (const format of formats) {
      const rel = path.posix.join(publicDir, `${name}-${width}.${format}`);
      const abs = path.join(outDir, `${name}-${width}.${format}`);
      const pipeline = sharp(buffer, { failOn: 'none' }).resize({ width, withoutEnlargement: true });
      const out = format === 'avif'
        ? await pipeline.avif({ quality: 50, effort: 4 }).toBuffer()
        : await pipeline.webp({ quality: 78 }).toBuffer();
      fs.writeFileSync(abs, out);
      bytes += out.length;
      files[format] = rel;
    }
    variants.push({ width, height, files });
  }
  return { width: srcWidth, height: srcHeight, format: meta.format ?? null, variants, bytes };
}

/* Набор адресов из стора: и главная картинка, и все дополнительные. */
export function collectUrls(store) {
  const urls = new Map();
  for (const item of store.loadAll().values()) {
    if (item.active === false) continue;
    for (const url of item.photos ?? []) {
      if (!urls.has(url)) urls.set(url, []);
      urls.get(url).push(item.id);
    }
  }
  return urls;
}

/*
  srcset для витрины. Порядок вариантов — от узкого к широкому, как того
  ждёт браузер; ширина честная, взятая из самого файла, а не назначенная.
*/
export function srcsetOf(record, format = 'webp') {
  if (!record?.variants?.length) return '';
  return record.variants
    .filter((v) => v.files?.[format])
    .sort((a, b) => a.width - b.width)
    .map((v) => `/${v.files[format].replace(/^\//, '')} ${v.width}w`)
    .join(', ');
}

/* Самый широкий вариант — как обычный src для браузеров без srcset. */
export function fallbackSrc(record, format = 'webp') {
  if (!record?.variants?.length) return '';
  const widest = [...record.variants].sort((a, b) => b.width - a.width).find((v) => v.files?.[format]);
  return widest ? `/${widest.files[format].replace(/^\//, '')}` : '';
}

export { extOf };
