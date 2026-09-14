#!/usr/bin/env node
/*
  Модерация отзывов.

  Отзыв приходит с сайта в очередь (var/reviews) со статусом pending и
  лежит там, пока его не прочтёт человек. На витрину он выходит только
  со статусом approved — и только после следующей сборки каталога.
  Никакой автоматической публикации нет и не должно быть: отзыв влияет
  на решение о покупке и уходит в микроразметку, поэтому за каждым
  опубликованным отзывом стоит чьё-то осознанное «да».

  Адрес автора виден только здесь. Он нужен, чтобы уточнить отзыв или
  подтвердить покупку, и в data/catalog не попадает никогда.

    node tools/reviews.mjs                     что лежит в очереди
    node tools/reviews.mjs list --all          вместе с решёнными
    node tools/reviews.mjs show <файл>         целиком, с адресом автора
    node tools/reviews.mjs approve <файл>      опубликовать
    node tools/reviews.mjs reject <файл> [why] отклонить
    node tools/reviews.mjs verify <файл>       отметить «покупка подтверждена»
    node tools/reviews.mjs reply <файл> <текст>  ответ магазина
    node tools/reviews.mjs stats               сводка по товарам

  <файл> — имя файла в очереди; хватает начала, если оно однозначно.
  После одобрения нужна пересборка: npm run build.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dirArg = argv.find((a) => a.startsWith('--dir='));
const DIR = path.resolve(ROOT, dirArg ? dirArg.slice(6) : 'var/reviews');
const args = argv.filter((a) => !a.startsWith('--'));
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const cmd = args[0] || 'list';

if (!fs.existsSync(DIR)) {
  console.error(`Очереди нет: ${path.relative(ROOT, DIR)}`);
  console.error('Она появляется, когда с сайта приходит первый отзыв.');
  console.error('Если отзывы на хостинге — заберите папку сюда или укажите --dir=<путь>.');
  process.exit(1);
}

const files = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const save = (f, rv) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(rv, null, 2) + '\n');
const when = (rv) => String(rv.createdAt || '').slice(0, 10);
const MARK = { pending: '·', approved: '✓', rejected: '✕' };

/* Имя файла длинное, набирать его целиком незачем: хватает начала,
   пока оно указывает ровно на один отзыв. */
function pick(prefix) {
  if (!prefix) { console.error('Нужно имя файла из очереди.'); process.exit(1); }
  const hit = files().filter((f) => f.startsWith(prefix) || f === prefix + '.json');
  if (!hit.length) { console.error(`В очереди нет отзыва «${prefix}».`); process.exit(1); }
  if (hit.length > 1) {
    console.error(`«${prefix}» подходит сразу нескольким — уточните:`);
    hit.forEach((f) => console.error('  ' + f));
    process.exit(1);
  }
  return hit[0];
}

function setStatus(f, status, note) {
  const rv = load(f);
  if (rv.status === status) { console.log(`Уже ${status}: ${f}`); return; }
  rv.status = status;
  rv.moderatedAt = new Date().toISOString();
  if (note) rv.moderatorNote = note;
  save(f, rv);
  console.log(`${MARK[status]} ${status}: ${rv.product} — ${rv.name}, ${rv.rate}/5`);
  if (status === 'approved') console.log('  На сайт выйдет после пересборки: npm run build');
}

if (cmd === 'list') {
  const all = flags.has('--all');
  const rows = files().map((f) => ({ f, rv: load(f) }))
    .filter(({ rv }) => all || (rv.status !== 'approved' && rv.status !== 'rejected'));
  if (!rows.length) {
    console.log(all ? 'Очередь пуста.' : 'Непрочитанных отзывов нет.');
    process.exit(0);
  }
  for (const { f, rv } of rows) {
    console.log(`${MARK[rv.status] || '?'} ${f.slice(0, 28).padEnd(28)} ${when(rv)}  ` +
      `${String(rv.rate)}/5  ${String(rv.product).slice(0, 26).padEnd(26)} ${rv.name}`);
    console.log(`    ${String(rv.text || '').replace(/\s+/g, ' ').slice(0, 96)}`);
  }
  console.log(`\nВсего: ${rows.length}. Полностью: show <файл>. Опубликовать: approve <файл>.`);
} else if (cmd === 'show') {
  const f = pick(args[1]);
  const rv = load(f);
  console.log(`файл:    ${f}`);
  for (const [k, v] of Object.entries(rv)) {
    if (k === 'text') continue;
    console.log(`${(k + ':').padEnd(9)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  console.log('\n' + String(rv.text || ''));
} else if (cmd === 'approve') {
  setStatus(pick(args[1]), 'approved');
} else if (cmd === 'reject') {
  setStatus(pick(args[1]), 'rejected', args.slice(2).join(' '));
} else if (cmd === 'verify') {
  const f = pick(args[1]);
  const rv = load(f);
  /* Отметку «покупка подтверждена» ставит человек, сверив отзыв с
     заказом. Сама по себе она не появляется и по одному лишь совпадению
     адреса не выводится — иначе это была бы догадка, выданная за факт. */
  rv.verified = true;
  save(f, rv);
  console.log(`✓ покупка подтверждена: ${rv.product} — ${rv.name}`);
} else if (cmd === 'reply') {
  const f = pick(args[1]);
  const text = args.slice(2).join(' ').trim();
  if (!text) { console.error('Нужен текст ответа.'); process.exit(1); }
  const rv = load(f);
  rv.reply = text;
  save(f, rv);
  console.log(`ответ магазина записан: ${rv.product}`);
} else if (cmd === 'stats') {
  const by = new Map();
  let pending = 0, rejected = 0;
  for (const f of files()) {
    const rv = load(f);
    if (rv.status === 'rejected') { rejected += 1; continue; }
    if (rv.status !== 'approved') { pending += 1; continue; }
    if (!by.has(rv.product)) by.set(rv.product, []);
    by.get(rv.product).push(Number(rv.rate));
  }
  const rows = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [id, rates] of rows) {
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    console.log(`${id.padEnd(34)} ${String(rates.length).padStart(3)} шт.  ${avg.toFixed(1)}`);
  }
  console.log(`\nопубликовано ${rows.reduce((a, r) => a + r[1].length, 0)} на ${rows.length} товарах` +
    `, ждут модерации ${pending}, отклонено ${rejected}`);
} else {
  console.error(`Неизвестная команда «${cmd}». Команды: list, show, approve, reject, verify, reply, stats.`);
  process.exit(1);
}
