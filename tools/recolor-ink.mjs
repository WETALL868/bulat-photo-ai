#!/usr/bin/env node
/*
  Перекраска фотографии флакона чернил в другие цвета.

  Нужна только демонстрационному каталогу: в выгрузке лежит один цвет линейки,
  а блок «весь комплект» показать не на чем. Пиксели с высокой насыщенностью
  получают новый тон, серые и белые (крышка, этикетка, тень) остаются как есть.
  С приходом настоящей выгрузки Hi-Black эти файлы заменятся фотографиями
  поставщика, а тул можно удалить.

    node tools/recolor-ink.mjs p_2131 magenta:p_2131m yellow:p_2131y black:p_2131k
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'assets/img/products');
const HUE = { cyan: 200, magenta: 320, yellow: 52, black: null };

const [src, ...jobs] = process.argv.slice(2);
if (!src || !jobs.length) {
  console.error('Как звать: node tools/recolor-ink.mjs p_2131 magenta:p_2131m …');
  process.exit(1);
}

const b64 = fs.readFileSync(path.join(DIR, src + '.webp')).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');

for (const job of jobs) {
  const [tone, out] = job.split(':');
  if (!(tone in HUE)) { console.error('Неизвестный цвет: ' + tone); continue; }
  const dataUrl = await page.evaluate(async ({ b64, hue }) => {
    const img = new Image();
    img.src = 'data:image/webp;base64,' + b64;
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i] / 255, g = p[i + 1] / 255, bl = p[i + 2] / 255;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), l = (mx + mn) / 2;
      const s = mx === mn ? 0 : (l > .5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
      if (s < 0.28) continue;                       // серое и белое не трогаем
      if (hue === null) {                           // чёрные чернила: обесцветить
        const v = Math.max(0, Math.min(1, l * 0.55));
        p[i] = p[i + 1] = p[i + 2] = Math.round(v * 255);
        continue;
      }
      const h = hue / 360;
      const q = l < .5 ? l * (1 + s) : l + s - l * s, pp = 2 * l - q;
      const conv = (t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return pp + (q - pp) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return pp + (q - pp) * (2 / 3 - t) * 6;
        return pp;
      };
      p[i] = Math.round(conv(h + 1 / 3) * 255);
      p[i + 1] = Math.round(conv(h) * 255);
      p[i + 2] = Math.round(conv(h - 1 / 3) * 255);
    }
    x.putImageData(d, 0, 0);
    return c.toDataURL('image/webp', 0.9);
  }, { b64, hue: HUE[tone] });
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(DIR, out + '.webp'), buf);
  console.log('  ' + out + '.webp — ' + tone + ', ' + (buf.length / 1024).toFixed(1) + ' КБ');
}
await browser.close();
