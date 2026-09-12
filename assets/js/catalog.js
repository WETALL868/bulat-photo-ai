/*
  Слой данных витрины.

  Каталог лежит статичными файлами и кешируется браузером надолго. Цены и
  остатки живут отдельно в /live/catalog-live.json и обновляются по расписанию,
  поэтому переоценка не заставляет перекачивать каталог.

  Порядок загрузки:
    ready()      индекс, категории, бренды, цены, словари сайта — один пакет
    detail(id)   детали товара, чанк на 32 позиции, только когда открыли карточку
    search(q)    по заранее собранному индексу токенов

  Товар наружу отдаётся объектом с обычными именами полей: сжатый формат
  хранения не должен протекать в код страниц.
*/
(function () {
  'use strict';

  /*
    Адрес данных. На сервере это корень сайта, но витрину надо уметь
    открыть и там, где корня нет: превью публикуется набором файлов рядом
    со страницей, и путь с ведущим слешем там не обслуживается. Поэтому
    префикс задаётся снаружи, а весь остальной код по-прежнему пишет
    обычные абсолютные адреса.
  */
  var PREFIX = window.HB_DATA_BASE || '';
  function dataUrl(u) { return PREFIX ? PREFIX + u.replace(/^\//, '') : u; }
  var BASE = '/data/catalog/';
  var state = { loaded: false, meta: null, fields: null, rows: [], cats: [], brands: [], live: null, site: null, search: null, compat: null, fams: null };
  var chunkCache = {};
  var readyPromise = null;

  /*
    Обычно данные приходят по сети. В сборке «весь сайт одним файлом»
    (tools/build-single.js) сети нет вообще, и те же файлы лежат внутри
    страницы в window.HB_INLINE — тогда возвращаем их без запроса.
  */
  function json(url) {
    if (window.HB_INLINE && Object.prototype.hasOwnProperty.call(window.HB_INLINE, url)) {
      return Promise.resolve(window.HB_INLINE[url]);
    }
    return fetch(dataUrl(url), { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('Не удалось загрузить ' + url + ' (' + r.status + ')');
      return r.json();
    });
  }

  /*
    Распаковка индекса.

    Индекс приходит сжатым: повторяющиеся колонки заменены номерами в
    словарях, у адресов картинок вынесен общий префикс, а слаг, совпавший
    с идентификатором, не записан вовсе. На девяти с половиной тысячах
    товаров это разница между 2,5 МБ и третью мегабайта на первой
    загрузке. Разбор восстанавливает строку в точности; несжатый формат
    тоже понимается, поэтому старые файлы каталога читаются как раньше.
  */
  function unpackIndex(idx) {
    state.fields = idx.fields;
    state.rows = idx.rows;
    state.packed = idx.packed === 1;
    state.dictIdx = {};
    state.imgBases = idx.imgBases || [];
    state.idCol = idx.fields.indexOf('id');
    state.slugCol = idx.fields.indexOf('slug');
    state.imgCol = idx.fields.indexOf('img');
    if (!state.packed) return;
    var dicts = idx.dicts || {}, names = idx.dictFields || [];
    for (var d = 0; d < names.length; d++) state.dictIdx[idx.fields.indexOf(names[d])] = dicts[names[d]] || [];
  }

  function unpackValue(col, value, row) {
    if (!state.packed) return value;
    var dict = state.dictIdx[col];
    if (dict && typeof value === 'number') return dict[value];
    if (col === state.slugCol && value === 0) return row[state.idCol];
    if (col === state.imgCol && typeof value === 'string' && value.charCodeAt(0) === 1) {
      return state.imgBases[Number(value.charAt(1))] + value.slice(2);
    }
    return value;
  }

  /*
    Карта миниатюр в атласах.

    Нужна там, где витрина опубликована набором файлов и картинки
    поставщика во фрейме не грузятся. Тогда уменьшенные копии лежат
    внутри самой публикации, собранные по сто сорок четыре штуки в одну
    картинку, а здесь хранится, где чья ячейка. Карты нет — всё работает
    как раньше, поэтому файл и запрашивается только по отметке в meta.
  */
  function thumbOf(id) {
    var t = state.thumbs;
    if (!t || !t.items) return null;
    var e = t.items[id];
    if (!e) return null;
    return { file: t.files[e[0]], col: e[1], row: e[2], cols: t.cols, rows: t.rows };
  }

  /* Слаг нужен и до разбора всей строки: по нему ищется карточка. */
  function slugAt(i) {
    var row = state.rows[i];
    if (!row) return null;
    return unpackValue(state.slugCol, row[state.slugCol], row);
  }

  /* Один товар: строка индекса + цена и остаток из живого файла. */
  function hydrate(i) {
    var row = state.rows[i];
    if (!row) return null;
    var p = { row: i };
    for (var f = 0; f < state.fields.length; f++) p[state.fields[f]] = unpackValue(f, row[f], row);
    var l = (state.live && state.live.items[p.id]) || {};
    p.price = l.price || 0;
    p.old = l.old || 0;
    p.stock = !!l.available;
    p.chip = p.chip === null ? null : !!p.chip;
    return p;
  }

  var API = {
    get meta() { return state.meta; },
    get cats() { return state.cats; },
    get brands() { return state.brands; },
    get site() { return state.site; },
    get live() { return state.live; },
    get count() { return state.rows.length; },

    ready: function () {
      if (readyPromise) return readyPromise;
      readyPromise = Promise.all([
        json(BASE + 'meta.json'),
        json(BASE + 'index.json'),
        json(BASE + 'categories.json'),
        json(BASE + 'brands.json'),
        json('/live/catalog-live.json'),
        json('/data/site.json'),
      ]).then(function (r) {
        /* Карта миниатюр грузится вторым шагом и только если она есть:
           первый пакет и так определяет скорость первого экрана. */
        if (r[0] && r[0].thumbs) {
          return json(BASE + 'thumbs.json').then(function (t) { state.thumbs = t; return r; }, function () { return r; });
        }
        return r;
      }).then(function (r) {
        state.meta = r[0];
        unpackIndex(r[1]);
        state.cats = r[2];
        state.brands = r[3];
        state.live = r[4];
        state.site = r[5];
        state.loaded = true;
        return API;
      });
      return readyPromise;
    },

    thumb: thumbOf,
    at: hydrate,
    all: function () { var out = []; for (var i = 0; i < state.rows.length; i++) out.push(hydrate(i)); return out; },
    byId: function (id) { for (var i = 0; i < state.rows.length; i++) if (state.rows[i][0] === id) return hydrate(i); return null; },
    bySlug: function (slug) { for (var i = 0; i < state.rows.length; i++) if (slugAt(i) === slug) return hydrate(i); return null; },

    brandName: function (id) { return (state.site && state.site.brandNames[id]) || id; },
    /* Название цвета для показа: «Голубой (C)». Таблица приходит из
       сборки — витрина ничего не переводит сама и незнакомый код
       показывает как есть, а не называет наугад. */
    colorTitle: function (code) {
      if (!code) return '';
      var t = state.meta && state.meta.colorTitles;
      return (t && t[code]) || code;
    },
    brandLogo: function (id) { return (state.site && state.site.brandLogos[id]) || null; },
    catName: function (id) { var c = state.cats.filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; },
    cat: function (id) { return state.cats.filter(function (x) { return x.id === id; })[0] || null; },

    /* Детали карточки: чанк на 32 товара, повторно не запрашивается. */
    detail: function (id) {
      var row = -1;
      for (var i = 0; i < state.rows.length; i++) if (state.rows[i][0] === id) { row = i; break; }
      if (row < 0) return Promise.resolve(null);
      var n = Math.floor(row / state.meta.chunkSize);
      if (!chunkCache[n]) chunkCache[n] = json(BASE + 'chunks/detail-' + n + '.json');
      return chunkCache[n].then(function (c) { return c[id] || null; });
    },

    featured: function () {
      return json(BASE + 'featured.json').then(function (ids) {
        return ids.map(function (id) { return API.byId(id); }).filter(Boolean);
      });
    },

    /* Поиск по индексу токенов: слово запроса совпадает с началом токена. */
    search: function (q) {
      var query = String(q || '').toLowerCase().split(/[^0-9a-zа-яё]+/i).filter(function (t) { return t.length >= 2; });
      if (!query.length) return Promise.resolve([]);
      if (!state.search) state.search = json(BASE + 'search-index.json');
      return state.search.then(function (idx) {
        var sets = query.map(function (term) {
          var hit = {};
          for (var tok in idx) if (tok.indexOf(term) === 0) idx[tok].forEach(function (i) { hit[i] = 1; });
          return hit;
        });
        return Object.keys(sets[0] || {})
          .filter(function (i) { return sets.every(function (s) { return s[i]; }); })
          .map(Number)
          .map(hydrate);
      });
    },

    /*
      Комплекты по цветам: один и тот же картридж в нескольких цветах.
      Файл маленький, грузится при первом открытии карточки из семейства.
    */
    families: function () {
      if (!state.fams) state.fams = json(BASE + 'families.json');
      return state.fams;
    },
    family: function (id) {
      if (!id) return Promise.resolve(null);
      return API.families().then(function (all) {
        var f = all[id];
        if (!f) return null;
        /* Подписи вариантов приходят готовыми из сборки: там цвет уже
           назван по-русски, а одинаковые цвета в серии различены
           ресурсом, объёмом или артикулом.

           Товар и его подпись отбираются вместе. Если раскрыть строку не
           удалось, выпасть должны обе — иначе подписи сдвинутся, и у
           голубого картриджа окажется цена жёлтого. */
        var pairs = f.rows.map(function (row, i) {
          return { item: hydrate(row), label: (f.colors || [])[i] || '' };
        }).filter(function (x) { return !!x.item; });
        return {
          id: id, label: f.label, series: f.series || '',
          colors: pairs.map(function (x) { return x.label; }),
          items: pairs.map(function (x) { return x.item; }),
        };
      });
    },

    /* Совместимость: страницы под модели принтеров. */
    compatibility: function () {
      if (!state.compat) state.compat = json(BASE + 'compatibility.json');
      return state.compat;
    },
    printer: function (key) {
      return API.compatibility().then(function (c) {
        var e = c[key];
        if (!e) return null;
        return { key: key, brand: e.brand, model: e.model, label: e.label, products: e.rows.map(hydrate) };
      });
    },
  };

  window.HBCatalog = API;
})();
