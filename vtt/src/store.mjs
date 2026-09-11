/*
  Хранилище импорта: идемпотентный upsert, сырые payload'ы, отчёты.

  Формат — файлы JSON, а не база: витрина статическая, каталог и так
  собирается в JSON, и лишняя зависимость только усложнила бы развёртывание.
  Товары лежат шардами по первому символу хэша Id, чтобы один файл не рос
  до сотен мегабайт и чтобы два соседних запуска не переписывали весь стор
  целиком.

  Идемпотентность. Ключ — Id из VTT. Повторный синк тех же данных не меняет
  ни одного байта: перед записью считается хэш содержательной части (без
  отметок времени), и если он совпал, файл не трогается, а товар считается
  «unchanged». Поэтому по отчёту сразу видно, что реально изменилось.

  Удаление. Товар, пропавший из выгрузки, физически не удаляется никогда.
  Он помечается inactive — и только после того, как синхронизация дошла до
  конца и признана полной. Оборванная на середине выгрузка не должна
  прятать половину каталога, поэтому deactivateMissing вызывается отдельно
  и только с complete: true.

  Атомарность. Каждый файл пишется во временный и переименовывается: при
  сбое на диске остаётся либо старая версия целиком, либо новая целиком,
  но не половина.
*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STORE_VERSION = 1;

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/* Ключи сортируются, иначе один и тот же объект даст разные хэши в
   зависимости от порядка полей, и «ничего не изменилось» перестанет
   работать. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/*
  Что участвует в хэше карточки.

  Хэш отвечает ровно на один вопрос: изменились ли данные, пришедшие от
  поставщика. Поэтому из него исключено всё, что мы вычислили сами.

  Служебные поля — отметки времени и флаги: иначе каждый запуск выглядел бы
  как изменение.

  Производные поля — категория, совместимость из отдельной операции,
  атрибуты, связанные товары. Их пишет этап обогащения, уже после того как
  карточка легла в стор. Если бы они попадали в хэш, следующая полная
  выгрузка считала бы хэш по «голой» карточке, не совпала бы с сохранённым
  и объявила бы изменившимся весь каталог целиком — притом что у
  поставщика не поменялось ничего. Именно это и происходило.
*/
const SERVICE_FIELDS = [
  'syncedAt', 'hash', 'active', 'firstSeenAt', 'updatedAt', 'lastSeenAt',
  'lastSyncId', 'hiddenAt', 'hiddenBySyncId', 'runtime', 'enrichedAt',
];
export const DERIVED_FIELDS = [
  'categoryId', 'categorySource', 'compatibilityLabels', 'compatibilityDetailed',
  'attributes', 'related',
];

export function contentHash(record) {
  const meaningful = {};
  for (const [k, v] of Object.entries(record)) {
    if (SERVICE_FIELDS.includes(k) || DERIVED_FIELDS.includes(k)) continue;
    meaningful[k] = v;
  }
  return sha256(stableStringify(meaningful));
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export class VttStore {
  constructor(root, { shards = 16 } = {}) {
    this.root = path.resolve(root);
    this.shards = shards;
    this.itemsDir = path.join(this.root, 'items');
    this.rawDir = path.join(this.root, 'raw');
    this.statePath = path.join(this.root, 'state.json');
    this.reportsDir = path.join(this.root, 'reports');
  }

  shardOf(id) {
    return sha256(String(id)).slice(0, 1);
  }

  #shardFile(shard) { return path.join(this.itemsDir, `${shard}.json`); }

  loadShard(shard) { return readJson(this.#shardFile(shard), {}); }

  /* Весь стор в память поднимается только там, где это оправдано: при
     сборке витрины и при сверке пропавших товаров. */
  loadAll() {
    const out = new Map();
    if (!fs.existsSync(this.itemsDir)) return out;
    for (const file of fs.readdirSync(this.itemsDir).sort()) {
      if (!file.endsWith('.json')) continue;
      for (const [id, rec] of Object.entries(readJson(path.join(this.itemsDir, file), {}))) out.set(id, rec);
    }
    return out;
  }

  loadState() {
    return readJson(this.statePath, {
      version: STORE_VERSION, lastFullSync: null, lastRuntimeSync: null,
      resume: null, categoriesSource: null,
    });
  }

  saveState(patch) {
    const next = { ...this.loadState(), ...patch, version: STORE_VERSION };
    writeAtomic(this.statePath, JSON.stringify(next, null, 2));
    return next;
  }

  /*
    Сырой payload сохраняется отдельно от нормализованного: он позволяет
    пересобрать каталог после любой правки нормализации, не ходя к VTT.
    Дедупликация по хэшу — один и тот же ответ не хранится дважды.
  */
  saveRaw(kind, payload) {
    const body = JSON.stringify(payload);
    const hash = sha256(body);
    const file = path.join(this.rawDir, kind, `${hash}.json`);
    if (!fs.existsSync(file)) writeAtomic(file, body);
    return { hash, file: path.relative(this.root, file) };
  }

  /*
    Upsert порции. Возвращает отчёт по каждому товару, а не общий флаг:
    иначе непонятно, что именно изменилось между запусками.
  */
  upsertItems(items, { now = new Date().toISOString(), syncId } = {}) {
    const report = { added: [], updated: [], unchanged: [], skipped: [] };
    const byShard = new Map();

    for (const item of items) {
      const id = String(item.id ?? '').trim();
      if (!id) { report.skipped.push({ reason: 'no-id', name: item.name ?? null }); continue; }
      const shard = this.shardOf(id);
      if (!byShard.has(shard)) byShard.set(shard, this.loadShard(shard));
      const bucket = byShard.get(shard);
      const prev = bucket[id];

      const hash = contentHash(item);

      if (!prev) {
        bucket[id] = { ...item, active: true, hash, firstSeenAt: now, updatedAt: now, lastSyncId: syncId ?? null };
        report.added.push(id);
      } else if (prev.hash === hash && prev.active !== false) {
        bucket[id] = { ...prev, lastSeenAt: now, lastSyncId: syncId ?? null };
        report.unchanged.push(id);
      } else {
        bucket[id] = {
          ...prev, ...item,
          /* Возврат товара в выгрузку снимает скрытие: он снова продаётся. */
          active: true, hash, updatedAt: now, lastSeenAt: now, lastSyncId: syncId ?? null,
          firstSeenAt: prev.firstSeenAt ?? now,
        };
        report.updated.push(id);
      }
      bucket[id].lastSeenAt = now;
    }

    for (const [shard, bucket] of byShard) {
      writeAtomic(this.#shardFile(shard), JSON.stringify(bucket, null, 0));
    }
    return report;
  }

  /*
    Точечное дополнение карточки данными смежных операций: совместимость,
    атрибуты, связанные товары, уточнённая категория.

    Эти данные приходят не в ItemDto, а из отдельных операций, поэтому в
    хэш карточки они не входят: хэш отвечает за «изменилось ли у
    поставщика», и обогащение не должно превращать идемпотентный повтор
    выгрузки в «изменился весь каталог». Возвращает false, если товара нет
    в сторе, — так видно расхождение между операциями, а не создаётся
    пустая карточка.
  */
  patchItem(id, patch, { now = new Date().toISOString() } = {}) {
    const key = String(id ?? '').trim();
    if (!key) return false;
    const shard = this.shardOf(key);
    const file = this.#shardFile(shard);
    const bucket = this.loadShard(shard);
    if (!bucket[key]) return false;
    const next = { ...bucket[key], ...patch };
    /* Хэш пересчитывается по тем же правилам, что и при upsert, и по тем
       же причинам не включает то, что дописало обогащение: иначе патч
       менял бы хэш, а следующая выгрузка объявляла бы товар изменившимся
       без единого изменения у поставщика. Факт обогащения виден по полям
       categorySource и enrichedAt, а не по хэшу. */
    next.hash = contentHash(next);
    next.enrichedAt = now;
    bucket[key] = next;
    writeAtomic(file, JSON.stringify(bucket, null, 0));
    return true;
  }

  /* Оперативные данные меняются часто и не должны трогать хэш карточки:
     иначе каждый ценовой синк выглядел бы как изменение товара. */
  upsertRuntime(rows, { now = new Date().toISOString() } = {}) {
    const report = { updated: [], unknown: [] };
    const byShard = new Map();
    for (const row of rows) {
      const id = String(row.id ?? '').trim();
      if (!id) continue;
      const shard = this.shardOf(id);
      if (!byShard.has(shard)) byShard.set(shard, this.loadShard(shard));
      const bucket = byShard.get(shard);
      if (!bucket[id]) { report.unknown.push(id); continue; }
      const { id: _skip, syncedAt, ...values } = row;
      bucket[id].runtime = { ...values, syncedAt: now };
      report.updated.push(id);
    }
    for (const [shard, bucket] of byShard) {
      writeAtomic(this.#shardFile(shard), JSON.stringify(bucket, null, 0));
    }
    return report;
  }

  /*
    Скрытие пропавших. Вызывается только после подтверждённо полной
    выгрузки: оборванный синк не имеет права прятать товары.
  */
  deactivateMissing(seenIds, { complete, now = new Date().toISOString(), syncId } = {}) {
    if (complete !== true) {
      return { skipped: true, reason: 'синхронизация не подтверждена как полная', hidden: [] };
    }
    const seen = seenIds instanceof Set ? seenIds : new Set(seenIds);
    const hidden = [];
    if (!fs.existsSync(this.itemsDir)) return { skipped: false, hidden };
    for (const file of fs.readdirSync(this.itemsDir).sort()) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.itemsDir, file);
      const bucket = readJson(full, {});
      let dirty = false;
      for (const [id, rec] of Object.entries(bucket)) {
        if (seen.has(id) || rec.active === false) continue;
        bucket[id] = { ...rec, active: false, hiddenAt: now, hiddenBySyncId: syncId ?? null };
        hidden.push(id);
        dirty = true;
      }
      if (dirty) writeAtomic(full, JSON.stringify(bucket, null, 0));
    }
    return { skipped: false, hidden };
  }

  saveReport(name, data) {
    const file = path.join(this.reportsDir, `${name}.json`);
    writeAtomic(file, JSON.stringify(data, null, 2));
    return path.relative(this.root, file);
  }
}

/*
  Межпроцессная блокировка. Референсный клиент использовал msvcrt и работал
  только на Windows; здесь берётся приём, переносимый на любую ОС:
  эксклюзивное создание файла (wx) плюс запись pid и времени.

  Протухшая блокировка от убитого процесса не должна блокировать работу
  навсегда, поэтому она перехватывается по возрасту, а не по живости pid:
  pid переиспользуются, и проверка по нему врёт.
*/
export class RunLock {
  constructor(file, { staleMs = 6 * 60 * 60 * 1000 } = {}) {
    this.file = path.resolve(file);
    this.staleMs = staleMs;
    this.acquired = false;
  }

  acquire({ now = Date.now() } = {}) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      fs.writeFileSync(this.file, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }), { flag: 'wx' });
      this.acquired = true;
      return this;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const prev = readJson(this.file, null);
      const age = prev?.startedAt ? now - Date.parse(prev.startedAt) : Infinity;
      if (!(age > this.staleMs)) {
        throw new Error(`Синхронизация VTT уже выполняется (pid ${prev?.pid ?? '?'}, начата ${prev?.startedAt ?? '?'})`);
      }
      fs.writeFileSync(this.file, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString(), tookOverFrom: prev?.pid ?? null }));
      this.acquired = true;
      return this;
    }
  }

  release() {
    if (!this.acquired) return;
    try { fs.unlinkSync(this.file); } catch { /* уже удалён — это не ошибка */ }
    this.acquired = false;
  }
}
