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
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('Не удалось загрузить ' + url + ' (' + r.status + ')');
      return r.json();
    });
  }

  /* Один товар: строка индекса + цена и остаток из живого файла. */
  function hydrate(i) {
    var row = state.rows[i];
    if (!row) return null;
    var p = { row: i };
    for (var f = 0; f < state.fields.length; f++) p[state.fields[f]] = row[f];
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
        state.meta = r[0];
        state.fields = r[1].fields;
        state.rows = r[1].rows;
        state.cats = r[2];
        state.brands = r[3];
        state.live = r[4];
        state.site = r[5];
        state.loaded = true;
        return API;
      });
      return readyPromise;
    },

    at: hydrate,
    all: function () { var out = []; for (var i = 0; i < state.rows.length; i++) out.push(hydrate(i)); return out; },
    byId: function (id) { for (var i = 0; i < state.rows.length; i++) if (state.rows[i][0] === id) return hydrate(i); return null; },
    bySlug: function (slug) { for (var i = 0; i < state.rows.length; i++) if (state.rows[i][1] === slug) return hydrate(i); return null; },

    brandName: function (id) { return (state.site && state.site.brandNames[id]) || id; },
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
        return { id: id, label: f.label, items: f.rows.map(hydrate).filter(Boolean) };
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
