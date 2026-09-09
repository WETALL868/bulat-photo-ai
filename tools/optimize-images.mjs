#!/usr/bin/env node
/*
  Перекодировка изображений в WebP.

  Витрина статическая, и картинки — самая тяжёлая её часть: на первой загрузке
  главной они дают больше половины веса. WebP при том же качестве весит
  примерно вдвое меньше JPEG, а поддерживают его все браузеры, которые вообще
  умеют то, на чём сделана витрина.

  Кодирует сам Chromium через canvas: отдельный кодировщик в системе не нужен.
  Исходники остаются нетронутыми, рядом появляются .webp; ссылки обновляются
  отдельно (в CSS и в tools/build-catalog.mjs).

  Запуск:
    node tools/optimize-images.mjs                 показать, что будет сделано
    node tools/optimize-images.mjs --write         записать webp
    node tools/optimize-images.mjs --write --drop  записать и удалить исходники
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}`;
const WRITE = process.argv.includes('--write');
const DROP = process.argv.includes('--drop');

/* Ширины подобраны по самому крупному месту показа: карточка товара в
   галерее — 520 px, фон слайдера — во всю ширину экрана. Двукратный запас
   оставлен на экраны с высокой плотностью точек. */
const GROUPS = [
  { dir: 'assets/img/products', maxWidth: 900, quality: 0.82 },
  { dir: 'assets/img/photo', maxWidth: 1800, quality: 0.78 },
];

const files = [];
for (const g of GROUPS) {
  const abs = path.join(ROOT, g.dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (!/\.(jpe?g|png)$/i.test(f)) continue;
    files.push({ ...g, name: f, src: path.join(abs, f), out: path.join(abs, f.replace(/\.(jpe?g|png)$/i, '.webp')) });
  }
}
if (!files.length) { console.log('Нечего перекодировать.'); process.exit(0); }

/* Картинки отдаём тем же локальным сервером: холст в браузере отказывается
   отдавать содержимое, если изображение пришло с другого источника, а с
   file:// страница его вообще не прочитает. */
const server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), String(PORT)], { stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { } };
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

let before = 0, after = 0, done = 0;
for (const f of files) {
  const b64 = await page.evaluate(async ({ url, maxWidth, quality }) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/webp', quality).split(',')[1], w: c.width, h: c.height, ow: img.naturalWidth };
  }, { url: BASE + '/' + path.relative(ROOT, f.src).split(path.sep).join('/'), maxWidth: f.maxWidth, quality: f.quality });

  const buf = Buffer.from(b64.data, 'base64');
  const srcSize = fs.statSync(f.src).size;   // читаем до удаления исходника
  before += srcSize;
  after += buf.length;
  if (WRITE) {
    fs.writeFileSync(f.out, buf);
    if (DROP) fs.unlinkSync(f.src);
  }
  if (++done <= 3 || done === files.length) {
    console.log(`  ${f.name} ${b64.ow}px → ${b64.w}px, ${(srcSize / 1024).toFixed(0)} КБ → ${(buf.length / 1024).toFixed(0)} КБ`);
  }
}
await browser.close();
stop();

const kb = (n) => (n / 1024).toFixed(0) + ' КБ';
console.log(`${WRITE ? 'Перекодировано' : 'Будет перекодировано'}: ${files.length} файлов, ${kb(before)} → ${kb(after)} (−${Math.round((1 - after / before) * 100)}%)`);
if (!WRITE) console.log('Это предварительный просмотр. Запишет только запуск с ключом --write.');
