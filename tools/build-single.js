#!/usr/bin/env node
/*
  Сборка сайта в один HTML-файл: все стили, скрипты, шрифты и картинки
  встраиваются внутрь (base64). Удобно, чтобы отправить прототип одним файлом
  или опубликовать как артефакт.

    node tools/build-single.js              → dist/hi-black.html (полноценный документ)
    node tools/build-single.js --artifact   → dist/hi-black-artifact.html (без <html>/<head>/<body>,
                                              формат для публикации в артефакт Claude)
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const artifact = process.argv.includes('--artifact');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function dataUri(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('Нет файла: ' + rel);
  const ext = path.extname(rel).toLowerCase();
  return 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + fs.readFileSync(abs).toString('base64');
}
// url(../img/x.jpg) в CSS → data URI (пути относительно assets/css/)
function inlineCssUrls(css) {
  return css.replace(/url\((['"]?)(\.\.\/[^'")]+)\1\)/g, (m, q, rel) => 'url(' + dataUri(path.join('assets/css', rel)) + ')');
}
// "assets/img/..." внутри data.js → data URI
function inlineJsPaths(js) {
  return js.replace(/"(assets\/img\/[^"]+)"/g, (m, rel) => '"' + dataUri(rel) + '"');
}
// src="assets/img/..." в HTML → data URI
function inlineHtmlSrcs(html) {
  return html.replace(/(src|href)="(assets\/img\/[^"]+)"/g, (m, attr, rel) => attr + '="' + dataUri(rel) + '"');
}

let html = read('index.html');
const css = inlineCssUrls(read('assets/css/fonts.css') + '\n' + read('assets/css/styles.css'));
const js = read('assets/js/icons.js') + '\n' + inlineJsPaths(read('assets/js/data.js')) + '\n' + read('assets/js/app.js');

html = html
  .replace(/<link rel="preload"[^>]*>\s*/g, '')
  .replace(/<link rel="stylesheet" href="assets\/css\/fonts.css">\s*/, '')
  .replace('<link rel="stylesheet" href="assets/css/styles.css">', '<style>\n' + css + '\n</style>')
  .replace(/<script src="assets\/js\/icons.js"><\/script>\s*<script src="assets\/js\/data.js"><\/script>\s*<script src="assets\/js\/app.js"><\/script>/, '<script>\n' + js + '\n</script>');
html = inlineHtmlSrcs(html);

if (artifact) {
  // артефакт сам оборачивает контент в документ: оставляем только содержимое head (title, meta, style) и body
  const title = '<title>Магазин Hi-Black</title>';
  const style = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  const body = (html.match(/<body>([\s\S]*)<\/body>/) || ['', ''])[1];
  html = title + '\n' + style + '\n' + body;
}

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', artifact ? 'hi-black-artifact.html' : 'hi-black.html');
fs.writeFileSync(out, html);
console.log('Собрано:', path.relative(ROOT, out), (fs.statSync(out).size / 1024 / 1024).toFixed(2) + ' МБ');
