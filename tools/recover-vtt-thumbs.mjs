#!/usr/bin/env node
/*
 * Complete the preview's existing VTT atlases without replacing their cells.
 * Source images are cached outside the published artifact; only compact WebP
 * atlases and the updated map belong in the site build.
 *
 * Usage: node tools/recover-vtt-thumbs.mjs --store=/path/to/vtt-data
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { VttStore } from '../vtt/src/store.mjs';
import { publish } from '../vtt/src/publish.mjs';
import { fetchImage } from '../vtt/src/images.mjs';
import { buildAtlases } from './pack-thumbs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const storeRoot = path.resolve(argument('store', path.join(root, 'vtt-data')));
const concurrency = Math.max(1, Math.min(16, Number(argument('concurrency', '8')) || 8));
const thumbPath = path.join(root, 'data/catalog/thumbs.json');
const cacheDir = path.join(root, 'vtt-data/recovered-primary-photos');
const reportPath = path.join(root, 'vtt-data/recovered-photo-report.json');
const map = JSON.parse(fs.readFileSync(thumbPath, 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'vtt/config.json'), 'utf8'));
const { products } = publish(new VttStore(storeRoot), { filter: config.publishFilter });
const vtt = products.filter((product) => product.source === 'vtt');
const available = vtt.filter((product) => product.images?.[0] && !product.photoMissing);
const missing = available.filter((product) => !map.byVtt?.[product.vttId]);
const withoutSource = vtt.length - available.length;
fs.mkdirSync(cacheDir, { recursive: true });

console.log(`VTT ${vtt.length}; source photo ${available.length}; already in atlases ${available.length - missing.length}; to recover ${missing.length}; no source photo ${withoutSource}`);

const recovered = [];
const failures = [];
let cursor = 0;
async function worker() {
  while (cursor < missing.length) {
    const product = missing[cursor++];
    const url = product.images[0];
    const file = path.join(cacheDir, `${product.vttId}.img`);
    try {
      const bytes = fs.existsSync(file)
        ? fs.readFileSync(file)
        : await fetchImage(url, { timeoutMs: 20000 });
      const metadata = await sharp(bytes, { failOn: 'none' }).metadata();
      if (!metadata.width || !metadata.height) throw new Error('image has no dimensions');
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      recovered.push({ id: String(product.vttId), file });
    } catch (error) {
      failures.push({ id: String(product.vttId), url, reason: String(error?.message ?? error) });
    }
    const processed = recovered.length + failures.length;
    if (processed % 200 === 0) console.log(`  checked ${processed}/${missing.length}: ${recovered.length} good, ${failures.length} failed`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, missing.length)) }, worker));

if (recovered.length) {
  const publicDir = 'assets/img/atlas-extra';
  const result = await buildAtlases(recovered, {
    outDir: path.join(root, publicDir), publicDir,
    cell: map.cell, perAtlas: map.cols * map.rows, quality: 68,
    onProgress: (event) => {
      if (event.kind === 'skip') failures.push({ id: event.id, reason: event.reason });
      if (event.kind === 'atlas') console.log(`  packed atlas ${event.index + 1}/${event.of}`);
    },
  });
  const offset = map.files.length;
  map.files.push(...result.files);
  map.byVtt ??= {};
  map.items ??= {};
  const productByVtt = new Map(vtt.map((product) => [String(product.vttId), product]));
  for (const [id, cell] of Object.entries(result.items)) {
    const placed = [cell[0] + offset, cell[1], cell[2]];
    map.byVtt[id] = placed;
    const product = productByVtt.get(id);
    if (product) map.items[product.id] = placed;
  }
}

// The publisher's transient id can differ from the stable storefront slug
// when VTT has colliding article numbers. Bind every recovered cell through
// the persisted registry so product pages resolve to the right image.
const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/item-registry.json'), 'utf8'));
for (const product of vtt) {
  const cell = map.byVtt?.[product.vttId];
  const slug = registry.items?.[`vtt:${product.vttId}`]?.id;
  if (cell && slug) map.items[slug] = cell;
}
fs.writeFileSync(thumbPath, JSON.stringify(map));

const covered = available.filter((product) => map.byVtt?.[product.vttId]).length;
const report = {
  activeVttProducts: vtt.length,
  sourcePhoto: available.length,
  noSourcePhoto: withoutSource,
  coveredInAtlases: covered,
  missingFromAtlases: available.length - covered,
  newFailures: failures,
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, newFailures: failures.length, reportPath }, null, 2));
