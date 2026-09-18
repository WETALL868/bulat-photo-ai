#!/usr/bin/env node
/*
  Пакет изменений для публикации.

  Владелец забирает коммит и выкладывает сайт сам, поэтому ему нужно не
  «всё», а ровно то, что изменилось, и уверенность, что доехало именно
  оно. Здесь собирается архив изменённых файлов витрины и манифест с
  размером и sha256 каждого — по нему после загрузки видно, что на
  сервере лежит тот же файл, что собрался здесь.

  Двумя частями, потому что у них разная судьба:

    витрина   index.html, styles.css, app.js, catalog.js — сотни
              килобайт, меняются этой правкой, кладутся поверх;
    страницы  seo-pages/** — предрендер, десятки мегабайт. Он пересобран
              с новой оболочкой (версии ?v=, разметка увеличения), и без
              него карточки останутся на старом коде.

  Чего в пакете нет и быть не должно: .env и любой конфигурации доступов,
  var/ с заказами и отзывами покупателей, vtt-data со внутренними
  остатками, node_modules и .git.

    node tools/build-package.mjs [--out=dist/package] [--skip-pages]
*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const OUT = path.resolve(ROOT, argOf('out', 'dist/package'));
const SKIP_PAGES = process.argv.includes('--skip-pages');

/*
  Список закрытого — не «на всякий случай», а по делу: каждая строка это
  то, что однажды уже могло уехать наружу. Проверяется по пути, а не по
  имени: файл .env в подкаталоге такой же секрет, как в корне.
*/
const FORBIDDEN = [/(^|\/)\.env/i, /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/,
  /(^|\/)var(\/|$)/, /(^|\/)vtt-data(\/|$)/, /(^|\/)vtt-source(\/|$)/,
  /config-path\.php$/, /(^|\/)admin-password/i, /\.key$/, /\.pem$/];
const forbidden = (rel) => FORBIDDEN.some((re) => re.test(rel));

const SHOP = ['index.html', 'assets/css/styles.css', 'assets/css/fonts.css',
  'assets/js/app.js', 'assets/js/catalog.js', 'assets/js/icons.js'];

const walk = (dir, base = dir) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (forbidden(rel)) continue;
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(rel);
  }
  return out;
};

const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

const parts = [{ name: 'vitrina', title: 'витрина', files: SHOP.filter((f) => fs.existsSync(path.join(ROOT, f))) }];
if (!SKIP_PAGES && fs.existsSync(path.join(ROOT, 'seo-pages'))) {
  parts.push({ name: 'seo-pages', title: 'предрендер страниц', files: walk(path.join(ROOT, 'seo-pages')) });
}

/* Секрет в пакете — это не предупреждение, а остановка сборки. */
for (const p of parts) {
  const bad = p.files.filter(forbidden);
  if (bad.length) throw new Error(`в пакет попало закрытое: ${bad.slice(0, 3).join(', ')}`);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const manifest = { generatedAt: new Date().toISOString(), parts: [] };
let head = '';
try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { }
if (head) manifest.commit = head;

for (const p of parts) {
  const listFile = path.join(OUT, `${p.name}.files.txt`);
  fs.writeFileSync(listFile, p.files.join('\n') + '\n');
  const archive = path.join(OUT, `${p.name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', ROOT, '-T', listFile]);
  const files = p.files.map((rel) => ({ path: rel, bytes: fs.statSync(path.join(ROOT, rel)).size, sha256: sha(rel) }));
  manifest.parts.push({
    name: p.name, title: p.title, archive: path.basename(archive),
    archiveBytes: fs.statSync(archive).size,
    archiveSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    count: files.length,
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    /* Полный перечень — только у витрины: у предрендера четыре тысячи
       файлов, и построчный список в манифесте читать невозможно. Для него
       хватает суммы и контрольной суммы архива, а имена лежат рядом в
       .files.txt. */
    files: p.name === 'vitrina' ? files : undefined,
  });
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));

const kb = (n) => (n / 1024 / 1024).toFixed(1) + ' МБ';
const readme = [
  'ПАКЕТ ИЗМЕНЕНИЙ HI-BLACK',
  head ? `коммит: ${head}` : '',
  `собран: ${manifest.generatedAt}`,
  '',
  'Что внутри:',
  ...manifest.parts.map((p) => `  ${p.archive} — ${p.title}, файлов ${p.count}, ${kb(p.bytes)} (архив ${kb(p.archiveBytes)})`),
  '',
  'Как выложить (пути от корня сайта):',
  '  tar -xzf vitrina.tar.gz -C /путь/к/сайту',
  ...(manifest.parts.length > 1 ? ['  tar -xzf seo-pages.tar.gz -C /путь/к/сайту'] : []),
  '',
  'Либо пересобрать у себя из коммита — результат тот же:',
  '  npm ci',
  '  npm run catalog     # каталог из текущих цен и остатков',
  '  npm run seo         # предрендер, около 2,5 минут',
  '',
  'Проверить после выкладки:',
  '  версия в index.html и на страницах — styles.css?v= и app.js?v= должны совпасть;',
  '  контрольные суммы файлов витрины — в manifest.json;',
  '  npm test && npm run test:ui && npm run photos.',
  '',
  'Чего в пакете нет: .env и конфигурации доступов, var/ с заказами и',
  'отзывами покупателей, vtt-data со внутренними остатками, node_modules, .git.',
  '',
].filter((l) => l !== '').join('\n');
fs.writeFileSync(path.join(OUT, 'README.txt'), readme + '\n');

console.log(readme);
console.log(`пакет: ${path.relative(ROOT, OUT)}`);
