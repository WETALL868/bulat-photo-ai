/*
  Установка официального знака MAX в общий словарь иконок.

  Зачем инструмент. Знак MAX не удалось скачать из сессии: хосты брендбука
  (go.max.ru, st.max.ru, max.ru, static.max.ru) закрыты политикой исходящего
  трафика — прокси отвечает «403 на CONNECT», запрос наружу не уходит.
  Обходить запрет нельзя, рисовать чужой фирменный знак по памяти — значит
  получить неточный знак. Поэтому в assets/js/icons.js сейчас стоит заведомо
  нейтральная заглушка, а этот скрипт превращает подстановку настоящего знака
  в одну команду: как только официальный архив окажется на диске, знак встанет
  сразу во все четыре точки (карточка товара, контакты, подвал, корзина).

  Использование:
    node tools/set-max-icon.mjs max-colored.zip      # архив с go.max.ru
    node tools/set-max-icon.mjs max-icon.svg         # уже распакованный знак
    node tools/set-max-icon.mjs max.zip --pick 2     # выбрать файл из списка
    node tools/set-max-icon.mjs max-icon.svg --keep-colors

  Что делает:
    • берёт из архива SVG знака БЕЗ текста (файлы с текстовым логотипом
      отсеиваются по имени; если однозначно не выбрать — покажет список);
    • приводит рисунок к системному viewBox «0 0 24 24», сохраняя пропорции
      и центруя знак;
    • по умолчанию переводит заливку в currentColor. Это не вольность с чужим
      знаком, а способ соблюсти брендбук в обеих темах сразу: в тёмном подвале
      currentColor — светлый, в белых блоках — тёмный, то есть знак всегда
      контрастен фону. Нужен исходный фирменный цвет — флаг --keep-colors;
    • пишет результат в ключ "max" файла assets/js/icons.js и больше никуда:
      и витрина, и сборщик каталога читают этот один ключ.

  После установки: npm run build && npm run single
*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'assets/js/icons.js');

const args = process.argv.slice(2);
const keepColors = args.includes('--keep-colors');
const pickAt = args.indexOf('--pick');
const pick = pickAt >= 0 ? Number(args[pickAt + 1]) : 0;
const input = args.find((a) => !a.startsWith('--') && a !== String(pick));

const die = (msg) => { console.error('\n  ' + msg + '\n'); process.exit(1); };

if (!input) die('Укажите файл: node tools/set-max-icon.mjs <знак.svg|архив.zip>');
if (!fs.existsSync(input)) die('Файл не найден: ' + input);

/* Из архива нужен именно знак, без текстовой части логотипа. Имена в
   брендбуках устроены однотипно, поэтому отбор идёт по ним, а спорные случаи
   не угадываются молча — скрипт показывает список и просит указать номер. */
function svgFromZip(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-brand-'));
  try {
    execFileSync('unzip', ['-o', '-q', path.resolve(zip), '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    die('Не удалось распаковать архив: ' + (e.stderr ? String(e.stderr).trim() : e.message));
  }
  const all = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.svg$/i.test(name) && !name.startsWith('.')) all.push(p);
    }
  })(dir);
  if (!all.length) die('В архиве нет ни одного .svg');

  const isWordmark = (p) => /text|word|full|horizont|логотип|надпись|lockup|with/i.test(path.basename(p));
  const isMark = (p) => /icon|mark|symbol|sign|glyph|badge|знак|app/i.test(path.basename(p));
  let list = all.filter((p) => !isWordmark(p));
  if (!list.length) list = all;
  const marks = list.filter(isMark);
  if (marks.length) list = marks;

  if (list.length === 1) return list[0];
  if (pick >= 1 && pick <= list.length) return list[pick - 1];
  console.error('\n  В архиве несколько подходящих файлов. Повторите с номером нужного,');
  console.error('  например: node tools/set-max-icon.mjs ' + zip + ' --pick 1\n');
  list.forEach((p, i) => console.error('   ' + (i + 1) + ') ' + path.relative(dir, p)));
  console.error('');
  process.exit(1);
}

const svgFile = /\.zip$/i.test(input) ? svgFromZip(input) : input;
const raw = fs.readFileSync(svgFile, 'utf8');

const open = raw.match(/<svg\b[^>]*>/i);
if (!open) die('Это не похоже на SVG: ' + svgFile);
let body = raw.slice(open.index + open[0].length, raw.lastIndexOf('</svg>'));

/* Служебные узлы в знак не переносим: заголовок и описание озвучит скринридер
   вместо подписи кнопки, комментарии и редакторские метаданные просто мусорят
   разметку, а <style> утёк бы в глобальные стили страницы. */
body = body
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<title\b[\s\S]*?<\/title>/gi, '')
  .replace(/<desc\b[\s\S]*?<\/desc>/gi, '')
  .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '')
  .replace(/\s+/g, ' ')
  .trim();
if (/<style\b/i.test(body)) die('В SVG есть <style> — иконка должна быть чистой геометрией. Экспортируйте знак с расширенными стилями.');
if (!body) die('SVG пустой: ' + svgFile);

/* Все иконки системы живут в квадрате 24×24, поэтому чужой viewBox не
   растягиваем, а вписываем с сохранением пропорций и центруем. */
const num = (s) => Number(String(s).replace(',', '.'));
const vb = (open[0].match(/viewBox\s*=\s*"([^"]+)"/i) || [])[1];
let box = vb ? vb.trim().split(/[\s,]+/).map(num) : null;
if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
  const w = num((open[0].match(/\bwidth\s*=\s*"([\d.]+)/i) || [])[1]);
  const h = num((open[0].match(/\bheight\s*=\s*"([\d.]+)/i) || [])[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) die('У SVG нет ни viewBox, ни размеров — не могу вписать знак в 24×24.');
  box = [0, 0, w, h];
}
const [bx, by, bw, bh] = box;
const r = (n) => Number(n.toFixed(4));
const s = 24 / Math.max(bw, bh);
const tx = r(-bx * s + (24 - bw * s) / 2);
const ty = r(-by * s + (24 - bh * s) / 2);

/* Обёртка с currentColor помогает, только если внутри нет своих цветов:
   инлайновый fill="#…" у path перебил бы её. Поэтому фирменные цвета снимаем,
   а служебное fill="none" оставляем — на нём держатся вырезы внутри знака. */
if (!keepColors) {
  const isPaint = (v) => /^(none|currentColor)$/i.test(v.trim()) === false;
  body = body
    .replace(/\s(fill|stroke)\s*=\s*"([^"]*)"/gi, (m, a, v) => (isPaint(v) ? '' : m))
    .replace(/\sstyle\s*=\s*"([^"]*)"/gi, (m, decls) => {
      const kept = decls.split(';')
        .filter((d) => d.trim() && !/^\s*(fill|stroke)\s*:\s*(?!none|currentColor)/i.test(d))
        .join(';');
      return kept ? ' style="' + kept + '"' : '';
    });
}

const paint = keepColors ? '' : ' fill="currentColor" stroke="none"';
const moved = (s !== 1 || tx !== 0 || ty !== 0);
const transform = moved ? ' transform="translate(' + tx + ' ' + ty + ') scale(' + r(s) + ')"' : '';
const value = (paint || transform) ? '<g' + paint + transform + '>' + body + '</g>' : body;

/* Пишем ровно один ключ: остальной файл и его шапка остаются как есть. */
const src = fs.readFileSync(ICONS, 'utf8');
const key = /^(\s*)"max":\s*"(?:[^"\\]|\\.)*"(,?)\s*$/m;
if (!key.test(src)) die('Не нашёл ключ "max" в assets/js/icons.js');
const out = src.replace(key, (_m, indent, comma) => indent + '"max": ' + JSON.stringify(value) + comma);
fs.writeFileSync(ICONS, out);

/* Проверяем тем же разбором, каким пользуется сборщик каталога: если знак
   сломал бы сборку, узнать об этом лучше сейчас. */
const check = out.match(/window\.HB_ICONS\s*=\s*(\{[\s\S]*?\});/);
try { JSON.parse(check[1]); } catch (e) { die('После записи icons.js не разбирается: ' + e.message); }

console.log('\n  Знак MAX установлен.');
console.log('  Источник:   ' + svgFile);
console.log('  viewBox:    ' + box.join(' ') + '  →  0 0 24 24' + (moved ? ' (масштаб ' + r(s) + ')' : ''));
console.log('  Заливка:    ' + (keepColors ? 'исходная фирменная' : 'currentColor (светлый в подвале, тёмный на белом)'));
console.log('  Записано:   assets/js/icons.js, ключ "max" — все четыре точки берут знак отсюда.');
console.log('\n  Дальше: npm run build && npm run single\n');
