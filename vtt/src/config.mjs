/*
  Конфигурация и секреты.

  Жёсткое разделение: несекретные настройки лежат в файле и коммитятся,
  учётные данные приходят только из переменных окружения и в репозиторий
  не попадают никогда. Поэтому в конфиге нет и не может быть поля
  `password` — его некуда записать даже по ошибке.

  Учётных данных в приложении нет и быть не должно: витрина статическая,
  синхронизация выполняется отдельной командой на машине оператора или в
  CI, и её секреты в собранный сайт не попадают.
*/
import fs from 'node:fs';
import path from 'node:path';

export const ENV_LOGIN = 'VTT_LOGIN';
export const ENV_PASSWORD = 'VTT_PASSWORD';
export const ENV_URL = 'VTT_SERVICE_URL';

/* Официальный адрес опубликован по HTTP и на нестандартном порту. Это
   осознанный риск, а не опечатка: по такому каналу логин и пароль идут
   открытым текстом. Поэтому предупреждение выводится всегда, а не
   прячется в документацию. */
export const DEFAULT_SERVICE_URL = 'http://api.vtt.ru:8048/Portal.svc';
export const DEFAULT_WSDL_URL = 'http://api.vtt.ru:8048/Portal.svc?singleWsdl';

/*
  Пространства имён взяты из официального WSDL (HTTP 200, 47 119 байт),
  полученного с машины пользователя. Раньше здесь стоял tempuri.org —
  типовое значение для WCF, и это было предположение, а не факт. Теперь
  предположения нет: сервис объявляет свой собственный namespace, и с
  tempuri он бы просто не ответил.

  SOAPAction собирается по образцу из WSDL —
  http://portal.vtt.ru/IPortalService/<Метод> — и вынесен отдельно от
  namespace: в WCF это разные строки, и склеивать их было бы ошибкой.
*/
export const DEFAULT_NAMESPACE = 'http://portal.vtt.ru';
export const DATA_NAMESPACE = 'http://portal.vtt.ru/data';
export const DEFAULT_SOAP_ACTION_BASE = 'http://portal.vtt.ru/IPortalService';

export const DEFAULTS = {
  serviceUrl: DEFAULT_SERVICE_URL,
  namespace: DEFAULT_NAMESPACE,
  soapActionBase: DEFAULT_SOAP_ACTION_BASE,
  portionSize: 500,
  timeoutMs: 60000,
  retryAttempts: 4,
  retryBaseDelayMs: 1000,
  imageConcurrency: 4,
  imageTimeoutMs: 30000,
  /* Фильтр по бренду и категории сужает то, что попадёт на витрину, но не
     то, что выгружается: полный набор всегда сохраняется в стор целиком,
     иначе фильтр незаметно обрезал бы историю. */
  /*
    Фильтр публикации. `brands` — марки из поля Brand выгрузки, то есть
    кто товар произвёл. `brandFallback` спасает позиции, у которых Brand
    не заполнен, но марка стоит в названии; он нужен отдельным блоком,
    потому что применяется только к перечисленным в нём слабым значениям
    Brand и только к перечисленным маркам.
  */
  publishFilter: { brands: [], categories: [], excludeBrands: [], brandFallback: null },
};

export function loadConfig(file) {
  let fromFile = {};
  if (file && fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Не разобрал конфигурацию ${path.basename(file)}: ${e.message}`);
    }
    if (fromFile.password !== undefined || fromFile.login !== undefined) {
      throw new Error(
        'В конфигурации найдены учётные данные. Логин и пароль задаются только ' +
        `переменными окружения ${ENV_LOGIN} и ${ENV_PASSWORD} и не хранятся в файлах.`,
      );
    }
  }
  const cfg = {
    ...DEFAULTS,
    ...fromFile,
    publishFilter: { ...DEFAULTS.publishFilter, ...(fromFile.publishFilter ?? {}) },
  };
  if (process.env[ENV_URL]) cfg.serviceUrl = process.env[ENV_URL];
  if (!/^https?:\/\/.+/.test(cfg.serviceUrl)) throw new Error('Некорректный serviceUrl');
  if (!Number.isInteger(cfg.portionSize) || cfg.portionSize <= 0) throw new Error('portionSize должен быть целым > 0');
  return cfg;
}

export function loadCredentials(env = process.env) {
  const login = env[ENV_LOGIN];
  const password = env[ENV_PASSWORD];
  if (!login || !password) {
    const err = new Error(
      `Нет учётных данных VTT. Задайте ${ENV_LOGIN} и ${ENV_PASSWORD} в окружении. ` +
      'В файлы конфигурации и в репозиторий они не записываются.',
    );
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  return { login, password };
}

/* Единственная функция, через которую что-либо попадает в лог и отчёт.
   Пароль вырезается по значению, а не по имени поля: он мог попасть в
   середину SOAP-ответа, в текст ошибки или в URL. */
export function makeRedactor(credentials) {
  const secrets = [credentials?.password, credentials?.login].filter((s) => typeof s === 'string' && s.length >= 3);
  return function redact(value) {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return text;
    for (const secret of secrets) text = text.split(secret).join('***');
    /* На случай, если секрет собран иначе: чистим типовые пары ключ-значение. */
    return text
      .replace(/(<(?:\w+:)?(?:password|login)>)[^<]*(<\/)/gi, '$1***$2')
      .replace(/("?(?:password|login|pwd|pass)"?\s*[:=]\s*")[^"]*(")/gi, '$1***$2');
  };
}

export function httpRisk(url) {
  return /^http:\/\//i.test(url)
    ? {
        risk: true,
        message:
          'Сервис VTT указан по http:// — логин и пароль пойдут по сети открытым текстом. ' +
          'Перед запуском в облаке подтвердите у VTT наличие https-endpoint либо выполняйте ' +
          'синхронизацию из доверенной сети.',
      }
    : { risk: false, message: '' };
}
