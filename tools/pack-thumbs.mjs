#!/usr/bin/env node
/*
  Упаковка миниатюр в атласы.

  Зачем это нужно. Превью публикуется набором файлов, и у публикации два
  жёстких предела: не больше 255 файлов и не больше 64 МБ на всё. Шесть с
  лишним тысяч картинок поставщика не помещаются ни в первый предел (по
  файлу на картинку — это 6 201 файл), ни во второй, если укладывать их
  в JSON строками base64: кодирование добавляет треть объёма, и каталог
  вместе с ними перестаёт помещаться.

  Атлас снимает оба ограничения сразу. Сто сорок четыре миниатюры лежат
  одной картинкой, поэтому файлов получаются десятки, а не тысячи; base64
  не нужен вовсе, поэтому объём не растёт; и соседние товары попадают в
  один атлас, поэтому страница каталога тянет один файл вместо дюжины.

  Порядок важен. Миниатюры укладываются в том же порядке, в каком товары
  лежат в индексе, — тогда карточки одной страницы каталога почти всегда
  оказываются в одном атласе.

  Запуск:
    node tools/pack-thumbs.mjs                     все картинки из манифеста
    node tools/pack-thumbs.mjs --from-dir=./photos  из готовой папки
    node tools/pack-thumbs.mjs --cell=240 --per-atlas=144
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackRows } from './index-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, fallback) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

export const DEFAULTS = {
  /* 240 пикселей — ширина картинки в карточке каталога на самом крупном
     экране. Больше не нужно: на карточке товара показывается тот же
     кадр, но там он и так растянут во всю колонку. */
  cell: Number(argOf('cell', 240)),
  /* Двенадцать на двенадцать: сам атлас выходит 2880×2880 — в пределах
     того, что браузеры декодируют без оговорок. */
  perAtlas: Number(argOf('per-atlas', 144)),
  quality: Number(argOf('quality', 68)),
};

/*
  Раскладка одного атласа. Считается заранее и отдельно от кодирования:
  по этой же раскладке витрина потом вычисляет background-position, и
  если бы она жила внутри кодировщика, повторить её на клиенте было бы
  не из чего.
*/
export function atlasLayout(count, { cell, perAtlas }) {
  const cols = Math.ceil(Math.sqrt(perAtlas));
  const rows = Math.ceil(perAtlas / cols);
  const atlases = Math.ceil(count / perAtlas);
  return { cols, rows, cell, perAtlas, atlases, width: cols * cell, height: rows * cell };
}

export function placeOf(i, layout) {
  const inAtlas = i % layout.perAtlas;
  return { atlas: Math.floor(i / layout.perAtlas), col: inAtlas % layout.cols, row: Math.floor(inAtlas / layout.cols) };
}

/*
  Сборка атласов. sharp подключается по требованию: без этого этапа он не
  нужен, и сборка витрины не должна падать из-за необязательной
  зависимости.

  Миниатюра вписывается в квадратную ячейку с белым полем, а не
  обрезается: у расходников важна форма упаковки, и срезанный край
  картриджа мешает узнать товар.
*/
export async function buildAtlases(sources, { outDir, publicDir, cell, perAtlas, quality, sharpImpl, onProgress } = {}) {
  const sharp = sharpImpl ?? (await import('sharp')).default;
  const layout = atlasLayout(sources.length, { cell, perAtlas });
  fs.mkdirSync(outDir, { recursive: true });

  const files = [];
  const items = {};
  let bytes = 0;

  for (let a = 0; a < layout.atlases; a++) {
    const slice = sources.slice(a * perAtlas, (a + 1) * perAtlas);
    const composite = [];
    for (let j = 0; j < slice.length; j++) {
      const src = slice[j];
      const place = placeOf(a * perAtlas + j, layout);
      let buf;
      try {
        buf = await sharp(src.buffer ?? fs.readFileSync(src.file), { failOn: 'none' })
          .resize(cell, cell, { fit: 'contain', withoutEnlargement: true, background: { r: 255, g: 255, b: 255 } })
          .toBuffer();
      } catch (e) {
        /* Битая картинка не должна ронять весь атлас: товар просто
           останется с заглушкой, и это уйдёт в отчёт. */
        onProgress?.({ kind: 'skip', id: src.id, reason: String(e.message ?? e) });
        continue;
      }
      composite.push({ input: buf, left: place.col * cell, top: place.row * cell });
      items[src.id] = [place.atlas, place.col, place.row];
    }
    if (!composite.length) continue;
    const out = await sharp({
      create: { width: layout.width, height: layout.height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).composite(composite).webp({ quality }).toBuffer();

    const rel = path.posix.join(publicDir, `atlas-${a}.webp`);
    fs.writeFileSync(path.join(outDir, `atlas-${a}.webp`), out);
    files.push(rel);
    bytes += out.length;
    onProgress?.({ kind: 'atlas', index: a, of: layout.atlases, bytes: out.length });
  }

  return { version: 1, cell, cols: layout.cols, rows: layout.rows, files, items, bytes };
}

/* ------------------------------------------------------------- запуск */

if (import.meta.url === `file://${process.argv[1]}`) {
  const storeRoot = path.resolve(argOf('store', path.join(ROOT, 'vtt-data')));
  const fromDir = argOf('from-dir', null);
  const publicDir = argOf('public', 'assets/img/atlas');
  const outDir = path.join(ROOT, publicDir);
  const indexFile = path.join(ROOT, 'data/catalog/index.json');

  if (!fs.existsSync(indexFile)) {
    console.error('Сначала соберите каталог: npm run catalog');
    process.exit(2);
  }
  const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const rows = unpackRows(idx);
  const col = Object.fromEntries(idx.fields.map((f, i) => [f, i]));

  /* Источник байтов: сперва локальные варианты из манифеста этапа
     картинок, иначе папка, которую указали вручную. Сеть здесь не
     используется — загрузка это отдельный этап. */
  const manifestFile = path.join(storeRoot, 'images/manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { items: {} };

  const sources = [];
  const missing = [];
  for (const row of rows) {
    const id = row[col.id];
    const url = row[col.img];
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const rec = manifest.items?.[url];
    const local = rec?.variants?.length
      ? path.join(ROOT, [...rec.variants].sort((a, b) => b.width - a.width)[0].files.webp)
      : (fromDir ? path.join(path.resolve(fromDir), path.basename(new URL(url).pathname)) : null);
    if (local && fs.existsSync(local)) sources.push({ id, file: local });
    else missing.push(id);
  }

  if (!sources.length) {
    console.error(
      `Нечего упаковывать: локальных копий картинок нет (${missing.length} товаров со ссылками).\n` +
      'Сначала выполните этап загрузки: npm run vtt:images — он скачает и пережмёт картинки,\n' +
      'либо укажите готовую папку: node tools/pack-thumbs.mjs --from-dir=<путь>',
    );
    process.exit(1);
  }

  const res = await buildAtlases(sources, {
    outDir, publicDir, ...DEFAULTS,
    onProgress: (e) => { if (e.kind === 'atlas' && e.index % 10 === 0) console.log(`  атлас ${e.index + 1}/${e.of}`); },
  });
  const mapFile = path.join(ROOT, 'data/catalog/thumbs.json');
  fs.writeFileSync(mapFile, JSON.stringify({ version: res.version, cell: res.cell, cols: res.cols, rows: res.rows, files: res.files, items: res.items }));
  /* Флаг в meta: без него витрина не знает, есть ли карта, и запрашивала
     бы её впустую на каждой сборке без атласов. */
  const metaFile = path.join(ROOT, 'data/catalog/meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.thumbs = true;
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  console.log(`Упаковано миниатюр: ${Object.keys(res.items).length}, атласов ${res.files.length}, ` +
    `${(res.bytes / 1048576).toFixed(1)} МБ, без копии ${missing.length}`);
  console.log(`Карта: ${path.relative(ROOT, mapFile)}`);
}
