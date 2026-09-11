#!/usr/bin/env node
/*
  Командная строка синхронизации VTT.

    node vtt/bin/vtt-sync.mjs diagnose            — одна короткая порция: связь,
                                                    учётные данные, поля ItemDto,
                                                    доступность GetCategories
    node vtt/bin/vtt-sync.mjs full                — полная выгрузка каталога
    node vtt/bin/vtt-sync.mjs runtime             — цены и остатки
    node vtt/bin/vtt-sync.mjs <режим> --mock      — то же самое на фикстурах,
                                                    без сети и без учётных данных

  Учётные данные читаются только из VTT_LOGIN и VTT_PASSWORD. В файлы они
  не пишутся, в логи не попадают, в собранный сайт не уезжают.
*/
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadCredentials, httpRisk, ENV_LOGIN, ENV_PASSWORD } from '../src/config.mjs';
import { runSync } from '../src/sync.mjs';
import { createMockFetch } from '../fixtures/mock-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const mode = argv.find((a) => !a.startsWith('--')) ?? 'diagnose';
const has = (flag) => argv.includes(`--${flag}`);
const valueOf = (flag, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : fallback;
};

const MODES = new Set(['diagnose', 'full', 'runtime']);
if (!MODES.has(mode)) {
  console.error(`Неизвестный режим «${mode}». Доступны: ${[...MODES].join(', ')}`);
  process.exit(2);
}

const configFile = valueOf('config', path.join(ROOT, 'vtt/config.json'));
const storeRoot = valueOf('store', path.join(ROOT, 'vtt-data'));
const mock = has('mock');

let config;
try {
  config = loadConfig(configFile);
} catch (e) {
  console.error(`Конфигурация: ${e.message}`);
  process.exit(2);
}
if (valueOf('portion')) config.portionSize = Number(valueOf('portion'));

let credentials;
if (mock) {
  /* В режиме фикстур настоящие секреты не нужны и не запрашиваются: это
     позволяет прогонять весь конвейер в CI и на машине без доступа к VTT. */
  credentials = { login: 'mock', password: 'mock' };
} else {
  try {
    credentials = loadCredentials();
  } catch (e) {
    console.error(e.message);
    console.error(`\nПример: ${ENV_LOGIN}=... ${ENV_PASSWORD}=... node vtt/bin/vtt-sync.mjs ${mode}`);
    console.error('Либо прогоните конвейер на фикстурах: --mock');
    process.exit(3);
  }
  const risk = httpRisk(config.serviceUrl);
  if (risk.risk && !has('allow-insecure-http')) {
    console.error(`ОТКАЗ: ${risk.message}`);
    console.error('Если канал доверенный и решение принято осознанно, повторите с --allow-insecure-http.');
    process.exit(4);
  }
}

const fetchImpl = mock
  ? createMockFetch({ categories: has('no-categories') ? null : undefined })
  : undefined;

try {
  const report = await runSync(mode, { config, credentials, storeRoot, fetchImpl });
  console.log('\n--- отчёт ---');
  console.log(JSON.stringify(report, (k, v) => (k === 'sample' ? `[${v.length} шт., см. vtt-data/reports]` : v), 2));
  if (mock) console.log('\nРежим фикстур: данные синтетические, в vtt-data/ лежит тестовый набор.');
} catch (e) {
  console.error(`\nСинхронизация не выполнена: ${e.message}`);
  if (e.detail) console.error(`Подробности: ${e.detail}`);
  process.exit(1);
}
