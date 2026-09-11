/*
  SOAP 1.1 поверх fetch: конверт, вызов, разбор ответа.

  Почему не zeep и не генерация из WSDL. Рабочий клиент, присланный как
  референс, написан на Python и строит вызовы из WSDL. Здесь он не нужен:
  в репозитории один инструментарий — Node, и тянуть второй ради двух
  операций дороже, чем описать их напрямую. Обе операции принимают четыре
  простых значения (login, password, from, to) и возвращают один и тот же
  порционный DTO, так что конверт собирается однозначно, а разбор ответа
  проверяется фикстурами в tests/.

  Безопасность разбора. Ответ приходит по сети и может быть чем угодно,
  поэтому у парсера выключена подстановка сущностей — иначе XXE и «бомба
  сущностей» становятся реальными. Внешние DTD не подгружаются: парсер их
  просто не умеет, и это здесь достоинство.
*/
import { XMLParser } from 'fast-xml-parser';

const NS_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';

/* Значения приходят из конфигурации и от VTT, поэтому экранируются всегда. */
export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildEnvelope(operation, namespace, args) {
  const body = Object.entries(args)
    .map(([k, v]) => `<tem:${k}>${v === null || v === undefined ? '' : xmlEscape(v)}</tem:${k}>`)
    .join('');
  return '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap:Envelope xmlns:soap="${NS_ENV}" xmlns:tem="${namespace}">` +
    '<soap:Body>' + `<tem:${operation}>` + body + `</tem:${operation}>` + '</soap:Body>' +
    '</soap:Envelope>';
}

const parser = new XMLParser({
  ignoreAttributes: true,
  /* Префиксы неймспейсов из ответа убираем: контракт один, а вот префиксы
     сервер вправе менять от версии к версии, и завязываться на них нельзя. */
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  /* Список из одного элемента должен остаться списком: иначе каталог из
     одного товара разобрался бы как объект и тихо потерял бы строку. */
  isArray: (name, jpath) => /\.(ItemDto|ItemRuntimeDto|string|CategoryDto)$/.test(jpath),
});

export class SoapFault extends Error {
  constructor(faultCode, faultString) {
    super(faultString || faultCode || 'SOAP Fault');
    this.name = 'SoapFault';
    this.faultCode = faultCode || '';
    this.faultString = faultString || '';
  }
}

/* Ответ разворачивается до тела операции: всё, что выше, — транспорт. */
export function parseEnvelope(xml) {
  const doc = parser.parse(xml);
  const env = doc.Envelope;
  if (!env) throw new Error('Ответ не является SOAP-конвертом');
  const body = env.Body;
  if (!body) throw new Error('В SOAP-конверте нет Body');
  if (body.Fault) {
    const f = body.Fault;
    throw new SoapFault(
      typeof f.faultcode === 'string' ? f.faultcode : '',
      typeof f.faultstring === 'string' ? f.faultstring : (typeof f.Reason?.Text === 'string' ? f.Reason.Text : ''),
    );
  }
  return body;
}

/* Ошибки транспорта отделены от ошибок контракта: по первым имеет смысл
   повторить попытку, по вторым — нет. */
export class TransportError extends Error {
  constructor(message, cause) { super(message); this.name = 'TransportError'; this.cause = cause; }
}
export class TimeoutError extends TransportError {
  constructor(message) { super(message); this.name = 'TimeoutError'; }
}

export async function callSoap({ url, operation, namespace, soapAction, args, timeoutMs = 60000, fetchImpl = fetch }) {
  const envelope = buildEnvelope(operation, namespace, args);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapAction ?? `${namespace}IPortalService/${operation}`,
      },
      body: envelope,
      signal: ac.signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new TimeoutError(`Превышено время ожидания ответа VTT (${timeoutMs} мс)`);
    }
    throw new TransportError('Не удалось соединиться с сервисом VTT', e);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  /* 500 у SOAP 1.1 — штатный способ вернуть Fault, поэтому тело читаем
     и в этом случае: там лежит причина, понятная человеку. */
  if (!res.ok && res.status !== 500) {
    throw new TransportError(`VTT ответил HTTP ${res.status}`);
  }
  return parseEnvelope(text);
}
