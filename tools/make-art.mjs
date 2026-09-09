#!/usr/bin/env node
/*
  Фоновая графика слайдера и подвала.

  Раньше здесь стояли снимки принтеров с Wikimedia Commons: лицензии CC BY и
  CC BY-SA разрешают коммерческое использование, но требуют указывать автора,
  а CC BY-SA ещё и обязывает открывать переделки под той же лицензией. Для
  фирменного магазина это лишняя зависимость, поэтому фоны нарисованы здесь:
  права на них принадлежат магазину, подпись под ними не нужна.

  Рисунок собран из растровых точек — так же, как жёлтая «сыпь» на упаковке
  Hi-Black, — и из диагоналей под наклоном логотипа. Точки нарисованы
  повторяющимся узором и погашены градиентной маской, поэтому файл весит
  килобайты, а не сотню: в сборку «одним файлом» он уходит целиком.

    node tools/make-art.mjs        → assets/img/art/*.svg
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets/img/art');
const W = 1600, H = 900;
const YEL = '#ffd200';

/* Узор из точек: одна точка на клетку, дальше повторяется сам. */
const dots = (id, step, r, color) =>
  `<pattern id="${id}" width="${step}" height="${step}" patternUnits="userSpaceOnUse">` +
  `<circle cx="${step / 2}" cy="${step / 2}" r="${r}" fill="${color}"/></pattern>`;

/* Диагональные полосы под наклоном знака Hi-Black. */
const bars = (id, step, w, color, op) =>
  `<pattern id="${id}" width="${step}" height="${step}" patternUnits="userSpaceOnUse" patternTransform="skewX(-12)">` +
  `<rect width="${w}" height="${step}" fill="${color}" opacity="${op}"/></pattern>`;

/* Маска-пятно: где белое — узор виден, где чёрное — погашен. */
const spot = (id, cx, cy, r, a, stretch) =>
  `<radialGradient id="${id}-g" cx="${cx}" cy="${cy}" r="${r}"${stretch ? ` gradientTransform="translate(0 ${cy}) scale(1 ${stretch}) translate(0 ${-cy / stretch})"` : ''}>` +
  `<stop offset="0" stop-color="#fff" stop-opacity="${a}"/>` +
  `<stop offset=".55" stop-color="#fff" stop-opacity="${(a * 0.45).toFixed(2)}"/>` +
  `<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
  `<mask id="${id}"><rect width="${W}" height="${H}" fill="url(#${id}-g)"/></mask>`;

const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">` +
  `<defs>${defs}</defs>${body}</svg>`;

/* Слайд 1: свет и крупная растровая сыпь справа, текст слева ложится на тень. */
const slide1 = svg(
  `<radialGradient id="bg" cx="72%" cy="40%" r="70%">` +
  `<stop offset="0" stop-color="#3b3527"/><stop offset="55%" stop-color="#1d1b17"/><stop offset="100%" stop-color="#0f0f0e"/></radialGradient>` +
  dots('d1', 21, 4.4, YEL) + dots('d2', 11, 1.5, YEL) + bars('b1', 130, 16, '#fff', '.05') +
  spot('m1', '74%', '40%', '34%', 0.95) + spot('m2', '78%', '46%', '55%', 0.4) + spot('m3', '68%', '50%', '70%', 1),
  `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#b1)" mask="url(#m3)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d1)" mask="url(#m1)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d2)" mask="url(#m2)"/>`
);

/* Слайд 2: холодный свет слева, жёлтая сыпь уходит вниз вправо. */
const slide2 = svg(
  `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#191a1d"/><stop offset="55%" stop-color="#141413"/><stop offset="100%" stop-color="#2a2519"/></linearGradient>` +
  dots('d1', 24, 5.4, YEL) + dots('d2', 13, 1.8, YEL) + dots('d3', 30, 2.6, '#9dc0e4') + bars('b1', 96, 10, '#fff', '.05') +
  spot('m1', '78%', '68%', '36%', 0.9) + spot('m2', '74%', '62%', '58%', 0.35) +
  spot('m3', '14%', '18%', '40%', 0.5) + spot('m4', '50%', '50%', '75%', 1),
  `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#b1)" mask="url(#m4)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d3)" mask="url(#m3)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d1)" mask="url(#m1)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d2)" mask="url(#m2)"/>`
);

/* Подвал: ровная сетка точек, гаснет к левому краю, где стоит текст. */
const footer = svg(
  dots('d1', 30, 3.4, YEL) + dots('d2', 15, 1.2, YEL) + bars('b1', 170, 14, '#fff', '.04') +
  `<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">` +
  `<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".45" stop-color="#fff" stop-opacity=".18"/>` +
  `<stop offset="1" stop-color="#fff" stop-opacity=".7"/></linearGradient>` +
  `<mask id="mf"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>` +
  spot('ms', '85%', '40%', '55%', 0.5),
  `<rect width="${W}" height="${H}" fill="#151413"/>` +
  `<rect width="${W}" height="${H}" fill="url(#b1)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d1)" mask="url(#mf)"/>` +
  `<rect width="${W}" height="${H}" fill="url(#d2)" mask="url(#ms)"/>`
);

fs.mkdirSync(OUT, { recursive: true });
for (const [name, s] of [['slide-1.svg', slide1], ['slide-2.svg', slide2], ['footer.svg', footer]]) {
  fs.writeFileSync(path.join(OUT, name), s);
  console.log('  ' + name.padEnd(14) + (s.length / 1024).toFixed(1) + ' КБ');
}
console.log('Фоны нарисованы, права на них у магазина.');
