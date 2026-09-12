#!/usr/bin/env node
/*
  Этап картинок: скачать, закэшировать, пережать.

    node vtt/bin/vtt-images.mjs                       — всё, чего ещё нет
    node vtt/bin/vtt-images.mjs --limit=200           — первые 200 адресов
    node vtt/bin/vtt-images.mjs --from-dir=<каталог>  — без сети, из папки
    node vtt/bin/vtt-images.mjs --force               — пересобрать варианты
    node vtt/bin/vtt-images.mjs --report              — только показать счёт

  Запускается отдельно от синхронизации и отдельно от сборки витрины.
  Сборка сайта в сеть не ходит: она берёт готовый манифест, а если его
  нет — показывает честную заглушку.

  Повторный запуск ничего не перекачивает: готовые записи пропускаются, а
  неудачи запоминаются, чтобы не биться в один и тот же отсутствующий
  файл на каждой сборке.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VttStore } from '../src/store.mjs';
import { ImageManifest, collectUrls, fetchImage, makeVariants, urlHash, extOf, WIDTHS, FORMATS } from '../src/images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : fallback;
};
const has = (flag) => argv.includes(`--${flag}`);

const storeRoot = path.resolve(valueOf('store', path.join(ROOT, 'vtt-data')));
const cacheDir = path.join(storeRoot, 'images/original');
const publicDir = valueOf('public', 'assets/img/vtt');
const outDir = path.join(ROOT, publicDir);
const manifest = new ImageManifest(path.join(storeRoot, 'images/manifest.json'));
const limit = Number(valueOf('limit', 0)) || 0;
const concurrency = Math.max(1, Number(valueOf('concurrency', 4)) || 4);
const timeoutMs = Number(valueOf('timeout', 30000)) || 30000;
const fromDir = valueOf('from-dir', null);
const force = has('force');

if (has('report')) {
  const s = manifest.stats();
  console.log(JSON.stringify({ ...s, manifest: path.relative(ROOT, manifest.file), publicDir }, null, 2));
  process.exit(0);
}

const store = new VttStore(storeRoot);
if (!fs.existsSync(path.join(storeRoot, 'items'))) {
  console.error(`Стор пуст: ${storeRoot}. Сначала выполните импорт.`);
  process.exit(2);
}

const urls = collectUrls(store);
const all = [...urls.keys()];
const todo = all.filter((u) => force || (!manifest.isReady(u, ROOT) && !manifest.get(u)?.error));
const targets = limit > 0 ? todo.slice(0, limit) : todo;

console.log(`Картинок в каталоге: ${all.length}, к обработке: ${targets.length}` +
  (targets.length < todo.length ? ` (ограничено --limit=${limit})` : ''));
if (fromDir) console.log(`Источник: локальная папка ${fromDir} (сеть не используется)`);

fs.mkdirSync(cacheDir, { recursive: true });

/* Байты исходника: из кэша, из папки или из сети — в таком порядке.
   Кэш живёт отдельно от готовых вариантов, поэтому смена набора ширин
   или качества не требует повторной загрузки. */
async function sourceBytes(url) {
  const hash = urlHash(url);
  const cached = path.join(cacheDir, `${hash}.${extOf(url)}`);
  if (fs.existsSync(cached)) return { buffer: fs.readFileSync(cached), from: 'кэш' };
  if (fromDir) {
    const base = path.basename(new URL(url, 'http://x/').pathname);
    const local = path.join(path.resolve(fromDir), base);
    if (!fs.existsSync(local)) throw new Error(`нет файла ${base} в ${fromDir}`);
    const buffer = fs.readFileSync(local);
    fs.writeFileSync(cached, buffer);
    return { buffer, from: 'папка' };
  }
  const buffer = await fetchImage(url, { timeoutMs });
  fs.writeFileSync(cached, buffer);
  return { buffer, from: 'сеть' };
}

let cursor = 0, ok = 0, failed = 0, madeBytes = 0;
const errors = new Map();

async function worker() {
  while (cursor < targets.length) {
    const i = cursor++;
    const url = targets[i];
    const hash = urlHash(url);
    try {
      const { buffer } = await sourceBytes(url);
      const made = await makeVariants(buffer, { outDir, publicDir, name: hash, widths: WIDTHS, formats: FORMATS });
      manifest.set(url, {
        hash, items: urls.get(url)?.length ?? 0,
        width: made.width, height: made.height, format: made.format,
        variants: made.variants, bytes: made.bytes, madeAt: new Date().toISOString(),
      });
      madeBytes += made.bytes;
      ok += 1;
    } catch (e) {
      /* Ошибка запоминается вместе с причиной: по отчёту сразу видно,
         это отказ сети, битый файл или отсутствующий адрес. */
      manifest.set(url, { hash, error: String(e.message ?? e), triedAt: new Date().toISOString() });
      errors.set(String(e.message ?? e), (errors.get(String(e.message ?? e)) ?? 0) + 1);
      failed += 1;
    }
    if ((ok + failed) % 200 === 0) {
      manifest.save();
      console.log(`  обработано ${ok + failed}/${targets.length}, готово ${ok}, ошибок ${failed}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, worker));
manifest.save();

const stats = manifest.stats();
console.log(`\nГотово: ${ok}, ошибок: ${failed}, новых файлов на ${(madeBytes / 1048576).toFixed(1)} МБ`);
console.log(`Всего в манифесте: ${stats.ok} картинок, ${stats.failed} неудач, ${(stats.bytes / 1048576).toFixed(1)} МБ`);
if (errors.size) {
  console.log('Причины отказов:');
  for (const [msg, n] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(n).padStart(5)} ${msg}`);
}
console.log(`Манифест: ${path.relative(ROOT, manifest.file)}`);
