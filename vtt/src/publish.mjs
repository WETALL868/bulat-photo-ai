/*
  Стор VTT → товары витрины.

  Здесь проходит граница между «что у поставщика» и «что на сайте».

  Фильтр публикации сужает витрину, но не стор. Полный набор всегда лежит
  в vtt-data целиком: фильтр решает, что показать, и его можно поменять
  без новой выгрузки. Обратное было бы ловушкой — сужение на этапе
  выгрузки незаметно обрезает историю.

  Скрытые товары на витрину не попадают. Товар, пропавший из выгрузки,
  помечен inactive и остаётся в сторе, но в каталоге его нет: продавать
  то, чего у поставщика больше нет, нельзя.

  Описание собирается только из фактов. Каждое предложение опирается на
  конкретное поле ItemDto, и если поля нет — предложения тоже нет.
  Ни характеристик, ни сертификатов, ни гарантий, ни «совместим также с»
  здесь не появляется: выдуманная строка в карточке дороже пустого места.
*/
import { slugify, REQUIRED_FOR_CARD, isDamagedPackage } from './normalize.mjs';
import { colorTitle, colorPhrase, colorWord } from './colors.mjs';

export const DESCRIPTION_VERSION = 5;

/* Тип расходника выводится из категории и названия — но только если он там
   действительно назван. Ничего не додумывается по «похожести». */
/*
  Порядок важен: сначала точные названия деталей, потом общие. «Поглотитель
  чернил» обязан опознаться поглотителем, а не чернилами, а «ремкомплект» —
  ремкомплектом, а не роликом из своего состава.

  Правила написаны под то, как вещь названа в выгрузке, и дают
  единственное число: раздел поставщика называется «Ракели», а в карточке
  должно стоять «ракель». Без этих правил в текст попадало «Блоки лазера,
  сканера, Сканирующие линейки Hi-Black 0609001409» — название раздела
  вместо названия вещи.
*/
const TYPE_RULES = [
  [/поглотител\p{L}*\s+чернил|абсорбер|памперс/iu, 'Поглотитель чернил'],
  [/ремкомплект|maintenance\s*kit|комплект\p{L}*\s+обслуживания/iu, 'Ремкомплект'],
  [/заправочн\p{L}*\s+комплект/iu, 'Заправочный комплект'],
  [/дозирующ\p{L}*\s+лезви|doctor\s*blade/iu, 'Дозирующее лезвие'],
  [/ракел/iu, 'Ракель'],
  [/магнитн\p{L}*\s+вал/iu, 'Магнитный вал'],
  [/(?:вал\s+резинов|резинов\p{L}*\s+вал)/iu, 'Резиновый вал'],
  [/(?:вал\s+тефлонов|тефлонов\p{L}*\s+вал)/iu, 'Тефлоновый вал'],
  [/сканирующ\p{L}*\s+линейк/iu, 'Сканирующая линейка'],
  [/блок\p{L}*\s+проявки/iu, 'Блок проявки'],
  [/узел\s+закреплени|термоузел|термоблок|печк\p{L}*\s+в\s+сборе|fuser/iu, 'Узел закрепления'],
  [/тормозн\p{L}*\s+площадк/iu, 'Тормозная площадка'],
  [/девелопер|стартер/iu, 'Девелопер'],
  [/пл[её]нк\p{L}*\s+для\s+ламинировани/iu, 'Плёнка для ламинирования'],
  [/лент\p{L}*\s+переноса|комплект\p{L}*\s+переноса/iu, 'Лента переноса'],
  [/рем(?:ень|ни)|лент\p{L}*\s+позиционировани/iu, 'Ремень'],
  [/сепаратор|пал\p{L}*\s+отделени/iu, 'Сепаратор'],
  [/шестерн/iu, 'Шестерня'],
  [/подшипник/iu, 'Подшипник'],
  [/втулк|бушинг/iu, 'Втулка'],
  [/шарнир/iu, 'Шарнир'],
  [/кронштейн/iu, 'Кронштейн'],
  [/держател/iu, 'Держатель'],
  [/шлейф/iu, 'Шлейф'],
  [/редуктор|привод|узел\s+привода/iu, 'Редуктор'],
  [/плат[аы]\s|плата\s+форматировани|контроллер/iu, 'Плата'],
  [/смазк|тальк/iu, 'Смазка'],
  [/салфетк/iu, 'Салфетка'],
  [/масло/iu, 'Масло'],
  [/очистител|средств\p{L}*\s+для\s+очистки/iu, 'Очиститель'],
  [/шнек|шпиндел/iu, 'Шнек'],
  [/лоток|кассет/iu, 'Лоток'],
  [/пакет/iu, 'Пакет'],
  [/чип(?![\p{L}])/iu, 'Чип'],
  [/тонер-?картридж|тонер\s*картридж/i, 'Тонер-картридж'],
  [/картридж/i, 'Картридж'],
  [/тонер/i, 'Тонер'],
  [/чернил/i, 'Чернила'],
  [/фотобараб|драм|drum|барабан/i, 'Фотобарабан'],
  [/термоплён|термоплен|термопленк/i, 'Термоплёнка'],
  [/ролик/i, 'Ролик'],
  [/бумаг/i, 'Бумага'],
];
export function typeOf(item) {
  /* Сначала название: там вещь названа так, как её называют. Раздел
     поставщика — запасной источник и почти всегда во множественном
     числе, поэтому идёт вторым. */
  for (const [re, label] of TYPE_RULES) if (re.test(String(item.name ?? ''))) return label;
  for (const [re, label] of TYPE_RULES) if (re.test(String(item.category ?? ''))) return label;
  return item.category ?? null;
}

const fmt = (n) => Number(n).toLocaleString('ru-RU');
/* Русское склонение после числительного: «в 4 цветах», «20 листов». */
const plural = (n, one, few, many) => {
  const m = Math.abs(n) % 100, m1 = m % 10;
  if (m > 10 && m < 20) return many;
  if (m1 > 1 && m1 < 5) return few;
  if (m1 === 1) return one;
  return many;
};

/*
  Список совместимых моделей. Берётся ТОЛЬКО из структурного источника —
  GetGoodsCompatibilityInformation, где бренд и модель приходят
  отдельными полями.

  Свободный текст Compatibility сюда не попадает, и это решение по фактам
  реальной выгрузки: в одном и том же поле у VTT лежат и списки моделей
  («LJ 3052/3055/3390/3392 CLJ M375/M475»), и состояние товара
  («Повреждённая упаковка»), и примечания («с чипом», «Позиция снята с
  производства»). Разрезание по разделителям дало бы карточке чипы
  «Повреждённая упаковка» и «3055» — то есть выдуманную совместимость.
  Текст показывается как есть, отдельным полем, за подписью поставщика.
*/
export function modelsOf(item) {
  return item.compatibilityLabels ?? item.compatibility ?? [];
}

/*
  Совместимость из названия.

  Название у VTT построено единообразно: «<тип> <марка> (<артикул>) для
  <техника>, <цвет>, <ресурс>». Часть после «для» — это слова самого
  поставщика о том, к чему товар подходит, и единственный источник таких
  сведений у 6 681 позиции: структурная совместимость по этому каталогу
  не приходит вовсе.

  Разбор намеренно трусливый. Мы отрезаем только хвост из цвета, ресурса
  и служебных пометок — то, что стоит последними запятыми и распознаётся
  списком. Ничего не переставляем, ничего не дополняем и не режем на
  отдельные модели: «M8124cidn/M8130cidn» остаётся одной фразой, потому
  что делить её на элементы — уже додумывание. Если после отрезания
  хвоста ничего осмысленного не осталось, функция возвращает пустую
  строку и в описании этого предложения просто нет.
*/
const FOR_RE = /(^|[^\p{L}\p{N}])для\s+/iu;
const RES_TOKEN = /(^|[^0-9\p{L}])\d+(?:[.,]\d+)?\s*[kк](?![0-9\p{L}])/giu;
const TAIL_TOKENS = /^(?:[a-zа-яё]{1,4}|\d+(?:[.,]\d+)?\s*[kк](?:\s*\/\s*\d+(?:[.,]\d+)?\s*[kк])*|\d+(?:[.,]\d+)?\s*(?:мл|л|г|кг|шт)\.?|с\s+чипом|без\s+чипа|б\/ч|\d+(?:[.,]\d+)?)$/iu;

/* Слова цвета в хвосте названия: «Tricolor», «Black», «Пурпурный». */
const TAIL_COLOR = /^(?:tri-?color|black|cyan|magenta|yellow|photo\s*\w*|light\s*\w*|bk|c|m|y|lc|lm|pbk|mbk|gy|col(?:or|our)?|\d\s*-?\s*col|ч[её]рн\p{L}*|голуб\p{L}*|пурпурн\p{L}*|ж[её]лт\p{L}*|цветн\p{L}*|сер\p{L}*)$/iu;

/*
  Похоже ли на перечень моделей.

  После «для» в названии стоит не только техника. «Средство Hi-Black для
  очистки оргтехники», «Холст для струйной печати, односторонний, A4, 260
  г/м2», «Чип … (для всех регионов/ без гарантии)» — здесь после «для»
  идёт назначение или оговорка, а не модели. Без этой проверки карточка
  чистящего средства получала совет «сверьте обозначение модели на корпусе
  аппарата с этим перечнем», где перечнем была «очистка оргтехники».

  Признак модели — цифры в обозначении либо имя марки техники. Назначение
  отсекается по началу фразы: список закрытый и короткий.
*/
const PURPOSE_START = /^(?:очистк|чистк|заправк|промывк|удалени|восстановлени|снятия|(?:струйной|лазерной|матричной|широкоформатной|сублимационной|термо)\s+печати|печати\b|всех\b|любых\b)/iu;
const PRINTER_BRAND = /^(?:hp|canon|epson|kyocera|brother|samsung|xerox|ricoh|oki|lexmark|panasonic|sharp|toshiba|konica|pantum|deli|minolta|kyocera-mita)\b/i;

export function looksLikeModels(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (PURPOSE_START.test(t)) return false;
  return /\d/.test(t) || PRINTER_BRAND.test(t);
}

/*
  Поле Compatibility у химии и расходки для сервиса заполнено не
  перечнем аппаратов, а инструкцией: «Очищает и восстанавливает
  поверхности PCR roller лазерных картриджей. Применение: нанести
  раствор на чистую салфетку, протереть…». Подписывать такой текст
  «По данным поставщика подходит к аппаратам» — прямая неправда: ни
  одного аппарата там не названо.

  Признак инструкции — глаголы действия и слово «Применение». Признак
  перечня — плотность обозначений с цифрами либо марка техники. Списки
  закрытые: лучше показать текст под нейтральной подписью, чем выдать
  инструкцию за совместимость.
*/
const INSTRUCTION_RE = /(?:^|[^\p{L}])(?:применение|нанести|протереть|встряхн|распыл|очищает|очистить|уменьшает|восстанавливает|удаляет|не\s+допуск|рекомендуется|используйте|смочит)/iu;

export function looksLikeCompatList(text) {
  const t = String(text ?? '').trim();
  if (!looksLikeModels(t)) return false;
  if (INSTRUCTION_RE.test(t)) return false;
  const tokens = t.split(/[\s,;]+/u).filter((w) => w.length > 1);
  if (!tokens.length) return false;
  /* В перечне моделей обозначения с цифрами — не редкость, а основа. */
  const coded = tokens.filter((w) => /\d/.test(w)).length;
  return coded / tokens.length >= 0.15 || PRINTER_BRAND.test(t);
}

export function modelsFromName(name, code) {
  const text = String(name ?? '');
  const m = FOR_RE.exec(text);
  if (!m) return '';
  let rest = text.slice(m.index + m[0].length).trim();
  rest = rest.replace(/\([^)]*\)\s*$/u, '').trim();
  const parts = rest.split(',').map((s) => s.trim()).filter(Boolean);
  /* Хвост названия — это цвет, ресурс, объём и повтор артикула, а не
     модели. «для HP DJ 2130, №123XL, Tricolor» — подходит он к HP DJ
     2130, остальное сказано в других полях карточки. */
  const shape = (v) => String(v || '').toUpperCase().replace(/[^0-9A-ZА-Я]/g, '');
  const codeShape = shape(code);
  const isTail = (v) => TAIL_TOKENS.test(v) || TAIL_COLOR.test(v)
    || (codeShape && shape(v) && (shape(v) === codeShape || codeShape.includes(shape(v))));
  while (parts.length > 1 && isTail(parts[parts.length - 1])) parts.pop();
  const out = parts.join(', ').replace(/[\s.,;-]+$/u, '').trim();
  if (out.length < 3 || out.length > 140) return '';
  return looksLikeModels(out) ? out : '';
}

/*
  Примечания поставщика.

  В поле Compatibility у VTT лежит всё сразу: и список моделей на триста
  знаков, и короткая пометка вроде «с чипом», и то и другое через
  запятую. Раньше эта строка выводилась в карточку как есть, под подписью
  «Примечание поставщика» — покупатель читал служебную телеграмму.

  Разбираем её на две части. Известные короткие пометки переводим в
  нормальную фразу по закрытой таблице: это перевод того, что написано, а
  не догадка. Всё остальное считается перечнем совместимости и остаётся
  дословным — резать чужой список моделей на части нельзя.
*/
const NOTE_PHRASES = [
  [/^с\s*чипом$/i, 'Поставляется с чипом.'],
  [/^без\s*чипа$/i, 'Чип в комплект не входит.'],
  [/^восстановленн\p{L}*$/iu, 'Восстановленный: поставщик отмечает, что изделие прошло восстановление.'],
  [/^без\s+бункера\s+(?:отработки\s+тонера|для\s+отработанного\s+тонера)$/i,
    'Бункер для отработанного тонера в комплект не входит.'],
  [/^прошивку\s+не\s+обновлять$/i, 'Поставщик предупреждает: прошивку аппарата обновлять не следует.'],
  [/^без\s+батарейки$/i, 'Батарейка в комплект не входит.'],
  [/^техническая\s+коробка$/i, 'Поставляется в технической упаковке.'],
  [/^на\s+водной\s+основе$/i, 'Чернила на водной основе.'],
  [/^dye\s+inks?$/i, 'Водорастворимые чернила (dye).'],
  [/^pigment$/i, 'Пигментные чернила.'],
  [/^рекомендуется\s+использовать\s+чернила\s+на\s+водной\s+основе$/i,
    'Поставщик рекомендует использовать чернила на водной основе.'],
];

/* Похоже ли на перечень моделей: марка техники, косые черты, цифры. */
const LOOKS_LIKE_MODELS = /[/]|\b(hp|canon|epson|kyocera|brother|samsung|xerox|ricoh|oki|lexmark|panasonic|sharp|toshiba|konica|pantum|lj|clj|mfp|dj)\b/i;

export function parseSupplierNote(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { notes: [], compat: '', unknown: [] };
  const notes = [];
  const unknown = [];
  const rest = [];
  /* Запятая внутри скобок не разделитель: «(памперс, абсорбер)» — это
     одно название, и разрезанное пополам оно превращается в обрывок. */
  const parts = [];
  let depth = 0, buf = '';
  for (const ch of raw) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  for (const part of parts.map((s) => s.trim()).filter(Boolean)) {
    const hit = NOTE_PHRASES.find(([re]) => re.test(part));
    if (hit) { notes.push(hit[1]); continue; }
    /* Короткий кусок без признаков модели — пометка, которой нет в
       таблице. Показываем дословно и в кавычках: своими словами
       пересказывать чужую оговорку нельзя. */
    /* Короткий кусок без признаков модели и без артикулов — пометка,
       которой нет в таблице. Всё, что длиннее или содержит коды, —
       перечень совместимости: пересказывать его нельзя. */
    if (part.length <= 40 && !LOOKS_LIKE_MODELS.test(part) && !/\d{3,}/.test(part)) { unknown.push(part); continue; }
    rest.push(part);
  }
  return { notes, compat: rest.join(', '), unknown };
}

/*
  Как вещь называется.

  Собирать первое предложение из типа, марки и артикула оказалось мало.
  У VTT один и тот же артикул встречается у разных вещей: A00J563600 — это
  и «Ролик захвата бумаги», и «Насадка (резинка) на ролик захвата бумаги»,
  а HB-CH-Deli-T2A — чип одноразовый и чип многоразовый. Разница написана
  в названии, и если её выбросить, две карточки получают одинаковый текст.

  Поэтому подлежащее берётся из самого названия: часть до «для», без
  марки, без артикула в скобках и без хвоста из цвета и ресурса. Всё, что
  отличает вещь от соседней, в этой части и написано.

  Артикул в скобках убирается только при точном совпадении с кодом
  позиции. «(T2A)» у чипа — это модель картриджа Deli, а не повтор
  артикула HB-CH-Deli-T2A, и терять её нельзя.
*/
const shapeOf = (v) => String(v || '').toUpperCase().replace(/[^0-9A-ZА-Я]/g, '');

export function productSubject(item, code) {
  const text = String(item?.name ?? '');
  const m = FOR_RE.exec(text);
  /* Отрезаем хвост только тогда, когда после «для» действительно модели.
     У бумаги там формат и плотность («для струйной печати, односторонний,
     A4, 260 г/м2»), и без этой оговорки от названия оставалось одно
     слово «Холст». */
  const tail = m ? text.slice(m.index + m[0].length).trim() : '';
  let head = (m && looksLikeModels(tail.replace(/\([^)]*\)\s*$/u, '').trim()) ? text.slice(0, m.index) : text).trim();

  const codeShape = shapeOf(code);
  head = head.replace(/\(([^)]*)\)/g, (whole, inner) => {
    const inside = shapeOf(inner);
    if (!codeShape || !inside) return whole;
    return inside === codeShape || codeShape.replace(/^HB/, '') === inside ? ' ' : whole;
  });
  if (code) head = head.split(code).join(' ');
  /* Марка убирается вместе с названием линейки, если оно идёт сразу за
     ней: у «Hi-Image Paper» вычеркнутое «Hi-Image» оставляло сиротское
     «Paper» посреди фразы. */
  if (item?.brand) {
    for (const phrase of [`${item.brand} Paper`, item.brand]) {
      if (head.includes(phrase)) { head = head.split(phrase).join(' '); break; }
    }
  }

  /* Хвост по запятым: цвет и ресурс уже сказаны отдельными полями, а вот
     «многоразовый» рядом с «2K» — то самое отличие, ради которого всё и
     затевалось. Поэтому часть не выбрасывается целиком: из неё вынимаются
     цвет и ресурс, а остаток сохраняется. */
  /*
    Хвост по запятым разбирается целыми кусками, а не правкой внутри них.
    Раньше из части вырезались цифры с единицей — и «260 г/м2» у бумаги
    превращалось в «/м2». Теперь часть либо выбрасывается целиком (если в
    ней нет ничего, кроме цвета, ресурса или количества), либо остаётся
    как есть: «многоразовый» рядом с «2K» — то самое отличие, ради
    которого всё и затевалось.
  */
  const ONLY_MEASURE = /^\d+(?:[.,]\d+)?\s*(?:мл|л|г|кг|шт|листов|л)\.?$/iu;
  const ONLY_RESOURCE = /^\d+(?:[.,]\d+)?\s*[kк](?:\s*\/\s*\d+(?:[.,]\d+)?\s*[kк])*$/iu;
  const parts = head.split(',').map((x) => x.trim()).filter(Boolean);
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].replace(/\s{2,}/g, ' ').trim().replace(/^[-–—\s.]+|[-–—\s.]+$/g, '');
    if (!part) continue;
    if (i > 0 && (TAIL_COLOR.test(part) || ONLY_MEASURE.test(part) || ONLY_RESOURCE.test(part))) continue;
    /* Ресурс в начале части убирается — он уже сказан своим полем, — но
       только он: «2K многоразовый» превращается в «многоразовый», а
       «260 г/м2» у бумаги остаётся целым, потому что никакого K там нет. */
    const trimmed = i > 0
      ? part.replace(/^\d+(?:[.,]\d+)?\s*[kк](?:\s*\/\s*\d+(?:[.,]\d+)?\s*[kк])*\s+/iu, '').trim()
      : part;
    if (trimmed) kept.push(trimmed);
  }
  return kept.join(', ').replace(/\s{2,}/g, ' ').trim().replace(/[\s.,]+$/u, '');
}

/*
  Описание карточки.

  Пишется для покупателя, а не для выгрузки, и не ради длины.

  Предыдущая версия набирала пятьсот знаков процедурными советами:
  «сверьте обозначение модели на корпусе» стояло на 3 465 карточках,
  «штрихкод позиции» — на 4 025, «вес одной штуки по выгрузке» — на
  3 227. Замер близких дублей показал, что в среднем 72 % текста
  занимали фразы, которые покупатель уже читал на других карточках, а
  чёрный и пурпурный картриджи одной серии различались цветом, артикулом,
  ресурсом и штрихкодом — и больше ничем. Формально все тексты были
  уникальны; по сути это был один шаблон с подменёнными значениями.

  Поэтому здесь осталось только то, что про эту позицию:

    • что это за вещь и к чему подходит — из названия и совместимости;
    • состав серии, если позиция из цветного набора: сколько цветов, с
      каким ресурсом и какая из них эта;
    • ресурс или объём с одной оговоркой о том, от чего он зависит;
    • комплектация и пометки поставщика — чип, бункер, основа чернил;
    • количество в упаковке, названное правильным словом: у бумаги это
      листы, у деталей — штуки.

  Штрихкод, вес, габариты и раздел поставщика ушли в характеристики: в
  тексте они были переписыванием полей ради длины.

  Ни одного придуманного свойства. «Чёткий текст», «не осыпается», «ISO
  19752», проценты заполнения, сроки гарантии — этого в выгрузке нет,
  значит этого нет и в карточке.

  Следствие принято сознательно: у позиции с бедными данными текст
  останется коротким. Раздуть его можно только общими словами, а общие
  слова — это и есть та самая набивка.
*/
export const DESCRIPTION_MIN = 500;

/*
  Терминология по типу расходника. Ресурс в страницах есть не у всего: у
  чернил это объём, у ролика и ракеля — ничего. Оговорка о ресурсе
  пишется словами этого товара: у тонер-картриджа «тонер», а не «краска».
*/
const PAGE_YIELD_TYPES = new Set([
  'Тонер-картридж', 'Картридж', 'Тонер', 'Фотобарабан', 'Чип', 'Девелопер', 'Блок проявки', 'Термоплёнка',
]);
const SHEET_TYPES = new Set(['Бумага', 'Плёнка для ламинирования']);

export function buildDescription(item, { family = null } = {}) {
  const used = {};
  const type = typeOf(item);
  const code = item.vendorCode ?? '';
  const colorText = colorWord(item.color);
  const brand = item.brand ?? '';
  const note = parseSupplierNote(item.compatibilityText);

  const subject = productSubject(item, code) || (type ? String(type) : '');
  const comma = subject.indexOf(',');
  const subjectHead = comma > 0 ? subject.slice(0, comma).trim() : subject;
  const subjectTail = comma > 0 ? subject.slice(comma + 1).trim() : '';

  const models = modelsOf(item);
  const fromName = modelsFromName(item.name, code);
  let fits = '';
  if (models.length) { fits = models.slice(0, 12).join(', '); used.compatibility = 1; }
  else if (fromName) { fits = fromName; used.compatibilityFromName = 1; }

  const paragraphs = [];

  /* ---------------------------------------------------- что это такое */
  const head = [];
  if (subjectHead) {
    const lead = colorText && !TAIL_COLOR.test(subjectHead) && !subjectHead.toLowerCase().includes(colorText)
      ? `${colorText[0].toUpperCase()}${colorText.slice(1)} ${subjectHead[0].toLowerCase()}${subjectHead.slice(1)}`
      : `${subjectHead[0].toUpperCase()}${subjectHead.slice(1)}`;
    head.push(lead);
    used.type = 1;
    if (colorText && lead !== subjectHead) used.color = 1;
  }
  if (brand) { head.push(brand); used.brand = 1; }
  if (code) { head.push(code); used.vendorCode = 1; }

  const first = [];
  if (head.length) {
    const forAt = subjectHead.search(FOR_RE);
    if (forAt > 0 && head.length > 1) {
      const before = subjectHead.slice(0, forAt).trim();
      const after = subjectHead.slice(forAt).trim();
      if (before) head.splice(0, 1, before), head.push(after);
    }
    const brandSaid = item.compatibleBrand
      && subject.toLowerCase().includes(String(item.compatibleBrand).toLowerCase().split(/[\s-]/)[0]);
    const forWhat = fits
      ? ` для ${fits}`
      : (item.compatibleBrand && !brandSaid ? ` для техники ${item.compatibleBrand}` : '');
    if (!fits && forWhat) used.compatibleBrand = 1;
    first.push(`${head.join(' ')}${forWhat}${subjectTail ? `, ${subjectTail}` : ''}.`);
  } else if (fits) {
    first.push(`Подходит к ${fits}.`);
  }
  if (item.originalNumber && item.originalNumber !== code) {
    first.push(`Оригинальный номер — ${item.originalNumber}.`);
    used.originalNumber = 1;
  }
  /*
    Поле Description у VTT — это пометки, и большинство из них служебные:
    «Товары TOP80», «ТПА для Москвы», «Незакупаемые товары» покупателю
    ничего не говорят. Но две из них говорят многое, и молчать о них
    нельзя: снятая с производства позиция и уценка меняют решение о
    покупке. Список закрытый — чужую пометку своими словами не
    пересказываем.
  */
  const flag = String(item.supplierDescription ?? '').trim();
  if (/снят\w*\s+с\s+производства/i.test(flag)) {
    first.push('Поставщик отмечает: позиция снята с производства.');
    used.lifecycle = 1;
  } else if (/уценённ|уцененн/i.test(flag)) {
    first.push('Поставщик отмечает: уценённый товар.');
    used.lifecycle = 1;
  } else if (/новинк/i.test(flag)) {
    first.push('Новинка в ассортименте поставщика.');
    used.lifecycle = 1;
  }
  if (first.length) paragraphs.push(first.join(' '));

  /* ------------------------------------------------------ совместимость */
  const compatIsList = looksLikeCompatList(note.compat);
  if (note.compat && compatIsList) {
    /* Перечень моделей — самое полезное, что есть в карточке расходника,
       и он у каждой позиции свой. */
    const list = note.compat.length <= 600 ? note.compat : `${note.compat.slice(0, 597)}…`;
    paragraphs.push(`${fits ? 'Полный перечень совместимости из выгрузки поставщика' : 'По данным поставщика подходит к аппаратам'}: ${list}`.replace(/[.\s]*$/, '.'));
    used.compatibilityText = 1;
  } else if (note.compat) {
    /* Не перечень, а описание назначения или порядка применения. Текст
       поставщика сохраняем дословно, но называем тем, что это есть. */
    const list = note.compat.length <= 600 ? note.compat : `${note.compat.slice(0, 597)}…`;
    paragraphs.push(`Поставщик описывает позицию так: ${list}`.replace(/[.\s]*$/, '.'));
    used.supplierUsage = 1;
    if (!fits && code) {
      paragraphs.push(`Перечня совместимых аппаратов в выгрузке нет: подобрать позицию ` +
        `можно по артикулу ${code}` +
        `${item.originalNumber && item.originalNumber !== code ? ` или по оригинальному номеру ${item.originalNumber}` : ''}.`);
      used.noCompatNote = 1;
    }
  } else if (!fits && code) {
    paragraphs.push(`Перечень совместимых аппаратов поставщик для этой позиции не передал: ` +
      `подобрать её к вашей технике можно по артикулу ${code}` +
      `${item.originalNumber && item.originalNumber !== code ? ` или по оригинальному номеру ${item.originalNumber}` : ''}.`);
    used.noCompatNote = 1;
  }

  /* -------------------------------------------------------- состав серии */
  if (family && family.members?.length > 1) {
    /*
      Цветовые варианты объективно делят и совместимость, и почти все
      поля. Отличается в них цвет и ресурс — вот про это и текст: какой
      набор у серии, чем позиции в нём различаются и какая эта.
    */
    const others = family.members.filter((m) => m.code !== code);
    /* Цвета группируются по ресурсу: у цветного аппарата чёрный обычно
       рассчитан на большее число страниц, и это самое содержательное,
       что можно сказать про состав набора. */
    const byRes = new Map();
    for (const m of family.members) {
      const key = m.res ? fmt(m.res) : '';
      if (!byRes.has(key)) byRes.set(key, []);
      /* Код цвета в скобках нужен на плитке, где рядом артикул, но в
         связном тексте «чёрный (bk)» читается как опечатка. */
      byRes.get(key).push(String(m.color).replace(/\s*\([^)]*\)\s*$/, '').toLowerCase());
    }
    const groups = [...byRes.entries()].map(([res, colors]) => {
      const list = colors.length > 1
        ? `${colors.slice(0, -1).join(', ')} и ${colors[colors.length - 1]}`
        : colors[0];
      return `${list}${res ? ` — ${colors.length > 1 ? 'по ' : ''}${res} страниц` : ''}`;
    });
    const line = family.series
      ? `Серия ${family.series} выпускается в ${family.members.length} ${plural(family.members.length, 'цвете', 'цветах', 'цветах')}: ${groups.join('; ')}.`
      : `В этой серии ${family.members.length} ${plural(family.members.length, 'цвет', 'цвета', 'цветов')}: ${groups.join('; ')}.`;
    /* «Вариант» — слово мужского рода, поэтому прилагательное цвета
       согласуется с ним при любом типе товара. Ресурс здесь не
       повторяется: он сказан следующим абзацем. */
    const mine = colorText && others.length
      ? ` Эта позиция — ${colorText} вариант серии; остальные цвета продаются отдельными позициями (${others.map((m) => m.code).join(', ')}).`
      : '';
    paragraphs.push(line + mine);
    used.family = 1;
  }

  /* ------------------------------------------------------ ресурс и объём */
  const yieldPara = [];
  if (item.resource) {
    /* Оговорка вшита в то же предложение: двумя отдельными фразами она
       повторялась в каталоге дважды по две с половиной тысячи раз. И без
       «краски» там, где тонер. */
    yieldPara.push(PAGE_YIELD_TYPES.has(type)
      ? `Заявленный поставщиком ресурс — ${fmt(item.resource)} страниц; фактический зависит от заполнения страниц и условий печати.`
      : `Заявленный поставщиком ресурс — ${fmt(item.resource)} страниц.`);
    if (PAGE_YIELD_TYPES.has(type)) used.yieldNote = 1;
    used.resource = 1;
  } else if (item.volumeMl) {
    yieldPara.push(`Объём — ${fmt(item.volumeMl)} мл.`);
    used.volumeMl = 1;
  } else if (item.lifeTime) {
    yieldPara.push(`Ресурс по выгрузке указан как «${item.lifeTime}» — в число он не разбирается, уточните у менеджера.`);
    used.lifeTime = 1;
  }
  if (yieldPara.length) paragraphs.push(yieldPara.join(' '));

  /* --------------------------------------------- комплектация и пометки */
  const kit = [];
  for (const phrase of note.notes) kit.push(phrase);
  if (note.notes.length) used.notes = 1;
  if (note.unknown.length) {
    const joined = note.unknown.join(', ');
    const composition = /^состав\s*:/i.exec(joined);
    kit.push((composition
      ? `В комплект входят: ${joined.slice(composition[0].length).trim()}.`
      /* Текст поставщика нередко уже кончается точкой — второй не надо. */
      : `Поставщик отмечает: ${joined}.`).replace(/\.{2,}$/u, '.'));
    used.notes = 1;
  }
  if (/бункер/i.test(kit.join(' '))) kit.push('Используйте штатный бункер аппарата или закажите его отдельно.');
  if (/чип в комплект не входит/i.test(kit.join(' '))) kit.push('Чип переставляется со старого картриджа или заказывается отдельной позицией.');
  /*
    Количество в упаковке осталось только у бумаги и плёнки: там это
    состав товара — пачка на двадцать листов, — и сказать об этом нужно
    словами. У остальных позиций оно уже стоит строкой в характеристиках,
    а в тексте фраза «поставщик отгружает упаковками по N шт.» повторялась
    у 2 991 карточки, ничего к ним не добавляя.
  */
  if (item.inPackage && item.inPackage > 1 && SHEET_TYPES.has(type)) {
    kit.push(`В упаковке ${fmt(item.inPackage)} ${plural(item.inPackage, 'лист', 'листа', 'листов')}.`);
    used.inPackage = 1;
  }
  if (kit.length) paragraphs.push(kit.join(' '));

  return {
    text: paragraphs.join('\n\n'),
    paragraphs,
    basedOn: Object.keys(used),
    version: DESCRIPTION_VERSION,
  };
}

/*
  Марка в тексте. Границы заданы явно, а не через \b: в JavaScript \b
  считает «словом» только латиницу с цифрами, поэтому у кириллического
  слова границы нет вовсе и такая проверка молча ничего не находит.
*/
const BOUND = '(^|[^\\p{L}\\p{N}])';
const markRe = (mark) => new RegExp(`${BOUND}${String(mark).replace(/-/g, '[-\\s]?')}($|[^\\p{L}\\p{N}])`, 'iu');
/* «для», «совместим…», «подходит» открывают хвост о совместимости. */
const COMPAT_TAIL = new RegExp(`${BOUND}(для|совместим\\p{L}*|подходит|под)($|[^\\p{L}\\p{N}])`, 'iu');

/*
  Собственная марка в названии — запасной признак для товаров, у которых
  поставщик не заполнил Brand.

  Смотрим только «производительную» часть названия, до хвоста о
  совместимости. Иначе «Ролик подачи для Hi-Black …» — чужая деталь,
  подходящая к технике Hi-Black, — попала бы на витрину как своя.
  Описание и поле совместимости здесь не участвуют вовсе: слово из
  описания маркой не является.
*/
export function ownBrandInName(name, marks = []) {
  const text = String(name ?? '');
  const tail = text.search(COMPAT_TAIL);
  const head = tail >= 0 ? text.slice(0, tail) : text;
  return marks.some((m) => markRe(m).test(head));
}

/*
  Что попадает на витрину.

  Отбор идёт по Brand из выгрузки — по тому, кто товар произвёл. Ни
  Vendor, ни раздел витрины для этого не годятся: Vendor у VTT означает
  марку принтера, к которому товар подходит, и по нему в каталог попал бы
  весь чужой ассортимент, совместимый с HP или Canon.

  Товары с незаполненным Brand спасаются по названию, но только по
  списку марок, у которых название однозначно: Hi-Black, Hi-Image,
  Hi-Color, NetProduct — придуманные имена, их ни с чем не спутать.
  Content в этот список не входит: это обычное английское слово, и
  встретившись в названии чужого товара оно протащило бы его на витрину.
*/
export function matchesFilter(item, filter = {}) {
  /*
    Повреждённая упаковка на витрину не попадает вовсе. Это не вариант
    товара и не «уценка со скидкой»: карточка, поисковая выдача, страница
    для индексации и переключатель цвета такой позиции не создаются.
    Отсев идёт здесь, до присвоения адреса и до сборки семейств, — иначе
    исключённая позиция успела бы занять slug и попасть в комплект
    ссылкой в никуда.

    В сторе такие позиции остаются: это настоящая выгрузка поставщика, и
    терять её из-за решения о витрине нельзя.
  */
  if (filter.excludeDamagedPackage !== false) {
    const damaged = item.packageDamaged ?? isDamagedPackage({
      name: item.name, description: item.supplierDescription, compatibility: item.compatibilityText,
    });
    if (damaged) return false;
  }
  const brands = (filter.brands ?? []).map((s) => String(s).trim().toLowerCase());
  const exclude = (filter.excludeBrands ?? []).map((s) => String(s).trim().toLowerCase());
  const cats = filter.categories ?? [];
  const brand = String(item.brand ?? '').trim().toLowerCase();
  if (exclude.length && exclude.includes(brand)) return false;

  if (brands.length && !brands.includes(brand)) {
    const fb = filter.brandFallback ?? null;
    const weak = (fb?.whenBrandIn ?? []).map((s) => String(s).trim().toLowerCase()).includes(brand);
    if (!(weak && ownBrandInName(item.name, fb?.nameMarks ?? []))) return false;
  }

  if (cats.length && !cats.includes(item.categoryId) && !cats.includes(item.category)) return false;
  return true;
}

/*
  Наличие. Три склада остаются тремя числами, а «в наличии» означает
  строго доступный остаток — не сумму с транзитом: транзит это «будет»,
  а не «есть».
*/
export function availabilityOf(item) {
  const rt = item.runtime ?? {};
  const available = rt.available ?? item.stock?.available ?? 0;
  const transit = rt.transit ?? item.stock?.transit ?? 0;
  const mainOffice = rt.mainOffice ?? item.stock?.mainOffice ?? 0;
  return { available, transit, mainOffice, inStock: available > 0 };
}

/*
  Пригодность ссылки на фото. Битую ссылку лучше отсечь на сборке, чем
  показать покупателю сломанную картинку: у карточки есть корректное
  состояние «фото не передано», и оно честнее пустого прямоугольника.

  Проверяется только форма ссылки — сборка сайта в сеть не ходит.
  Фактическая загрузка и оптимизация выполняются отдельным шагом импорта
  изображений, который и пишет в отчёт недоступные адреса.
*/
export const PHOTO_PLACEHOLDER = '/assets/img/no-photo.svg';

export function usablePhoto(url) {
  if (typeof url !== 'string' || !url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname;
    /* Зарезервированные RFC 2606 имена не резолвятся никогда — такие
       адреса в выгрузке означают «фото нет». */
    if (/\.(invalid|example|test|localhost)$/i.test(host)) return false;
    return true;
  } catch { return false; }
}

/*
  Цена на витрине.

  Полная выгрузка даёт рублёвую цену (PriceLocal) и её же в валюте
  поставщика (Price). Оперативная выгрузка даёт только валютную — такого
  поля, как PriceLocal, в ItemRuntimeDto нет. Поэтому свежая цена
  переводится в рубли по курсу самой этой позиции, снятому с полной
  выгрузки: PriceLocal / Price. Это курс поставщика, а не придуманный
  нами, и он берётся с той же карточки, а не усредняется по каталогу.

  Если курс снять не с чего (валютной цены в полной выгрузке не было),
  оперативная цена не применяется вовсе: лучше показать вчерашнюю
  рублёвую цену, чем сегодняшнюю в чужой валюте.
*/
export function priceOf(item) {
  const rt = item.runtime ?? {};
  const base = item.price;
  if (rt.priceForeign === undefined || rt.priceForeign === null) {
    return { price: base, retail: undefined, from: 'full' };
  }
  const rate = item.priceForeign > 0 && base > 0 ? base / item.priceForeign : null;
  if (!rate) return { price: base, retail: undefined, from: 'full', note: 'курс неизвестен' };
  return { price: Math.round(rt.priceForeign * rate * 100) / 100, retail: undefined, from: 'runtime', rate };
}

/*
  Товар витрины. Форма совпадает с той, что уже принимает сборщик
  каталога, — иначе пришлось бы переписывать витрину ради нового источника.
  Редакционные правки накладываются поверх и не затираются синком: они
  живут в отдельном файле и применяются здесь, при публикации.
*/
export function toShopProduct(item, { editorial = {}, categoryPath = [], shopCat, shopBrand } = {}) {
  const { price, retail } = priceOf(item);
  const av = availabilityOf(item);
  const description = buildDescription(item);
  const edit = editorial[item.id] ?? {};

  return {
    id: item.slug || slugify(item.id),
    vttId: item.id,
    name: edit.name ?? item.name ?? item.vendorCode ?? item.id,
    code: item.vendorCode ?? '',
    model: (item.vendorCode ?? '').replace(/^HB-/i, ''),
    originalNumber: item.originalNumber ?? '',
    /* Две системы категорий живут рядом и не подменяют друг друга:
       `cat` — раздел витрины (лазерные, струйные, тонеры…), `vttCategoryId`
       и `catPath` — место товара в дереве поставщика. Терять второе нельзя:
       по нему строится отчёт о раскладке и проверяется полнота импорта. */
    cat: shopCat ? shopCat(item) : (item.categoryId ?? ''),
    vttCategoryId: item.categoryId ?? '',
    vttCategory: item.category ?? '',
    catPath: categoryPath,
    brand: shopBrand ? shopBrand(item) : (item.brand ?? ''),
    supplierBrand: item.brand ?? '',
    type: typeOf(item) ?? '',
    res: item.resource ?? null,
    /* Строка ресурса от поставщика едет рядом с разобранным числом: по
       ней видно, что именно разобрано, а что осталось как есть. */
    lifeTime: item.lifeTime ?? '',
    volumeMl: item.volumeMl ?? null,
    /* Код цвета остаётся кодом: по нему собираются семейства и по нему
       покупатель сверяется с надписью на картридже. Русское название —
       отдельным полем, для показа. */
    color: item.color ?? '',
    colorTitle: colorTitle(item.color),
    chip: null,
    compat: modelsOf(item).join(', '),
    models: modelsOf(item),
    /* Свободный текст поставщика едет отдельным полем и показывается как
       есть: резать его на модели нельзя, но и терять нельзя — у 6 681
       позиции это единственные сведения о совместимости. */
    compatText: item.compatibilityText ?? '',
    compatibleBrand: item.compatibleBrand ?? '',
    equip: '', tech: '', print: '',
    weight: item.weight ?? '',
    grossWeight: item.grossWeight ?? '',
    inPackage: item.inPackage ?? 0,
    barcode: item.barcode ?? '',
    categoryRoot: item.categoryRoot ?? '',
    /* Габариты без единицы измерения: поставщик её не указывает, а
       подписать «см» под 0,38 × 0,45 × 0,57 значит утверждать размер,
       которого никто не подтверждал. */
    dimensions: item.dimensions ?? null,
    grossDimensions: item.grossDimensions ?? null,
    img: usablePhoto(item.photos?.[0]) ? item.photos[0] : PHOTO_PLACEHOLDER,
    images: (item.photos ?? []).filter(usablePhoto),
    /* Адреса в том виде, в каком их прислал поставщик. Витрина ходит по
       https-версии, но исходник нужен для сверки и для этапа загрузки. */
    imagesOriginal: (item.photosOriginal ?? []).filter(usablePhoto),
    photoMissing: !usablePhoto(item.photos?.[0]),
    /* Три текста живут раздельно и никогда не перезаписывают друг друга. */
    supplierDescription: item.supplierDescription ?? '',
    description: description.text,
    descriptionBasedOn: description.basedOn,
    editorialDescription: edit.description ?? '',
    /* Рейтинг и отзывы у импортированных товаров пустые: настоящих отзывов
       ещё нет, а придумывать их нельзя. Демо-отзывы для preview живут
       отдельно и в эти счётчики не попадают. */
    rate: 0, reviews: 0, pop: 50, badge: '',
    price: price ?? 0,
    /* Цены нет — товар не продаётся кнопкой, а показывается «по запросу».
       Ноль в ценнике хуже отсутствия цены: он выглядит как бесплатно. */
    priceOnRequest: !(price > 0),
    priceFrom: (item.runtime ? 'runtime' : 'full'),
    /*
      Зачёркнутой «старой цены» у импортированных товаров нет.
      PriceRetail поставщик присылает в своей валюте, и это его
      рекомендованная розница, а не наша прежняя цена. Пересчитать её в
      рубли можно, но показать как «было 2 040 ₽ — стало 1 825 ₽» —
      значит объявить чужую наценку своей скидкой. Поле остаётся, чтобы
      цифра не потерялась, но на ценник не идёт.
    */
    old: 0,
    priceRetailForeign: item.priceRetailForeign ?? 0,
    priceForeign: item.priceForeign ?? 0,
    stock: av.inStock ? 1 : 0,
    stockDetail: { available: av.available, transit: av.transit, mainOffice: av.mainOffice },
    source: 'vtt',
    missing: item.missing ?? [],
  };
}

/*
  Публикация всего стора. Возвращает и товары, и отчёт: какие пропущены
  фильтром, какие скрыты, у каких не хватает данных для полноценной
  карточки. Отчёт — не украшение: без него «на витрине меньше товаров,
  чем в выгрузке» превращается в расследование.
*/
export function publish(store, options = {}) {
  const { filter = {}, editorial = {}, categories = [] } = options;
  const catById = new Map(categories.map((c) => [c.id, c]));
  const all = store.loadAll();
  const products = [];
  /*
    Отчёт о неполноте разделён на два. «Не хватает обязательного» — это
    карточка, которую нельзя показывать: без названия, артикула или цены.
    «Не хватает желательного» — это ресурс, фото, описание: карточка
    работает, но беднее. Раньше они шли одной кучей, и на реальной
    выгрузке в неё попадали все девять с половиной тысяч товаров —
    отчёт, в котором всё, не сообщает ничего.
  */
  const report = {
    total: all.size, inactive: 0, filtered: 0, damagedPackage: 0, published: 0,
    incomplete: [], missingRequired: [], noPrice: [], noPhoto: [], noDescription: [], noCompatibility: [],
  };

  for (const item of all.values()) {
    if (item.active === false) { report.inactive += 1; continue; }
    if (!matchesFilter(item, filter)) {
      report.filtered += 1;
      /* Повреждённая упаковка считается отдельно от чужих марок: это
         разные причины, и в отчёте они не должны сливаться. */
      if (item.packageDamaged) report.damagedPackage += 1;
      continue;
    }
    const cat = catById.get(item.categoryId);
    const product = toShopProduct(item, {
      editorial, categoryPath: cat?.path ?? [],
      shopCat: options.shopCat, shopBrand: options.shopBrand,
    });
    if (!product.price) report.noPrice.push(item.id);
    if (product.photoMissing) report.noPhoto.push(item.id);
    if (item.missing?.length) {
      const required = item.missing.filter((f) => REQUIRED_FOR_CARD.includes(f));
      const entry = { id: item.id, name: item.name ?? null, missing: item.missing };
      report.incomplete.push(entry);
      if (required.length) report.missingRequired.push({ ...entry, required });
    }
    if (!item.supplierDescription) report.noDescription.push(item.id);
    if (!item.compatibilityText) report.noCompatibility.push(item.id);
    products.push(product);
    report.published += 1;
  }

  /* Порядок фиксированный: иначе каждая сборка давала бы другой diff при
     тех же данных. */
  products.sort((a, b) => a.id.localeCompare(b.id, 'ru'));
  return { products, report };
}
