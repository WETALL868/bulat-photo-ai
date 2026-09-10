#!/usr/bin/env node
/*
  Фоновая графика подвала и меню каталога.

  Слайдер сюда не входит: там лежат фотографии из assets/img/banners/, рисовать
  технику кодом для витрины оказалось плохой идеей.

  Раньше здесь стояли снимки принтеров с Wikimedia Commons: лицензии CC BY и
  CC BY-SA разрешают коммерческое использование, но требуют указывать автора,
  а CC BY-SA ещё и обязывает открывать переделки под той же лицензией. Для
  фирменного магазина это лишняя зависимость, поэтому техника нарисована здесь:
  права на рисунки принадлежат магазину, подпись под ними не нужна.

  Всё рисуется в аксонометрии: глубина уходит вправо-вверх, у каждой коробки
  видны передняя грань, верх и правый бок. Цвета — фирменные: чёрный корпус,
  жёлтый Hi-Black на акцентах.

    node tools/make-art.mjs        → assets/img/art/*.svg
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets/img/art');
const W = 1600, H = 900;
const YEL = '#ffd200';

/* ------------------------------------------------------------- аксонометрия */
const DX = 0.46, DY = 0.30;
const px = (x, z) => (x + z * DX).toFixed(1);
const py = (y, z) => (y - z * DY).toFixed(1);
const pt = (x, y, z) => px(x, z) + ',' + py(y, z);
const quad = (a, b, c, d, fill, op) => `<polygon points="${a} ${b} ${c} ${d}" fill="${fill}"${op == null ? '' : ` opacity="${op}"`}/>`;

/* Коробка: верх, правый бок, передняя грань. */
function box(x, y, w, h, d, c) {
  return quad(pt(x, y, 0), pt(x + w, y, 0), pt(x + w, y, d), pt(x, y, d), c.top) +
    quad(pt(x + w, y, 0), pt(x + w, y, d), pt(x + w, y + h, d), pt(x + w, y + h, 0), c.side) +
    quad(pt(x, y, 0), pt(x + w, y, 0), pt(x + w, y + h, 0), pt(x, y + h, 0), c.front);
}
/* Прямоугольник на передней грани. */
const face = (x, y, w, h, fill, op) => quad(pt(x, y, 0), pt(x + w, y, 0), pt(x + w, y + h, 0), pt(x, y + h, 0), fill, op);
/* Прямоугольник на верхней грани. */
const top = (x, y, w, d, z, fill, op) => quad(pt(x, y, z), pt(x + w, y, z), pt(x + w, y, z + d), pt(x, y, z + d), fill, op);
/* Мягкая тень под техникой. */
const shade = (cx, cy, rx, ry, op = 0.5) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#sh)" opacity="${op}"/>`;

const GREY = { top: '#4e4e49', front: '#3a3a36', side: '#232320' };
const DARK = { top: '#3a3a36', front: '#2a2a27', side: '#191917' };
const BLACK = { top: '#3c3b37', front: '#232320', side: '#141413' };
const GOLD = { top: '#ffdd3a', front: '#ffd200', side: '#c9a400' };
const PAPER = '#f2f0e9', PAPER2 = '#cfccc3';

/* --------------------------------------------------------------- принтер */
function printer(W0 = 300, withScanner = false) {
  const s = W0 / 300, D = W0 * 0.52;
  let o = '';
  o += box(0, 150 * s, W0, 46 * s, D, DARK);                              // кассета
  o += face(6 * s, 158 * s, W0 - 12 * s, 28 * s, '#000', .3);
  o += face(W0 * .42, 166 * s, W0 * .16, 12 * s, '#5d5b52');
  o += box(0, 40 * s, W0, 110 * s, D, GREY);                              // корпус
  o += face(10 * s, 96 * s, W0 - 20 * s, 16 * s, '#0c0c0b');              // щель вывода
  o += face(10 * s, 58 * s, 60 * s, 10 * s, YEL);                         // фирменная полоса
  o += face(10 * s, 122 * s, W0 * .5, 12 * s, '#2c2c29');
  o += top(14 * s, 40 * s, W0 - 28 * s, D * .52, D * .12, '#2e2e2b');     // приёмный лоток
  o += top(24 * s, 40 * s, W0 - 48 * s, D * .40, D * .18, '#232320');
  // лист на лотке
  const lx = 34 * s, lz = D * .22, lw = W0 * .62, ld = D * .40;
  o += top(lx, 38 * s, lw, ld, lz, PAPER);
  [[.25, .80, YEL], [.45, .80, PAPER2], [.65, .55, PAPER2]].forEach(([k, len, col]) => {
    o += top(lx + lw * .10, 37 * s, lw * len - lw * .10, ld * .05, lz + ld * k, col);
  });
  if (withScanner) {
    // Крышка сканера стоит на двух стойках, между ней и корпусом — щель вывода.
    o += box(W0 * .06, 18 * s, W0 * .10, 24 * s, D * .30, { top: '#2a2a27', front: '#1e1e1c', side: '#141413' });
    o += box(W0 * .84, 18 * s, W0 * .10, 24 * s, D * .30, { top: '#2a2a27', front: '#1e1e1c', side: '#141413' });
    o += box(-6 * s, -4 * s, W0 + 12 * s, 22 * s, D * 1.02, { top: '#565650', front: '#3f3f3a', side: '#262622' });
    o += top(10 * s, -4 * s, W0 - 20 * s, D * .70, D * .16, '#4a4a45');
    o += face(W0 * .58, 2 * s, W0 * .34, 11 * s, '#171716');
    o += face(W0 * .61, 4 * s, W0 * .16, 7 * s, YEL, .9);
  } else {
    o += top(W0 * .60, 40 * s, W0 * .34, D * .22, D * .74, '#171716');    // панель
    o += top(W0 * .63, 40 * s, W0 * .16, D * .13, D * .78, YEL, .9);
    o += top(W0 * .84, 40 * s, W0 * .05, D * .09, D * .80, '#8a8880');
    // подающий лоток сзади
    o += quad(pt(W0 * .18, 36 * s, D * .90), pt(W0 * .82, 36 * s, D * .90), pt(W0 * .74, -22 * s, D * 1.30), pt(W0 * .26, -22 * s, D * 1.30), '#2b2b28');
    o += quad(pt(W0 * .22, 33 * s, D * .96), pt(W0 * .78, 33 * s, D * .96), pt(W0 * .72, -18 * s, D * 1.26), pt(W0 * .28, -18 * s, D * 1.26), PAPER, .92);
  }
  return o;
}

/* ------------------------------------------------------------- картридж */
function cartridge(W0 = 230, capColor = GOLD) {
  const s = W0 / 230, HH = W0 * 0.30, D = W0 * 0.30;
  let o = '';
  o += box(0, 0, W0, HH, D, BLACK);
  o += box(3 * s, -13 * s, W0 - 6 * s, 13 * s, D * .94, capColor);        // крышка
  o += face(0, HH, W0, 13 * s, '#0c0c0b');                                // барабан
  o += face(6 * s, HH + 3 * s, W0 - 12 * s, 6 * s, '#4b4941');
  o += face(16 * s, HH * .40, 80 * s, HH * .16, '#57554c');
  o += face(16 * s, HH * .66, 50 * s, HH * .11, '#3a3934');
  o += `<circle cx="${px(W0 * .86, 0)}" cy="${py(HH * .55, 0)}" r="${9 * s}" fill="#2c2b28"/>` +
    `<circle cx="${px(W0 * .86, 0)}" cy="${py(HH * .55, 0)}" r="${4 * s}" fill="${YEL}"/>`;
  return o;
}

/* ------------------------------------------------------------ фон и сборка */
const dots = (id, step, r, color) =>
  `<pattern id="${id}" width="${step}" height="${step}" patternUnits="userSpaceOnUse">` +
  `<circle cx="${step / 2}" cy="${step / 2}" r="${r}" fill="${color}"/></pattern>`;
const spot = (id, cx, cy, r, a) =>
  `<radialGradient id="${id}-g" cx="${cx}" cy="${cy}" r="${r}">` +
  `<stop offset="0" stop-color="#fff" stop-opacity="${a}"/>` +
  `<stop offset=".55" stop-color="#fff" stop-opacity="${(a * .45).toFixed(2)}"/>` +
  `<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
  `<mask id="${id}"><rect width="${W}" height="${H}" fill="url(#${id}-g)"/></mask>`;
const SHADOW = `<radialGradient id="sh"><stop offset="0" stop-color="#000" stop-opacity=".75"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>`;

const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">` +
  `<defs>${defs}</defs>${body}</svg>`;
const MW = 1600, MH = 440;
const svgWide = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MW} ${MH}" width="${MW}" height="${MH}" preserveAspectRatio="xMaxYMid slice">` +
  `<defs>${defs}</defs>${body}</svg>`;

/* Подвал: ряд техники справа, приглушённо — сверху ляжет тёмная заливка. */
const footer = svg(
  SHADOW + dots('d1', 30, 3.2, YEL) +
  `<radialGradient id="glow" cx="72%" cy="52%" r="42%"><stop offset="0" stop-color="#4a453a" stop-opacity=".85"/>` +
  `<stop offset="60%" stop-color="#2a2823" stop-opacity=".45"/><stop offset="100%" stop-color="#151413" stop-opacity="0"/></radialGradient>` +
  `<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity=".6"/></linearGradient>` +
  `<mask id="mf"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>`,
  `<rect width="${W}" height="${H}" fill="#151413"/>` +
  `<rect width="${W}" height="${H}" fill="url(#glow)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d1)" mask="url(#mf)"/>` +
  `<g transform="translate(1000 330)">${printer(420, true)}</g>` +
  `<g transform="translate(770 620)">${cartridge(240)}</g>`
);

/* Меню каталога: светлый фон с картриджами у правого края, поверх идут ссылки.
   Полоса меню низкая и широкая, поэтому холст здесь свой, не 16:9. */
const catmenu = svgWide(
  SHADOW +
  `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/>` +
  `<stop offset="55%" stop-color="#fdfcf9"/><stop offset="100%" stop-color="#f4f2ea"/></linearGradient>` +
  dots('d1', 26, 2.6, '#ffd200') +
  `<linearGradient id="mg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".55"/></linearGradient>` +
  `<mask id="m1"><rect width="${MW}" height="${MH}" fill="url(#mg)"/></mask>`,
  `<rect width="${MW}" height="${MH}" fill="url(#bg)"/>` +
  `<rect width="${MW}" height="${MH}" fill="url(#d1)" mask="url(#m1)"/>` +
  /* Поверх фона идут плитки брендов, поэтому картриджи здесь — почти
     невидимая фактура: заметны углом глаза и не спорят с логотипами. */
  `<g opacity=".07">` +
  `<g transform="translate(1250 130)">${cartridge(300)}</g>` +
  `<g transform="translate(1095 288)">${cartridge(215)}</g>` +
  `</g>`
);

fs.mkdirSync(OUT, { recursive: true });
for (const [name, s] of [['footer.svg', footer], ['catmenu.svg', catmenu]]) {
  fs.writeFileSync(path.join(OUT, name), s);
  console.log('  ' + name.padEnd(14) + (s.length / 1024).toFixed(1) + ' КБ');
}
console.log('Нарисовано, права на рисунки у магазина.');
