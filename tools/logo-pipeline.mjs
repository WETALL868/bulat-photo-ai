/* Подготовка логотипа Hi-Black для шапки из утверждённого мастер-PNG.

   Запуск: node tools/logo-pipeline.mjs [вход] [выход] [высота]
   По умолчанию: assets/img/src/hi-black-logo-approved-v2.png ->
                 assets/img/hi-black-logo-approved-v2.png, 92px (2x к посадке 46px).

   Шаги:
     1. Обрезка пустых прозрачных полей по границе непрозрачных пикселей.
     2. Гашение бликов и глянца — тональный ремап. Геометрия не трогается
        вообще: у каждого пикселя меняется только цвет.
     3. Масштаб с усреднением по площади в premultiplied alpha (без каймы).
     4. Пережатие PNG без потерь: лучший фильтр на строку + zlib 9.

   Параметры обработки собраны в TUNE. Менять их безопасно: форма знака от них
   не зависит. blackLo/blackHi — в какой диапазон сжимается чёрное (сатин
   вместо зеркала), gold — три опорные точки тёплого матового градиента 40°,
   dgLo/dgHi — гейт теней, ниже которого пиксель считается чёрным, иначе в
   глубоких тенях маска дрожит и появляется крапина.

   Отдельная сложность — отличить блик на золотом шарике от блика на чёрной
   букве: оба почти белые и по насыщенности неразличимы. Поэтому пиксели
   делятся на уверенные (явно золото либо явно тёмное) и неуверенные
   (обесцвеченные и яркие). Неуверенные не классифицируются сами по себе:
   их вес берётся как взвешенное среднее уверенных соседей в радиусе fill.
   Без этого ядра бликов на шариках проваливаются в чёрный, и шарики
   превращаются в плоские кружки с тёмными пятнами.
*/
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const TUNE = {
  blackLo: 7, blackHi: 46, blackG: 0.70,
  gold: [[56, 41, 15], [168, 130, 52], [238, 208, 138]], goldG: 0.95,
  sLo: 0.14, sHi: 0.30, keep: 0.08,
  fill: 45, smooth: 6, specL: 165, dgLo: 4, dgHi: 24,
};

/* ----------------------------------------------------------------- PNG */
const T = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c; }
const crc = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function decode(file) {
  const d = fs.readFileSync(file); let i = 8, idat = [], w, h, bd, ct;
  while (i < d.length) { const len = d.readUInt32BE(i), typ = d.toString('ascii', i + 4, i + 8);
    if (typ === 'IHDR') { w = d.readUInt32BE(i + 8); h = d.readUInt32BE(i + 12); bd = d[i + 16]; ct = d[i + 17]; }
    else if (typ === 'IDAT') idat.push(d.subarray(i + 8, i + 8 + len)); i += 12 + len; }
  if (bd !== 8 || ct !== 6) throw new Error('нужен 8-битный RGBA PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, px = Buffer.alloc(h * stride);
  let pos = 0, prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) { const f = raw[pos++]; const l = Buffer.from(raw.subarray(pos, pos + stride)); pos += stride;
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? l[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) l[x] = (l[x] + a) & 255; else if (f === 2) l[x] = (l[x] + b) & 255;
      else if (f === 3) l[x] = (l[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        l[x] = (l[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; } }
    l.copy(px, y * stride); prev = l; }
  return { w, h, px };
}

function encode({ w, h, px }, file) {
  /* Полностью прозрачные пиксели несут случайный RGB — он невидим, но мешает
     сжатию. Обнуляем: на вид ничего не меняется, файл заметно легче. */
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 0) px[i] = px[i + 1] = px[i + 2] = 0;
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * (stride + 1));
  let prev = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) { const line = px.subarray(y * stride, (y + 1) * stride);
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) { const o = cand[f]; let sum = 0;
      for (let x = 0; x < stride; x++) { const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v; if (f === 0) v = line[x]; else if (f === 1) v = line[x] - a; else if (f === 2) v = line[x] - b;
        else if (f === 3) v = line[x] - ((a + b) >> 1);
        else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = line[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        v &= 255; o[x] = v; sum += v < 128 ? v : 256 - v; }
      if (sum < bestSum) { bestSum = sum; best = f; } }
    out[y * (stride + 1)] = best; cand[best].copy(out, y * (stride + 1) + 1); prev = line; }
  const idat = zlib.deflateSync(out, { level: 9, memLevel: 9 });
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'ascii');
    d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ih), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}

/* --------------------------------------------------------------- шаг 1 */
function trim(img, thr = 6) {
  const { w, h, px } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (x1 < 0) throw new Error('файл полностью прозрачный');
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1, out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) px.copy(out, y * nw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + nw) * 4);
  console.log(`  обрезка полей: ${w}x${h} -> ${nw}x${nh} (слева ${x0}, сверху ${y0}, справа ${w - 1 - x1}, снизу ${h - 1 - y1})`);
  return { w: nw, h: nh, px: out };
}

/* --------------------------------------------------------------- шаг 2 */
function tune(img, P) {
  const { w, h, px } = img, N = w * h;
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const goldAt = (t) => t <= 0.5 ? lerp3(P.gold[0], P.gold[1], t * 2) : lerp3(P.gold[1], P.gold[2], (t - 0.5) * 2);
  const box = (src, r) => { if (r < 1) return src.slice();
    const t = new Float32Array(N), o = new Float32Array(N), d = 2 * r + 1;
    for (let y = 0; y < h; y++) { let a = 0, row = y * w;
      for (let x = -r; x <= r; x++) a += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { t[row + x] = a / d;
        a -= src[row + Math.min(w - 1, Math.max(0, x - r))]; a += src[row + Math.min(w - 1, Math.max(0, x + r + 1))]; } }
    for (let x = 0; x < w; x++) { let a = 0;
      for (let y = -r; y <= r; y++) a += t[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { o[y * w + x] = a / d;
        a -= t[Math.min(h - 1, Math.max(0, y - r)) * w + x]; a += t[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x]; } }
    return o; };

  const Lum = new Float32Array(N), raw = new Float32Array(N), conf = new Float32Array(N);
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], al = px[i + 3];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const S = mx === 0 ? 0 : (mx - mn) / mx;
    let hue = 0;
    if (mx !== mn) { const d = mx - mn;
      hue = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4); hue *= 60; }
    Lum[p] = L;
    raw[p] = al === 0 ? 0 : (hue >= 12 && hue <= 78 ? 1 : 0) * ss(P.sLo, P.sHi, S);
    conf[p] = al === 0 ? 0 : (S >= P.sHi || L <= P.specL) ? 1 : 0;
  }
  const num = box(raw.map((v, p) => v * conf[p]), P.fill), den = box(conf, P.fill);
  const mask = new Float32Array(N);
  for (let p = 0; p < N; p++) mask[p] = conf[p] ? raw[p] : (den[p] > 0.02 ? num[p] / den[p] : raw[p]);
  const M = box(mask, P.smooth);

  let spec = 0;
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    if (px[i + 3] === 0) continue;
    if (!conf[p]) spec++;
    const L = Lum[p], r = px[i], g = px[i + 1], b = px[i + 2];
    const wG = Math.min(1, Math.max(0, M[p])) * ss(P.dgLo, P.dgHi, L);
    const nl = P.blackLo + (P.blackHi - P.blackLo) * Math.pow(L / 255, P.blackG);
    let gold = goldAt(Math.pow(L / 255, P.goldG));
    if (P.keep > 0) { const base = (gold[0] + gold[1] + gold[2]) / 3, dev = ((r + g + b) / 3 - L) * P.keep;
      gold = gold.map((c) => c + dev * (c / Math.max(1, base)) * 0.35); }
    for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, Math.round(nl + (gold[k] - nl) * wG)));
  }
  console.log(`  гашение бликов: неуверенных пикселей залито по соседям ${spec}`);
  return img;
}

/* --------------------------------------------------------------- шаг 3 */
function resize(img, H) {
  const { w, h, px } = img;
  const W = Math.round(w * H / h);
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy0 = y * h / H, sy1 = (y + 1) * h / H;
    for (let x = 0; x < W; x++) {
      const sx0 = x * w / W, sx1 = (x + 1) * w / W;
      let ar = 0, ag = 0, ab = 0, aa = 0, wt = 0;
      for (let sy = Math.floor(sy0); sy < Math.min(h, Math.ceil(sy1)); sy++) {
        const fy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        for (let sx = Math.floor(sx0); sx < Math.min(w, Math.ceil(sx1)); sx++) {
          const fx = Math.min(sx + 1, sx1) - Math.max(sx, sx0), f = fx * fy;
          if (f <= 0) continue;
          const i = (sy * w + sx) * 4, a = px[i + 3] / 255;
          /* усредняем premultiplied, иначе по краям появляется кайма */
          ar += px[i] * a * f; ag += px[i + 1] * a * f; ab += px[i + 2] * a * f; aa += a * f; wt += f;
        } }
      const o = (y * W + x) * 4;
      if (aa > 0) { out[o] = Math.round(ar / aa); out[o + 1] = Math.round(ag / aa); out[o + 2] = Math.round(ab / aa); }
      out[o + 3] = Math.round(255 * aa / wt);
    } }
  console.log(`  масштаб: ${w}x${h} -> ${W}x${H}  (пропорция ${(W / H).toFixed(4)})`);
  return { w: W, h: H, px: out };
}

/* ------------------------------------------------------------------ */
const SRC = process.argv[2] || 'assets/img/src/hi-black-logo-approved-v2.png';
const DST = process.argv[3] || 'assets/img/hi-black-logo-approved-v2.png';
const H = Number(process.argv[4] || 92);
if (!fs.existsSync(SRC)) { console.error(`не найден мастер-файл: ${SRC}`); process.exit(1); }
console.log(`логотип: ${SRC}`);
let img = decode(SRC);
img = trim(img);
img = tune(img, TUNE);
img = resize(img, H);
fs.mkdirSync(path.dirname(DST), { recursive: true });
encode(img, DST);
console.log(`готово: ${DST}  ${(fs.statSync(DST).size / 1024).toFixed(0)} КБ`);
