/*
  Клиент двух подтверждённых операций VTT и порционная загрузка каталога.

  Семантика порций у VTT нестандартная и подтверждена рабочим клиентом,
  присланным как референс, вместе с его тестами: первый запрос идёт как
  0..N и возвращает N строк, следующий начинается с N+1, потому что при
  ненулевом `from` включены обе границы. Диапазоны получаются
  0..500, 501..1000, 1001..1500 — без перекрытия и без пропусков.
  Признак конца — короткая порция, а не TotalCount: он у VTT ведёт себя
  как индекс последней отданной строки, а не как размер каталога.

  Ошибки классифицируются, потому что повторять попытку осмысленно только
  для сетевых сбоев. Отклонённый логин или сломанный контракт повторять
  бесполезно — это сразу к человеку.
*/
import { callSoap, SoapFault, TransportError, TimeoutError } from './soap.mjs';
import { DEFAULT_NAMESPACE, DEFAULT_SOAP_ACTION_BASE } from './config.mjs';

export { DEFAULT_NAMESPACE };

export class VttAuthError extends Error {
  constructor(message, detail) { super(message); this.name = 'VttAuthError'; this.detail = detail || ''; }
}
export class VttContractError extends Error {
  constructor(message, detail) { super(message); this.name = 'VttContractError'; this.detail = detail || ''; }
}
export { TransportError, TimeoutError };

const AUTH_MARKERS = [
  'authentication', 'authorization', 'unauthorized', 'login', 'password',
  'авториза', 'аутентифика', 'логин', 'парол', 'доступ запрещ',
];
export function looksLikeAuthFault(text) {
  const s = String(text || '').toLowerCase();
  return AUTH_MARKERS.some((m) => s.includes(m));
}

/* Порционный DTO у обеих операций одинаков по форме, отличается только имя
   элемента строки. Разбор общий, чтобы поведение не разъехалось. */
export function parsePortion(bodyNode, resultKey, itemElement) {
  const result = bodyNode?.[resultKey] ?? bodyNode;
  if (result === undefined || result === null) {
    throw new VttContractError('В ответе VTT нет тела результата', resultKey);
  }
  if (!('TotalCount' in result)) {
    throw new VttContractError('В ответе VTT отсутствует TotalCount', resultKey);
  }
  const totalCount = Number(result.TotalCount);
  if (!Number.isFinite(totalCount) || totalCount < 0) {
    throw new VttContractError('VTT вернул некорректный TotalCount', String(result.TotalCount));
  }
  let itemsNode = result.Items;
  if (itemsNode && typeof itemsNode === 'object' && !Array.isArray(itemsNode) && itemElement in itemsNode) {
    itemsNode = itemsNode[itemElement];
  }
  let items;
  if (itemsNode === undefined || itemsNode === null || itemsNode === '') items = [];
  else if (Array.isArray(itemsNode)) items = itemsNode;
  else if (typeof itemsNode === 'object') items = [itemsNode];
  else throw new VttContractError('VTT вернул повреждённый список товаров', typeof itemsNode);
  for (const [i, it] of items.entries()) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      throw new VttContractError('VTT вернул повреждённую карточку товара', `Items[${i}]`);
    }
  }
  return { items, totalCount };
}

function classify(err) {
  if (err instanceof SoapFault) {
    const detail = err.faultString || err.faultCode;
    return looksLikeAuthFault(detail)
      ? new VttAuthError('VTT отклонил логин или пароль', detail)
      : new VttContractError('Сервис VTT вернул ошибку SOAP', detail);
  }
  return err;
}

export class VttClient {
  constructor({ url, namespace = DEFAULT_NAMESPACE, soapActionBase = DEFAULT_SOAP_ACTION_BASE, timeoutMs = 60000, fetchImpl } = {}) {
    if (!url) throw new Error('Не задан адрес сервиса VTT');
    this.url = url;
    this.namespace = namespace;
    this.soapActionBase = soapActionBase;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /* Учётные данные приходят аргументом и нигде не сохраняются: ни в полях
     клиента, ни в логах — иначе они рано или поздно утекут в отчёт. */
  async #portion(operation, resultKey, itemElement, credentials, from, to) {
    if (!credentials?.login || !credentials?.password) {
      throw new VttAuthError('Не заданы учётные данные VTT');
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      throw new RangeError(`Некорректный диапазон порции: ${from}..${to}`);
    }
    try {
      const body = await callSoap({
        url: this.url,
        operation,
        namespace: this.namespace,
        soapActionBase: this.soapActionBase,
        args: { login: credentials.login, password: credentials.password, from, to },
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      return parsePortion(body[`${operation}Response`] ?? body, resultKey, itemElement);
    } catch (e) {
      throw classify(e);
    }
  }

  getItemPortion(credentials, from, to) {
    return this.#portion('GetItemPortion', 'GetItemPortionResult', 'ItemDto', credentials, from, to);
  }

  getRuntimeItemsPortion(credentials, from, to) {
    return this.#portion('GetRuntimeItemsPortion', 'GetRuntimeItemsPortionResult', 'ItemRuntimeDto', credentials, from, to);
  }

  /*
    Списочные операции WSDL. Все двенадцать методов подтверждены официальным
    WSDL, поэтому «недоступно» здесь означает отказ по правам конкретной
    учётной записи, а не отсутствие метода. Такой отказ не роняет выгрузку:
    он уходит в отчёт, а каталог собирается из того, что доступно.
  */
  async #list(operation, resultKey, itemElement, credentials, extraArgs = {}) {
    if (!credentials?.login || !credentials?.password) {
      throw new VttAuthError('Не заданы учётные данные VTT');
    }
    try {
      const body = await callSoap({
        url: this.url,
        operation,
        namespace: this.namespace,
        soapActionBase: this.soapActionBase,
        args: { login: credentials.login, password: credentials.password, ...extraArgs },
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const node = body[`${operation}Response`] ?? body;
      const result = node?.[resultKey] ?? node;
      let listNode = result;
      if (result && typeof result === 'object' && itemElement in result) listNode = result[itemElement];
      const list = listNode === undefined || listNode === null || listNode === ''
        ? [] : Array.isArray(listNode) ? listNode : [listNode];
      return { supported: true, items: list.filter((x) => x && typeof x === 'object') };
    } catch (e) {
      const err = classify(e);
      if (err instanceof VttAuthError) throw err;
      return { supported: false, items: [], reason: err.detail || err.message };
    }
  }

  /* CategoryDto = Id, Name, ParentId — плоский список с родителями. */
  getCategories(credentials) {
    return this.#list('GetCategories', 'GetCategoriesResult', 'CategoryDto', credentials);
  }

  /*
    Членство товаров в официальной категории. Это надёжнее, чем текстовые
    Group/RootGroup: здесь связь задана идентификаторами, а не совпадением
    названий, которое ломается от любой правки у поставщика.
  */
  getCategoryItems(credentials, categoryId) {
    return this.#list('GetCategoryItems', 'GetCategoryItemsResult', 'ItemDto', credentials, { categoryId });
  }

  getCategoryRuntimeItems(credentials, categoryId) {
    return this.#list('GetCategoryRuntimeItems', 'GetCategoryRuntimeItemsResult', 'ItemRuntimeDto', credentials, { categoryId });
  }

  /* CompatibilityDto = ItemId, ModelBrand, ModelCategoryName, ModelName.
     Структурированная совместимость — бренд и модель приходят полями, а не
     одной строкой, которую пришлось бы резать разделителями. */
  getGoodsCompatibilityInformation(credentials, itemId) {
    return this.#list(
      'GetGoodsCompatibilityInformation', 'GetGoodsCompatibilityInformationResult', 'CompatibilityDto',
      credentials, itemId === undefined ? {} : { itemId },
    );
  }

  /* AdditionalAttributeDto = CategoryId, ItemId, IntValue, StringValue. */
  getAdditionalAttributes(credentials, itemId) {
    return this.#list(
      'GetAdditionalAttributes', 'GetAdditionalAttributesResult', 'AdditionalAttributeDto',
      credentials, itemId === undefined ? {} : { itemId },
    );
  }

  getRelatedItems(credentials, itemId) {
    return this.#list('GetRelatedItems', 'GetRelatedItemsResult', 'ItemDto', credentials, { itemId });
  }

  getItem(credentials, itemId) {
    return this.#list('GetItem', 'GetItemResult', 'ItemDto', credentials, { itemId });
  }

  getRuntimeItem(credentials, itemId) {
    return this.#list('GetRuntimeItem', 'GetRuntimeItemResult', 'ItemRuntimeDto', credentials, { itemId });
  }

  /* Непорционные варианты: на большом каталоге они тяжелее порционных,
     поэтому в полной выгрузке не используются, но контракт есть. */
  getItems(credentials) {
    return this.#list('GetItems', 'GetItemsResult', 'ItemDto', credentials);
  }

  getRuntimeItems(credentials) {
    return this.#list('GetRuntimeItems', 'GetRuntimeItemsResult', 'ItemRuntimeDto', credentials);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Повтор только для сетевых сбоев и только с растущей паузой: молотить
   чужой сервис в цикле нельзя, а разовый обрыв связи ронять выгрузку не
   должен. Контрактные ошибки и отказ авторизации пробрасываются сразу. */
export async function withRetry(fn, { attempts = 4, baseDelayMs = 1000, onRetry, sleepImpl = sleep } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retriable = e instanceof TransportError || e instanceof TimeoutError;
      if (!retriable || attempt === attempts) throw e;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.({ attempt, attempts, delay, error: e });
      await sleepImpl(delay);
    }
  }
  throw lastErr;
}

/*
  Порционная загрузка. `fetchPortion(from, to)` возвращает {items, totalCount} —
  это позволяет гонять цикл на фикстурах, не поднимая сеть.

  Дубликаты по Id отбрасываются: при сбое и повторе порции строка может
  прийти дважды, и в каталоге это превратилось бы в задвоенный товар.
  Строки без Id не выбрасываются — они попадают в отчёт, потому что молча
  терять товары поставщика хуже, чем показать проблему.
*/
export async function downloadAll(fetchPortion, {
  portionSize = 500,
  maxPortions = 100000,
  onProgress,
  startFrom = 0,
  seen = new Set(),
  collected = [],
} = {}) {
  if (!Number.isInteger(portionSize) || portionSize <= 0) {
    throw new RangeError('Размер порции должен быть целым и больше нуля');
  }
  const items = collected;
  const seenIds = seen;
  let duplicates = 0, withoutId = 0, rowsReceived = 0, portions = 0, lastTotal = 0;
  let from = startFrom;
  let to = startFrom === 0 ? portionSize : startFrom + portionSize - 1;

  for (;;) {
    if (portions >= maxPortions) {
      throw new VttContractError('Загрузка остановлена защитой от бесконечного цикла', `предел ${maxPortions} порций`);
    }
    const portion = await fetchPortion(from, to);
    portions += 1;
    const received = portion.items.length;
    if (received > portionSize) {
      throw new VttContractError('VTT вернул больше строк, чем запрошено', `${from}..${to}: ${received}`);
    }
    if (portion.totalCount) lastTotal = portion.totalCount;
    rowsReceived += received;

    for (const item of portion.items) {
      const id = item.Id === undefined || item.Id === null ? '' : String(item.Id).trim();
      if (!id) { withoutId += 1; items.push(item); continue; }
      if (seenIds.has(id)) { duplicates += 1; continue; }
      seenIds.add(id);
      items.push(item);
    }

    onProgress?.({ rowsReceived, unique: items.length, portions, duplicates, from, to });
    if (received < portionSize) break;
    from = to + 1;
    to = from + portionSize - 1;
  }

  return { items, totalReported: lastTotal || rowsReceived, rowsReceived, portions, duplicates, withoutId };
}
