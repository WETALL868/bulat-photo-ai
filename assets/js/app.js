/*
  Hi-Black — витрина.

  Страницы адресуются настоящими путями (/catalog/laser/kyocera,
  /product/hb-tk-1150), а не решёткой: только так поисковик получает отдельный
  документ на каждый товар и каждую модель принтера. Тот же путь заранее собран
  в статический HTML в seo-pages/, сервер отдаёт его сразу, а этот скрипт
  перерисовывает страницу поверх уже показанного содержимого.

  Данные берутся из HBCatalog (assets/js/catalog.js): каталог статичный, цены и
  остатки — из отдельного живого файла.
*/
(function () {
  'use strict';

  var C = window.HBCatalog, ICONS = window.HB_ICONS;
  var app = document.getElementById('app');

  /* ------------------------------------------------------------- мелочи */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function ratef(r) { return String(Number(r).toFixed(1)).replace('.', ','); }
  /*
    Семейство цветов считается как один товар.

    Покупатель выбирает между чёрным, голубым, пурпурным и жёлтым одного
    набора и читает их как одну позицию. Отзыв о чёрном картридже верен и
    для остальных трёх: это один и тот же картридж в четырёх исполнениях.
    Поэтому счётчик и средняя оценка складываются по всему семейству, а не
    по одной карточке, — иначе четыре отзыва выглядели бы как четыре
    товара с одним отзывом.
  */
  var famGroups = null;
  function famMembers(p) {
    if (!p || !p.fam || !C.count) return p ? [p] : [];
    if (!famGroups) {
      famGroups = {};
      C.all().forEach(function (x) {
        if (x.fam) (famGroups[x.fam] || (famGroups[x.fam] = [])).push(x);
      });
    }
    return famGroups[p.fam] || [p];
  }
  function realStats(p) {
    var members = famMembers(p);
    var total = members.reduce(function (sum, x) { return sum + (Number(x.reviews) || 0); }, 0);
    var points = members.reduce(function (sum, x) { return sum + (Number(x.reviews) || 0) * (Number(x.rate) || 0); }, 0);
    return { count: total, rate: total ? Math.round(points / total * 10) / 10 : 0 };
  }


  function plural(n, a, b, c) { n = Math.abs(n) % 100; var n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }
  function ic(name, size, cls) {
    return '<svg class="' + (cls || 'ic') + '" width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  }
  /*
    Канал MAX. Настройка приходит из data/site.json (catalog-source/site.config.mjs,
    константа messengers.max) и нигде в разметке не дублируется.

    Пока адрес не подтверждён, сборщик кладёт в site.json url: null и
    active: false. В этом состоянии блоки MAX остаются видимыми — дизайн можно
    согласовывать, — но ссылкой не притворяются: это span без href, без
    навигации, с aria-disabled и подписью «Ссылка будет добавлена». Заглушка
    физически не может стать кликабельной.

    Как только в конфиге появится настоящий адрес и confirmed:true, те же
    элементы собираются как обычные <a target="_blank" rel="noopener noreferrer">.

    Предзаполненный текст обращения не подставляем: документации на deep link с
    текстом у MAX нет, а выдумывать параметры и получить неработающую ссылку
    хуже, чем просто открыть чат.
  */
  function maxCfg() { return (C.site && C.site.messengers && C.site.messengers.max) || null; }
  function maxOn() { var m = maxCfg(); return !!(m && m.active && m.url); }
  function maxEl(cls, aria, inner) {
    var m = maxCfg();
    if (!m) return '';
    if (!maxOn()) return '<span class="' + cls + ' is-off" aria-disabled="true">' + inner + '</span>';
    return '<a class="' + cls + '" href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc(aria) + '">' + inner + '</a>';
  }
  function maxPending() { var m = maxCfg(); return esc((m && m.pending) || 'Ссылка будет добавлена'); }
  /* Официальный знак MAX — отдельный файл, адрес приходит из той же настройки.
     Картинкой, а не встроенным svg: внутри знака полторы сотни градиентов,
     фильтры и маска со своими id, которые столкнулись бы между точками. */
  function maxIcon(size, cls) {
    var m = maxCfg();
    if (!m || !m.icon) return '';
    return '<img class="maxico' + (cls ? ' ' + cls : '') + '" src="' + esc(m.icon) +
      '" alt="" width="' + size + '" height="' + size + '" loading="lazy" decoding="async">';
  }

  function stars(rate, size) {
    var full = Math.round(rate), out = '<span class="stars">';
    for (var i = 0; i < 5; i++) out += ic('star', size || 14, 'ic ' + (i < full ? 'on' : 'off'));
    return out + '</span>';
  }
  function brandLogo(b, h, cls) {
    var logo = C.brandLogo(b), name = C.brandName(b);
    if (!name) return '';
    if (logo) return '<img class="' + (cls == null ? 'blogo' : cls) + '" src="' + logo + '" alt="' + esc(name) + '" style="height:' + (h || 18) + 'px">';
    return '<span class="' + (cls == null ? 'blogo' : cls) + ' btext">' + esc(name) + '</span>';
  }

  /* ------------------------------------------------------------- адреса
     На сайте адреса настоящие: /catalog/laser/kyocera. В сборке одним файлом
     сервера нет, переписывать путь нельзя — там те же маршруты живут после
     решётки. Разница спрятана в OFFLINE, весь остальной код её не замечает. */
  /* Маршруты после решётки нужны не только файлу «всё в одном»: у превью
     из набора файлов тоже нет сервера, который перепишет путь, и обычная
     ссылка /catalog там открыла бы чужую страницу. */
  var OFFLINE = !!window.HB_INLINE || !!window.HB_HASH_ROUTING;
  function url(p) { return OFFLINE ? '#' + p : p; }
  function qs(params) {
    var keys = Object.keys(params || {}).filter(function (k) { var v = params[k]; return v !== undefined && v !== null && v !== '' && v !== false; });
    return keys.length ? '?' + keys.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&') : '';
  }
  var link = {
    home: function () { return url('/'); },
    catalog: function (cat, brand, params) { return url('/catalog' + (cat ? '/' + cat : '') + (brand ? '/' + brand : '') + qs(params)); },
    search: function (q, params) { return url('/search' + qs(Object.assign({ q: q }, params || {}))); },
    product: function (p, params) { return url('/product/' + (typeof p === 'string' ? p : p.slug) + qs(params)); },
    printer: function (key) { return url('/printer/' + key); },
    page: function (id) { return url('/help/' + id); },
    plain: function (name, params) { return url('/' + name + qs(params)); },
  };
  function here() {
    if (!OFFLINE) return { path: location.pathname, search: location.search };
    var h = location.hash.slice(1) || '/', i = h.indexOf('?');
    return i < 0 ? { path: h, search: '' } : { path: h.slice(0, i), search: h.slice(i) };
  }
  function parse() {
    var loc = here();
    var seg = loc.path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    var query = {};
    new URLSearchParams(loc.search).forEach(function (v, k) { query[k] = v; });
    if (!seg.length) return { route: 'home', query: query };
    var r = seg[0];
    if (r === 'catalog') return { route: 'catalog', cat: seg[1] || '', brand: seg[2] || '', query: query };
    if (r === 'search') return { route: 'catalog', cat: '', brand: '', query: query };
    if (r === 'product') return { route: 'product', slug: seg[1] || '', query: query };
    if (r === 'printer') return { route: 'printer', key: seg[1] || '', query: query };
    if (r === 'help') return { route: 'page', id: seg[1] || '', query: query };
    if (r === 'order') return { route: 'order', n: seg[1] || '', query: query };
    if (['cart', 'checkout', 'favorites', 'compare', 'finder', 'login'].indexOf(r) >= 0) return { route: r, query: query };
    return { route: 'notfound', query: query };
  }
  function go(to, replace) {
    if (OFFLINE) { location.hash = to.replace(/^#/, ''); return; }
    if (replace) history.replaceState({}, '', to); else history.pushState({}, '', to);
    render();
  }
  /* Текущий адрес с изменёнными параметрами фильтра. */
  function withQuery(patch) {
    var r = parse(), q = Object.assign({}, r.query, patch);
    Object.keys(q).forEach(function (k) { if (q[k] === '' || q[k] == null) delete q[k]; });
    return url(here().path + qs(q));
  }

  /* ------------------------------------------------------------ состояние */
  var S = { cart: null, fav: {}, cmp: {}, orders: 0, view: 'tiles' };
  try { var saved = JSON.parse(localStorage.getItem('hb-shop') || 'null'); if (saved) S = Object.assign(S, saved); } catch (e) { }
  if (!S.cart) S.cart = {};
  if (S.view !== 'list') S.view = 'tiles';
  function save() { try { localStorage.setItem('hb-shop', JSON.stringify(S)); } catch (e) { } }
  function cartItems() {
    return Object.keys(S.cart).map(function (id) { return { p: C.byId(id), q: S.cart[id] }; }).filter(function (x) { return x.p && x.q > 0 && x.p.price > 0; });
  }
  function cartCount() { return cartItems().reduce(function (a, x) { return a + x.q; }, 0); }
  function cartSum() { return cartItems().reduce(function (a, x) { return a + x.q * x.p.price; }, 0); }
  /* Скидка распределяется по строкам через накопленный итог. Поэтому
     суммы строк всегда равны итогу заказа даже при округлении до рубля. */
  function cartPricing(items) {
    items = items || cartItems();
    var gross = 0, discounted = 0, active = S.promo === 'HIBLACK5';
    var lines = items.map(function (it) {
      var lineGross = it.q * it.p.price;
      gross += lineGross;
      var nextDiscount = active ? Math.round(gross * 0.05) : 0;
      var lineDiscount = nextDiscount - discounted;
      discounted = nextDiscount;
      return { gross: lineGross, discount: lineDiscount, net: lineGross - lineDiscount };
    });
    return { gross: gross, discount: discounted, net: gross - discounted, lines: lines };
  }
  function count(o) { return Object.keys(o).filter(function (k) { return o[k]; }).length; }
  function updateHeader() {
    document.getElementById('cart-n').textContent = cartCount();
    document.getElementById('cart-sum').textContent = fmt(cartPricing().net) + ' ₽';
    var f = document.getElementById('fav-n'), c = document.getElementById('cmp-n');
    f.textContent = count(S.fav); f.hidden = !count(S.fav);
    c.textContent = count(S.cmp); c.hidden = !count(S.cmp);
  }

  /* ------------------------------------------------------------- фильтры */
  var RES = [
    { id: 'r1', name: 'до 3 000 страниц', t: function (r) { return r < 3000; } },
    { id: 'r2', name: '3 000 – 7 000', t: function (r) { return r >= 3000 && r < 7000; } },
    { id: 'r3', name: '7 000 – 15 000', t: function (r) { return r >= 7000 && r < 15000; } },
    { id: 'r4', name: 'более 15 000', t: function (r) { return r >= 15000; } },
  ];
  var COLORS = ['Чёрный', 'Голубой', 'Пурпурный', 'Жёлтый', 'Цветной', 'Серый'];
  var COLOR_HEX = { 'Чёрный': '#141414', 'Голубой': '#2bb5e9', 'Пурпурный': '#e6449a', 'Жёлтый': '#ffd200', 'Цветной': 'linear-gradient(90deg,#2bb5e9,#e6449a,#ffd200)', 'Серый': '#9a9a9a' };
  function list(p) { return (p || '').split(',').filter(Boolean); }
  function applyFilters(all, cat, brand, q, except) {
    var l = all;
    if (cat) l = l.filter(function (x) { return x.cat === cat; });
    if (brand && except !== 'brand') l = l.filter(function (x) { return x.brand === brand; });
    if (q.sale) l = l.filter(function (x) { return x.old; });
    if (q.stock && except !== 'stock') l = l.filter(function (x) { return x.stock; });
    if (except !== 'price') {
      if (q.pmin) l = l.filter(function (x) { return x.price >= +q.pmin; });
      if (q.pmax) l = l.filter(function (x) { return x.price <= +q.pmax; });
    }
    if (except !== 'res' && list(q.res).length) {
      var rs = list(q.res);
      l = l.filter(function (x) { return x.res != null && rs.some(function (id) { var r = RES.filter(function (k) { return k.id === id; })[0]; return r && r.t(x.res); }); });
    }
    if (except !== 'color' && list(q.color).length) { var cs = list(q.color); l = l.filter(function (x) { return cs.indexOf(x.color) >= 0; }); }
    if (except !== 'chip' && list(q.chip).length) { var ch = list(q.chip); l = l.filter(function (x) { return (x.chip === true && ch.indexOf('1') >= 0) || (x.chip === false && ch.indexOf('0') >= 0); }); }
    if (except !== 'type' && list(q.type).length) { var ts = list(q.type); l = l.filter(function (x) { return ts.indexOf(x.type) >= 0; }); }
    return l;
  }
  /*
    Порядок строк индекса — это и есть порядок по популярности: сборщик
    сортирует каталог по полю pop. Тот же номер строки служит вторым ключом
    во всех режимах, иначе при равных ценах и рейтингах список тасуется от
    страницы к странице и после смены фильтров.
  */
  /*
    Сортировка товарных подборок.

    Наличие — первый ключ, и это не «ещё одна сортировка», а правило
    витрины. На /catalog/zip первыми стояли позиции, которых нет: строки
    шли в порядке сборки, а наличие подмешивается из live уже в браузере,
    и сортировка о нём не знала. Покупатель пролистывал экран отсутствующих
    товаров, чтобы добраться до того, что можно купить.

    Выбранный человеком порядок — популярность, релевантность, цена,
    рейтинг, новинки — работает ВНУТРИ группы наличия, а не вместо неё.
    Смысл фильтра «Только в наличии» при этом не меняется: он по-прежнему
    убирает отсутствующие совсем, а здесь они просто уходят вниз.

    Хвостом у любого сравнения идёт номер строки: при равных значениях
    порядок обязан быть один и тот же на каждой отрисовке, иначе товар
    прыгал бы между страницами при переходе по пагинации.

    Сортируется весь отфильтрованный список, и только потом режется на
    страницы, — переставлять карточки внутри текущей страницы значит
    показать «в наличии» на второй странице раньше, чем на первой.
  */
  function sortList(l, s, query) {
    var avail = function (p) { return p && p.stock ? 0 : 1; };
    var by = function (f) {
      return function (a, b) { return avail(a) - avail(b) || f(a, b) || a.row - b.row; };
    };
    l = l.slice();
    if (query && (!s || s === 'relevance')) {
      var term = String(query).toLowerCase().replace(/[^0-9a-zа-яё]/gi, '');
      var rank = function (p) {
        var code = String(p.code || '').toLowerCase().replace(/[^0-9a-zа-яё]/gi, '');
        if (String(p.no || '') === term || code === term) return 0;
        if (code.indexOf(term) >= 0) {
          /* Для совпадающего номера сначала основные картриджи, затем
             запчасти с таким же номером (например, TK-5230 и TR-5230). */
          return /^(laser|ink|matrix)$/.test(p.cat) ? 1 : 2;
        }
        return 3;
      };
      l.sort(by(function (a, b) { return rank(a) - rank(b); }));
    }
    else if (s === 'price') l.sort(by(function (a, b) { return a.price - b.price; }));
    else if (s === '-price') l.sort(by(function (a, b) { return b.price - a.price; }));
    else if (s === 'rating') l.sort(by(function (a, b) { return b.rate - a.rate || b.reviews - a.reviews; }));
    else if (s === 'new') l.sort(by(function (a, b) { return hash(b.id) - hash(a.id); }));
    else l.sort(by(function () { return 0; }));
    return l;
  }
  function toggleValue(q, key, val) {
    var arr = list(q[key]), i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1); else arr.push(val);
    var patch = {}; patch[key] = arr.join(','); patch.page = '';
    return patch;
  }

  /* --------------------------------------------------------- блоки вёрстки */
  function badge(p) {
    /*
      Пометки ДЕМО здесь больше нет. Импортированные позиции — настоящие
      товары поставщика: у них свой артикул, своя цена и свой остаток, и
      плашка «проверочные данные» над ними вводила в заблуждение не
      меньше, чем её отсутствие над выдумкой.

      Со статусом отзывов это никак не связано: отзывов у товара может не
      быть вовсе, и об этом говорит блок отзывов, а не ярлык на карточке.
    */
    if (p.badge === 'hit') return '<span class="badge badge-hit">Хит</span>';
    if (p.badge === 'res') return '<span class="badge badge-new">Увеличенный ресурс</span>';
    return '';
  }
  /* Процент скидки показывается только рядом с ценой: там, где есть
     зачёркнутая цена, он и объясняет разницу. */
  function saleOff(p) {
    if (!p.old || p.old <= p.price) return '';
    return '<span class="save">−' + Math.round(100 - p.price / p.old * 100) + '%</span>';
  }
  /*
    Цены может не быть. У поставщика это выражено значением −1, и таких
    позиций 972 из 9 483. Ноль в ценнике хуже отсутствия цены: «0 ₽»
    читается как «бесплатно», а «−1 ₽» — как ошибка в магазине. Поэтому
    такой товар честно говорит «Цена по запросу» и не продаётся кнопкой.
  */
  function noPrice(p) { return !(p.price > 0); }
  /*
    Кнопка «Уведомить о поступлении».

    Она стоит в очень разных местах: в карточке каталога шириной в
    половину телефона, в блоке покупки на всю ширину, в закреплённой
    панели, в сравнении и в корзине. Надпись длинная, а .btn запрещает
    перенос — в узкой карточке текст вылезал за её край вместе с
    иконкой. Отдельный класс btn-alert разрешает перенос и растит высоту
    по содержимому, поэтому кнопка вписывается в любую из этих ширин.

    Надпись при этом не сокращается: «Уведомить» без «о поступлении»
    оставляет покупателя гадать, о чём его уведомят.
  */
  function stockAlertButton(p, cls) {
    return '<button class="btn btn-alert ' + (cls || 'btn-o') + '" type="button" data-stock-alert="' + esc(p.id) +
      '" aria-label="Уведомить о поступлении: ' + esc(p.name) + '">' +
      ic('mail', 18) + '<span class="bt">Уведомить о поступлении</span></button>';
  }
  var stockAlertModal = null, stockAlertPrev = null;
  function closeStockAlert() {
    if (!stockAlertModal || !stockAlertModal.classList.contains('open')) return;
    stockAlertModal.classList.remove('open');
    stockAlertModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('noscroll');
    if (stockAlertPrev && stockAlertPrev.focus) stockAlertPrev.focus();
  }
  function openStockAlert(id) {
    var p = C.byId(id);
    if (!p) return;
    if (p.stock) { showToast('Товар уже в наличии — обновите страницу.'); return; }
    if (!stockAlertModal) {
      stockAlertModal = document.createElement('div');
      stockAlertModal.className = 'modal stock-alert-modal';
      stockAlertModal.setAttribute('aria-hidden', 'true');
      stockAlertModal.innerHTML = '<div class="modal-bd" data-stock-close></div><div class="modal-w" role="dialog" aria-modal="true" aria-labelledby="stock-alert-title">' +
        '<button class="modal-x" type="button" data-stock-close aria-label="Закрыть">×</button>' +
        '<h3 id="stock-alert-title">Уведомить о поступлении</h3>' +
        '<p id="stock-alert-product"></p>' +
        '<form id="stock-alert-form"><label class="fld"><span>Электронная почта</span><input type="email" name="email" autocomplete="email" required placeholder="name@example.com"></label>' +
        '<label class="agree"><input type="checkbox" name="consent" required><span>Согласен(на) получить одно письмо, когда этот товар появится в наличии. Ознакомлен(а) с <a href="' + link.page('privacy') + '">Политикой конфиденциальности</a>.</span></label>' +
        '<p class="stock-alert-error" role="alert" hidden></p><button class="btn btn-y btn-full" type="submit">Сообщить о поступлении</button></form></div>';
      document.body.appendChild(stockAlertModal);
      stockAlertModal.addEventListener('click', function (e) { if (e.target.closest('[data-stock-close]')) closeStockAlert(); });
      stockAlertModal.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, b = f.querySelector('[type=submit]'), err = f.querySelector('.stock-alert-error');
        err.hidden = true;
        if (!f.reportValidity()) return;
        b.disabled = true; b.textContent = 'Сохраняем…';
        fetch('/api/stock-alert', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: f.dataset.product, email: f.elements.email.value.trim() }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || 'Не удалось сохранить запрос'); return j; }); })
          .then(function () { closeStockAlert(); showToast(ic('check', 18) + 'Сообщим на почту, когда товар появится.'); })
          .catch(function (ex) { err.textContent = ex.message || 'Не удалось сохранить запрос. Попробуйте ещё раз.'; err.hidden = false; })
          .finally(function () { b.disabled = false; b.textContent = 'Сообщить о поступлении'; });
      });
    }
    stockAlertPrev = document.activeElement;
    stockAlertModal.querySelector('#stock-alert-product').textContent = p.name + ' · артикул ' + p.code;
    var f = stockAlertModal.querySelector('form'); f.reset(); f.dataset.product = p.id;
    f.querySelector('.stock-alert-error').hidden = true;
    stockAlertModal.classList.add('open'); stockAlertModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('noscroll');
    f.elements.email.focus();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-stock-alert]');
    if (b) { e.preventDefault(); openStockAlert(b.dataset.stockAlert); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeStockAlert(); });

  /*
    Картинка товара.

    Обычно это <img> с адресом из каталога. Но там, где витрина
    опубликована набором файлов, а картинки поставщика во фрейме не
    грузятся, уменьшенные копии лежат внутри самой публикации — по сто
    сорок четыре штуки в одной картинке. Показать ячейку такой картинки
    через <img> нельзя, поэтому вместо него встаёт блок с фоном и
    смещением. Разметка отличается только здесь; всё остальное — верстка,
    ссылка, подпись — одинаково.

    Проценты в background-position и background-size — не произвол, а
    единственный способ адресовать ячейку, не зная размера элемента:
    браузер сам считает долю от разницы размеров фона и блока.
  */
  function imgHtml(p, attrs) {
    var a = attrs || {};
    /* noAtlas — когда рядом лежит полноразмерный файл: в галерее он
       важнее ячейки, а миниатюры по-прежнему берутся из атласа. */
    var t = a.noAtlas ? null : (C.thumb && C.thumb(p.id));
    var view = a.view ? ' data-gview="' + esc(a.view) + '"' : '';
    if (t) {
      var px = t.cols > 1 ? (t.col / (t.cols - 1)) * 100 : 0;
      var py = t.rows > 1 ? (t.row / (t.rows - 1)) * 100 : 0;
      return '<span class="atimg' + (a.cls ? ' ' + a.cls : '') + '" role="img" aria-label="' + esc(a.alt || p.name) + '"' + view +
        ' style="background-image:url(' + t.file + ');background-size:' + (t.cols * 100) + '% ' + (t.rows * 100) + '%;' +
        'background-position:' + px.toFixed(4) + '% ' + py.toFixed(4) + '%"></span>';
    }
    return '<img src="' + p.img + '" alt="' + esc(a.alt || '') + '"' +
      (a.cls ? ' class="' + a.cls + '"' : '') + view + (a.eager ? '' : ' loading="lazy"') + '>';
  }
  function priceBlock(p, cls) {
    if (noPrice(p)) {
      return '<div class="price price-ask' + (cls ? ' ' + cls : '') + '">Цена по запросу</div>';
    }
    return '<div class="price' + (cls ? ' ' + cls : '') + '">' + fmt(p.price) + ' ₽' +
      (p.old ? '<small>' + fmt(p.old) + ' ₽</small>' : '') + saleOff(p) + '</div>';
  }
  function specsShort(p) {
    var s = [];
    if (p.res) s.push('<span>Ресурс <b>' + fmt(p.res) + ' стр.</b></span>');
    if (p.color) s.push('<span><b>' + esc(C.colorTitle(p.color)) + '</b></span>');
    if (p.chip === true) s.push('<span><b>С чипом</b></span>'); else if (p.chip === false) s.push('<span><b>Без чипа</b></span>');
    if (!p.res && p.type) s.push('<span><b>' + esc(p.type) + '</b></span>');
    return s.join('');
  }
  function cmpLabel(id) { return S.cmp[id] ? 'В сравнении' : 'Сравнить'; }
  /* Количество на карточке товара: одно место, где оно читается и пишется. */
  function pickedQty() { var pq = document.getElementById('pq'); return pq ? Math.max(1, +pq.textContent || 1) : 1; }
  function setQty(q) {
    var pq = document.getElementById('pq'); if (!pq) return;
    q = Math.max(1, q | 0);
    pq.textContent = q;
    var minus = document.querySelector('[data-q="-1"]'); if (minus) minus.disabled = q <= 1;
    var box = document.getElementById('qsum');
    if (box) {
      var unit = +pq.dataset.price || 0;
      box.querySelector('[data-qs-q]').textContent = q;
      box.querySelector('[data-qs-t]').textContent = fmt(unit * q) + ' ₽';
    }
    syncBuybar();
  }
  /* В закреплённой панели всегда видны товар, выбранное количество и итог.
     Она использует то же количество и ту же кнопку покупки, что и карточка. */
  function syncBuybar() {
    var bar = document.getElementById('buybar');
    if (!bar) return;
    var q = pickedQty();
    var qEl = bar.querySelector('[data-bb-q]');
    if (qEl) qEl.textContent = q + ' шт.';
    var totalEl = bar.querySelector('[data-bb-total]');
    if (totalEl) totalEl.textContent = fmt((+bar.dataset.price || 0) * q) + ' ₽';
    var inEl = bar.querySelector('[data-bb-in]');
    var btn = bar.querySelector('[data-add]');
    if (btn) btn.setAttribute('aria-label', 'Добавить в корзину: ' + bar.dataset.name +
      ', ' + q + ' шт. на ' + fmt((+bar.dataset.price || 0) * q) + ' ₽');
    if (inEl && btn) {
      var n = S.cart[btn.dataset.add] || 0;
      inEl.hidden = !n;
      inEl.innerHTML = n ? '<i>в корзине</i><b>' + n + '</b>' : '';
    }
  }
  function card(p) {
    var fav = S.fav[p.id] ? ' on' : '', cmp = S.cmp[p.id] ? ' on' : '';
    var reviewStats = realStats(p);
    return '<div class="card" data-id="' + p.id + '">' +
      '<a class="cmedia" href="' + link.product(p) + '">' + imgHtml(p, { alt: p.name }) + (badge(p) ? '<div class="cbadges">' + badge(p) + '</div>' : '') + '<span class="cbrand" title="Для принтеров ' + esc(C.brandName(p.brand)) + '">' + brandLogo(p.brand, 16) + '</span></a>' +
      '<div class="cacts"><button class="ibtn fav' + fav + '" type="button" data-fav="' + p.id + '" title="' + (S.fav[p.id] ? 'Убрать из избранного' : 'В избранное') + '" aria-label="' + (S.fav[p.id] ? 'Убрать из избранного' : 'В избранное') + '">' + ic('heart', 18) + '</button></div>' +
      '<div class="cbody"><a class="ctitle" href="' + link.product(p) + '">' + esc(p.name) + '</a>' +
      /* Звёзды показываются только там, где за ними есть настоящие
         отзывы. Пустые звёзды рядом с нулём читаются как «оценили на
         ноль», а не как «ещё не оценивали». */
      (reviewStats.count > 0
        ? '<div class="crate">' + stars(reviewStats.rate) + '<span>' + ratef(reviewStats.rate) + '</span><a href="' + link.product(p, { tab: 'reviews' }) + '"><span class="rn">' + reviewStats.count + '</span><span class="rw"> ' + plural(reviewStats.count, 'отзыв', 'отзыва', 'отзывов') + '</span></a></div>'
        : '<div class="crate crate-none"><a href="' + link.product(p, { tab: 'reviews' }) + '">Отзывы</a></div>') +
      '<div class="cspecs">' + specsShort(p) + '</div>' +
      (p.stock ? '<div class="avail"><i></i>В наличии</div>' : '<div class="avail out"><i></i>Нет в наличии</div>') + '</div>' +
      /* Цена и кнопки — отдельный блок, а не хвост описания: в виде списком он
         становится третьей колонкой карточки, в плитке просто идёт следом. */
      '<div class="cside"><div class="cfoot">' + priceBlock(p) +
      (!p.stock ? stockAlertButton(p, 'btn-o') : noPrice(p)
        ? '<a class="btn btn-o" href="' + link.page('contacts') + '">' + ic('phone', 18) + 'Запросить</a>'
        : '<button class="btn btn-y" type="button" data-add="' + p.id + '">' + ic('cart', 18) + 'В корзину</button>') + '</div>' +
      /* Иконка в углу карточки читалась как декорация — сравнение получило
         подпись и место в нижнем ряду, рядом с покупкой в один клик. */
      '<div class="cbot">' + (!p.stock ? '<span class="oneclick oneclick-off">Ожидаем поступление</span>' : noPrice(p) ? '<span class="oneclick oneclick-off">Цену уточняет менеджер</span>' : '<button class="oneclick" type="button" data-quick="' + p.id + '" data-qty="1">Купить в 1 клик</button>') +
      '<button class="cmp-b' + cmp + '" type="button" data-cmp="' + p.id + '" aria-pressed="' + !!S.cmp[p.id] + '" title="' + cmpLabel(p.id) + '" aria-label="' + cmpLabel(p.id) + ' — ' + esc(p.name) + '">' +
      ic('compare', 16) + '<span>' + cmpLabel(p.id) + '</span></button></div></div></div>';
  }
  function crumbs(items) {
    return '<div class="crumbs">' + items.map(function (it, i) {
      return (i ? ic('chev-right', 14) : '') + (it[1] ? '<a href="' + it[1] + '">' + esc(it[0]) + '</a>' : '<span>' + esc(it[0]) + '</span>');
    }).join('') + '</div>';
  }
  function sideCats(active, brand) {
    return '<div class="sbox"><div class="stitle">Категории</div><div class="slist">' + C.cats.map(function (c) {
      var on = active === c.id;
      return '<a class="' + (on ? 'on' : '') + '" href="' + link.catalog(c.id) + '">' + esc(c.name) + ic(on ? 'chev-down' : 'chev-right', 16) + '</a>' +
        (on && c.id === 'laser' ? '<div class="sub">' + C.site.laserBrands.map(function (b) {
          return '<a class="' + (brand === b ? 'on' : '') + '" href="' + link.catalog('laser', b) + '">' + esc(C.brandName(b)) + '</a>';
        }).join('') + '</div>' : '');
    }).join('') + '</div></div>';
  }
  function sideInfo() {
    return '<div class="sbox"><div class="stitle">Информация</div><div class="slist">' + C.site.pages.filter(function (p) { return p.menu; }).map(function (p) {
      return '<a href="' + link.page(p.id) + '">' + esc(p.title) + '</a>';
    }).join('') + '</div></div>' +
      '<div class="spromo"><b>Юрлицам и ИП</b><p>Счёт на оплату, закрывающие документы, доставка на адрес компании.</p><a class="btn btn-sm" href="' + link.page('business') + '">Условия для бизнеса</a></div>';
  }
  function advantages() {
    var a = [['truck', 'Доставка по всей России', 'Курьер по Москве, СДЭК до пункта выдачи по регионам', 'delivery'], ['card', 'Оплата при получении и по счёту', 'Наличными или картой курьеру, счёт с закрывающими документами', 'payment'], ['shield', 'Гарантия на расходники', 'Срок в карточке и документах, обмен при браке', 'warranty'], ['pin', 'Самовывоз в Москве', 'По предварительному согласованию с менеджером', 'contacts']];
    return '<div class="adv">' + a.map(function (x) {
      return '<a class="advi" href="' + link.page(x[3]) + '"><div class="ico">' + ic(x[0], 22) + '</div><div><b>' + x[1] + '</b><span>' + x[2] + '</span></div></a>';
    }).join('') + '</div>';
  }
  function finderForm(autofocus) {
    return '<form class="finder" id="finder-form"><select class="fsel" name="brand" aria-label="Бренд принтера"><option value="">Бренд принтера</option>' +
      C.site.laserBrands.map(function (b) { return '<option value="' + b + '">' + esc(C.brandName(b)) + '</option>'; }).join('') +
      '</select><div class="finp"><input type="text" name="q" placeholder="Модель, например M2135dn" aria-label="Модель принтера"' + (autofocus ? ' autofocus' : '') + '></div><button class="btn btn-y" type="submit">Подобрать</button></form>';
  }
  /*
    Отметки «Цены и наличие обновлены …» на витрине больше нет.

    Покупателю она ничего не решает: он и так видит цену и наличие, а
    дата с временем рядом с товаром читается как оговорка — «данные,
    возможно, устарели». Сама дата никуда не делась: она лежит в
    live/catalog-live.json и нужна для служебных проверок, просто не
    показывается публично.
  */
  /*
    Картинка раздела. У части разделов нет ни одного прототипного товара
    с локальным файлом — там сборщик кладёт адрес товара из атласа, и
    плитка рисуется тем же способом, что и карточка: фоном по ячейке.
    Горячих ссылок на сервер поставщика в плитках нет.
  */
  function catImg(c) {
    var t = c.imgId && C.thumb ? C.thumb(c.imgId) : null;
    if (t) {
      var px = t.cols > 1 ? (t.col / (t.cols - 1)) * 100 : 0;
      var py = t.rows > 1 ? (t.row / (t.rows - 1)) * 100 : 0;
      return '<span class="atimg" role="img" aria-label="' + esc(c.name) + '"' +
        ' style="background-image:url(' + t.file + ');background-size:' + (t.cols * 100) + '% ' + (t.rows * 100) + '%;' +
        'background-position:' + px.toFixed(4) + '% ' + py.toFixed(4) + '%"></span>';
    }
    return '<img src="' + (c.img || '/assets/img/no-photo.svg') + '" alt="" loading="lazy">';
  }

  function priceStamp() { return ''; }

  /* ---------------------------------------------------------- страницы */

  function home() {
    return C.featured().then(function (best) {
      var tags = ['HP LaserJet Pro M125', 'Kyocera M2135dn', 'Canon i-SENSYS MF3010', 'Brother HL-L2300', 'Samsung ML-2160', 'Xerox Phaser 3020', 'Pantum P2207', 'Ricoh SP 3400N', 'HP LaserJet 1018', 'Kyocera FS-1040', 'HP LJ Pro M104', 'Canon LBP6030', 'Brother DCP-L2500', 'Kyocera M2040dn', 'Xerox WorkCentre 3025', 'HP LJ Pro 400 M401', 'Epson L3150', 'Canon PIXMA G3411'];
      var tiles = C.cats.slice(0, 3).map(function (c) {
        return '<a class="tile" href="' + link.catalog(c.id) + '"><span class="ph">' + catImg(c) + '</span>' +
          '<span class="tt"><h3>' + esc(c.name) + '</h3><p>' + esc(c.desc) + '</p>' +
          '<span class="cta">' + c.count + ' ' + plural(c.count, 'товар', 'товара', 'товаров') + ic('arrow-right', 16) + '</span></span></a>';
      }).join('');
      var tilesS = C.cats.slice(3).map(function (c) {
        return '<a class="tile-s" href="' + link.catalog(c.id) + '"><span><b>' + esc(c.name) + '</b><span>' + esc(c.desc) + '</span></span><span class="ph">' + catImg(c) + '</span></a>';
      }).join('');
      var strip = C.brands.slice(0, 10).map(function (b) {
        return '<a href="' + link.catalog('laser', b.id) + '" title="' + esc(b.name) + '">' + brandLogo(b.id, 20, '') + '</a>';
      }).join('');
      var slides = [
        '<div class="slide s1 on"><div class="wrap"><div class="stext"><img class="slogo" src="/assets/img/hi-black-logo.svg" alt="Hi-Black"><div class="eyebrow"><i></i>Фирменный магазин Hi-Black</div><h1>Картридж для вашего принтера — <em>в наличии</em>, с гарантией ресурса</h1><p>Совместимые картриджи, тонеры и чернила Hi-Black для Brother, Canon, HP, Kyocera, Samsung, Xerox и ещё десяти брендов печатающей техники.</p>' + finderForm() + '<div class="hnote">Не знаете модель? Она указана на наклейке спереди или сзади принтера. <a href="' + link.plain('finder') + '">Как найти модель&nbsp;→</a></div></div></div></div>',
        '<div class="slide s2"><div class="wrap"><div class="stext"><img class="slogo" src="/assets/img/hi-black-logo.svg" alt="Hi-Black"><div class="eyebrow"><i></i>Hi-Black® — совместимые расходные материалы</div><h2>Расходники для <em>16 брендов</em> принтеров и МФУ</h2><p>Лазерные и струйные картриджи, тонеры, чернила, фотобумага и запчасти — со склада в Москве, с доставкой по всей России.</p><div class="sfeat"><div>' + ic('shield', 18) + 'Гарантия на расходники, обмен при браке</div><div>' + ic('check', 18) + 'Не нарушают патенты производителей принтеров</div><div>' + ic('refresh', 18) + 'Повторно заправляются и восстанавливаются</div><div>' + ic('truck', 18) + 'Отгрузка со склада в Москве, доставка по России</div></div><div class="sbtns"><a class="btn btn-y btn-lg" href="' + link.catalog('laser') + '">В каталог</a><a class="btn btn-lg btn-w" href="' + link.page('about') + '">О бренде</a></div></div></div></div>',
        '<div class="slide s3"><div class="wrap"><div class="stext"><img class="slogo" src="/assets/img/hi-black-logo.svg" alt="Hi-Black"><div class="eyebrow"><i></i>Юрлицам и сервисным центрам</div><h2>Счёт на оплату, документы <em>с заказом</em></h2><p>Оплата по счёту с НДС, закрывающие документы по ЭДО, доставка на адрес компании и персональный менеджер для парка техники.</p><div class="sbtns"><a class="btn btn-y btn-lg" href="' + link.page('business') + '">Условия для бизнеса</a><a class="btn btn-lg btn-w" href="' + link.page('contacts') + '">Контакты</a></div></div></div></div>',
      ];
      var ctrl = '<div class="sctrl"><div class="wrap"><div class="sdots">' + slides.map(function (_, i) { return '<button type="button" data-dot="' + i + '" class="' + (i === 0 ? 'on' : '') + '" aria-label="Слайд ' + (i + 1) + '"></button>'; }).join('') + '</div><div class="sarr"><button type="button" data-sl="-1" aria-label="Назад">' + ic('chev-left', 18) + '</button><button type="button" data-sl="1" aria-label="Вперёд">' + ic('chev-right', 18) + '</button></div></div></div>';
      return '<section class="hslider" id="slider">' + slides.join('') + ctrl + '</section><div class="wrap">' +
        '<div class="brandstrip"><span class="lbl">Подбор по бренду принтера</span><div class="logos">' + strip + '<a class="chip" href="' + link.catalog('laser') + '">Все ' + C.brands.length + ' брендов →</a></div></div>' +
        '<div class="layout"><aside class="side">' + sideCats('') + sideInfo() + '</aside><div class="content">' +
        '<div class="tiles">' + tiles + '</div><div class="tiles-s">' + tilesS + '</div>' +
        '<div class="sec"><div class="sec-head"><h2>Лучшие предложения</h2><a class="more" href="' + link.catalog('') + '">Все товары ' + ic('arrow-right', 18) + '</a></div><div class="grid4">' + best.map(card).join('') + '</div>' + priceStamp() + '</div>' +
        '<div class="sec">' + advantages() + '</div>' +
        '<div class="sec"><div class="sec-head"><h2>Популярные модели принтеров</h2><a class="more" href="' + link.page('compat') + '">Таблицы совместимости ' + ic('arrow-right', 18) + '</a></div><div class="tags">' + tags.map(function (t) {
          var q = t.split(' ').slice(-1)[0];
          return '<a class="chip" href="' + link.search(q) + '">' + esc(t) + '</a>';
        }).join('') + '<a class="chip chip-y" href="' + link.plain('finder') + '">Подбор по модели →</a></div></div>' +
        '<div class="sec"><div class="about"><div><h2>Hi-Black® — современные расходные материалы для офисной печатающей техники</h2><p>Hi-Black — один из крупнейших поставщиков совместимых картриджей, тонеров и чернил на рынке России. Продукция проходит контроль качества на каждом этапе производства, заправляется повторно и восстанавливается, не нарушает патенты производителей принтеров.</p><p>В фирменном магазине — полный ассортимент бренда с отгрузкой со склада в Москве, актуальные таблицы совместимости и подбор по модели принтера.</p><a class="btn btn-o" href="' + link.page('about') + '">О бренде Hi-Black</a></div><div class="lines">' + C.site.lines.map(function (l) {
          return '<a class="line-c" href="' + link.page('lines') + '"><b>' + esc(l[0]) + '</b><span>' + esc(l[1]) + '</span></a>';
        }).join('') + '</div></div></div>' +
        '</div></div></div>';
    });
  }

  function catalog(r) {
    var q = r.query, cat = r.cat || '', brand = r.brand || '';
    var base = q.q ? C.search(q.q) : Promise.resolve(C.all());
    return base.then(function (source) {
      var all = applyFilters(source, cat, brand, q);
      var sorted = sortList(all, q.sort, q.q);
      var pp = +(q.pp || 12), page = +(q.page || 1), acc = q.acc === '1';
      var start = acc ? 0 : (page - 1) * pp, end = page * pp, shown = sorted.slice(start, end);
      var pages = Math.max(1, Math.ceil(sorted.length / pp));
      var title = cat ? C.catName(cat) : (q.sale ? 'Акции и скидки' : (q.q ? 'Поиск: «' + q.q + '»' : 'Все товары'));
      if (brand) title += ' ' + C.brandName(brand);
      var cr = [['Главная', link.home()]];
      if (cat) cr.push([C.catName(cat), brand ? link.catalog(cat) : '']);
      if (brand) cr.push([C.brandName(brand), '']);
      if (!cat) cr.push([title, '']);

      var chips = '';
      if (cat === 'laser' || (!cat && !q.q && !q.sale)) {
        chips = '<div class="brands"><a class="chip ' + (!brand ? 'chip-on' : '') + '" href="' + link.catalog(cat || 'laser') + '">Все бренды</a>' +
          C.site.laserBrands.map(function (b) {
            /* Название лежит в отдельном span: на телефоне оно скрыто, потому что
               уже написано на логотипе, а доступное имя даёт aria-label. */
            var nm = esc(C.brandName(b));
            return '<a class="chip ' + (brand === b ? 'chip-on' : '') + '" href="' + link.catalog('laser', b) + '" aria-label="' + nm + '"' + (brand === b ? ' aria-current="true"' : '') + '>' +
              (C.brandLogo(b) ? brandLogo(b, 16, '') + '<span class="bname">' + nm + '</span>' : nm) + '</a>';
          }).join('') + '</div>';
      }

      function cnt(except, test) { return applyFilters(source, cat, brand, q, except).filter(test).length; }
      function chk(key, val, label, on, n, dot) {
        return '<label class="check' + (n === 0 && !on ? ' dis' : '') + '"><input type="checkbox" data-f="' + key + '" value="' + esc(val) + '"' + (on ? ' checked' : '') + '><i>' + (on ? ic('check', 14) : '') + '</i>' + (dot ? '<span class="dot" style="background:' + dot + '"></span>' : '') + esc(label) + '<span class="n">' + n + '</span></label>';
      }
      var resF = RES.map(function (rr) { return chk('res', rr.id, rr.name, list(q.res).indexOf(rr.id) >= 0, cnt('res', function (x) { return x.res != null && rr.t(x.res); })); }).join('');
      var colorF = COLORS.map(function (c) {
        var n = cnt('color', function (x) { return x.color === c; });
        return n || list(q.color).indexOf(c) >= 0 ? chk('color', c, c, list(q.color).indexOf(c) >= 0, n, COLOR_HEX[c]) : '';
      }).join('');
      var chipF = chk('chip', '1', 'С чипом', list(q.chip).indexOf('1') >= 0, cnt('chip', function (x) { return x.chip === true; })) +
        chk('chip', '0', 'Без чипа', list(q.chip).indexOf('0') >= 0, cnt('chip', function (x) { return x.chip === false; }));
      var types = {};
      applyFilters(source, cat, brand, q, 'type').forEach(function (x) { types[x.type] = (types[x.type] || 0) + 1; });
      list(q.type).forEach(function (t) { types[t] = types[t] || 0; });
      var typeF = Object.keys(types).sort().map(function (t) { return chk('type', t, t, list(q.type).indexOf(t) >= 0, types[t]); }).join('');
      var prices = applyFilters(source, cat, brand, q, 'price').filter(function (x) { return x.price > 0; }).map(function (x) { return x.price; });
      var pmin = prices.length ? Math.min.apply(null, prices) : 0, pmax = prices.length ? Math.max.apply(null, prices) : 0;

      var side = '<aside class="side' + (q.f === '1' ? ' open' : '') + '"><div class="side-head">Фильтры<button type="button" data-close-f aria-label="Закрыть фильтры">' + ic('close', 18) + '</button></div>' + sideCats(cat, brand) +
        '<div class="sbox fbox" style="padding:20px 20px 22px"><div class="filters">' +
        '<div class="fgroup"><div class="ft">Модель принтера</div><div class="field" style="height:44px;font-size:14px;gap:10px">' + ic('search', 16) + '<input type="text" data-f="q" value="' + esc(q.q || '') + '" placeholder="Например, M2135dn"></div></div>' +
        '<div class="fgroup"><div class="ft">Цена, ₽</div><div class="range"><div class="field"><span>от</span><input type="number" data-f="pmin" value="' + esc(q.pmin || '') + '" placeholder="' + pmin + '"></div><div class="field"><span>до</span><input type="number" data-f="pmax" value="' + esc(q.pmax || '') + '" placeholder="' + pmax + '"></div></div><div class="fhint">В выборке: ' + fmt(pmin) + ' – ' + fmt(pmax) + ' ₽</div></div>' +
        '<div class="fgroup"><div class="ft">Ресурс печати</div>' + resF + '</div>' +
        (colorF ? '<div class="fgroup"><div class="ft">Цвет</div>' + colorF + '</div>' : '') +
        (cat === 'laser' || !cat ? '<div class="fgroup"><div class="ft">Чип</div>' + chipF + '</div>' : '') +
        '<div class="fgroup"><div class="ft">Тип продукции</div>' + typeF + '</div>' +
        '<div class="fgroup" style="border:0;padding-bottom:6px"><label class="toggle">Только в наличии<input type="checkbox" data-f="stock" value="1"' + (q.stock ? ' checked' : '') + '><i></i></label></div>' +
        '<div class="fbtns"><button class="btn btn-y btn-full" type="button" data-close-f>Показать ' + sorted.length + ' ' + plural(sorted.length, 'товар', 'товара', 'товаров') + '</button><a class="btn btn-s btn-full btn-sm" href="' + link.catalog(cat, brand) + '">Сбросить фильтры</a></div>' +
        '</div></div>' + sideInfo() + '</aside>';

      var applied = [];
      if (brand) applied.push(['Бренд: ' + C.brandName(brand), link.catalog(cat)]);
      if (q.q) applied.push(['Поиск: ' + q.q, withQuery({ q: '', page: '' })]);
      if (q.pmin || q.pmax) applied.push(['Цена ' + (q.pmin ? 'от ' + q.pmin : '') + (q.pmax ? ' до ' + q.pmax : '') + ' ₽', withQuery({ pmin: '', pmax: '', page: '' })]);
      list(q.res).forEach(function (id) { var rr = RES.filter(function (k) { return k.id === id; })[0]; if (rr) applied.push(['Ресурс ' + rr.name, withQuery(toggleValue(q, 'res', id))]); });
      list(q.color).forEach(function (c) { applied.push([c, withQuery(toggleValue(q, 'color', c))]); });
      list(q.chip).forEach(function (c) { applied.push([c === '1' ? 'С чипом' : 'Без чипа', withQuery(toggleValue(q, 'chip', c))]); });
      list(q.type).forEach(function (t) { applied.push([t, withQuery(toggleValue(q, 'type', t))]); });
      if (q.stock) applied.push(['В наличии', withQuery({ stock: '', page: '' })]);
      if (q.sale) applied.push(['Со скидкой', withQuery({ sale: '', page: '' })]);
      var appliedHtml = applied.length ? '<div class="applied">' + applied.map(function (a) {
        return '<a class="chip" href="' + a[1] + '">' + esc(a[0]) + ' ' + ic('close', 14) + '</a>';
      }).join('') + '<a class="clear" href="' + link.catalog(cat) + '">Сбросить всё</a></div>' : '';

      var sortOpts = (q.q ? [['relevance', 'По релевантности']] : []).concat([['pop', 'По популярности'], ['price', 'Сначала дешевле'], ['-price', 'Сначала дороже'], ['rating', 'По рейтингу'], ['new', 'Новинки']]);
      var toolbar = '<div class="toolbar"><div class="l"><button class="sel mfilterbtn" type="button" data-open-f>' + ic('sliders', 18) + 'Фильтры' + (applied.length ? ' <i class="fn">' + applied.length + '</i>' : '') + '</button><label class="sel sel-sort' + ((q.sort && q.sort !== (q.q ? 'relevance' : 'pop')) ? ' picked' : '') + '">' + ic('sort', 18) + '<select data-f="sort" aria-label="Сортировка">' + sortOpts.map(function (o) {
        return '<option value="' + o[0] + '"' + ((q.sort || (q.q ? 'relevance' : 'pop')) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>' + ic('chev-down', 14) + '</label><label class="sel sel-pp"><select data-f="pp" aria-label="Товаров на странице">' + [12, 24, 48].map(function (n) {
        return '<option value="' + n + '"' + (pp === n ? ' selected' : '') + '>Показывать по ' + n + '</option>';
      }).join('') + '</select>' + ic('chev-down', 14) + '</label></div><div class="r">' +
        /* Счётчик сравнения один — в шапке. Здесь остаётся только выбор вида. */
        '<div class="view" role="group" aria-label="Вид каталога">' +
        '<button class="' + (S.view === 'tiles' ? 'on' : '') + '" type="button" data-view-mode="tiles" title="Показать плиткой" aria-label="Показать плиткой" aria-pressed="' + (S.view === 'tiles') + '">' + ic('grid', 18) + '</button>' +
        '<button class="' + (S.view === 'list' ? 'on' : '') + '" type="button" data-view-mode="list" title="Показать списком" aria-label="Показать списком" aria-pressed="' + (S.view === 'list') + '">' + ic('list', 18) + '</button>' +
        '</div></div></div>';

      var grid = shown.length ? '<div class="cards ' + (S.view === 'list' ? 'clist' : 'grid3') + '" id="cards">' + shown.map(card).join('') + '</div>' :
        '<div class="empty"><h3>Ничего не нашлось</h3><p>Попробуйте изменить фильтры или ввести другую модель принтера. Например, «M2135dn» или «CF283A».</p><a class="btn btn-o" href="' + link.catalog(cat) + '">Сбросить фильтры</a></div>';

      var pager = '';
      if (pages > 1) {
        var pl = [];
        for (var i = 1; i <= pages; i++) {
          if (pages > 7 && i > 3 && i < pages - 1 && Math.abs(i - page) > 1) { if (pl[pl.length - 1] !== '…') pl.push('…'); continue; }
          pl.push(i);
        }
        pager = '<div class="pager">' + (end < sorted.length ? '<a class="btn btn-o" href="' + withQuery({ page: page + 1, acc: '1' }) + '">' + ic('refresh', 18) + 'Показать ещё ' + Math.min(pp, sorted.length - end) + '</a>' : '<span></span>') +
          '<div class="pages">' + (page > 1 ? '<a href="' + withQuery({ page: page - 1, acc: '' }) + '" aria-label="Назад">' + ic('chev-left', 16) + '</a>' : '') +
          pl.map(function (n) { return n === '…' ? '<span>…</span>' : '<a class="' + (n === page ? 'on' : '') + '" href="' + withQuery({ page: n, acc: '' }) + '">' + n + '</a>'; }).join('') +
          (page < pages ? '<a href="' + withQuery({ page: page + 1, acc: '' }) + '" aria-label="Вперёд">' + ic('chev-right', 16) + '</a>' : '') + '</div></div>';
      }

      var c = cat ? C.cat(cat) : null;
      var seo = c ? '<div class="seo"><h3>' + esc(c.name) + ' Hi-Black' + (brand ? ' для ' + esc(C.brandName(brand)) : '') + '</h3><p>' + esc(c.seo) + '</p></div>' : '';

      return '<div class="wrap"><div class="ph1">' + crumbs(cr) + '<h1>' + esc(title) + ' <span>' + sorted.length + ' ' + plural(sorted.length, 'товар', 'товара', 'товаров') + '</span></h1>' + chips + '</div>' +
        '<div class="layout cat">' + side + '<div class="content">' + toolbar + appliedHtml + grid + pager + priceStamp() + seo + '</div></div></div>';
    });
  }

  function product(r) {
    var p = C.bySlug(r.slug) || C.byId(r.slug);
    if (!p) return notfound();
    return C.family(p.fam).then(function (fam) {
      var members = fam && fam.items && fam.items.length ? fam.items : [p];
      return Promise.all(members.map(function (x) { return C.detail(x.id); })).then(function (details) {
      var d = details[members.findIndex(function (x) { return x.id === p.id; })] ||
        { compat: '', models: [], specs: [], desc: '', reviews: [] };
      var tab = r.query.tab || 'desc';
      /* Похожие товары — тоже подборка: предлагать первым делом то,
         чего нет на складе, значит отправить покупателя в пустоту. */
      var related = sortList(C.all().filter(function (x) { return x.id !== p.id && x.brand === p.brand && x.cat === p.cat; }), '').slice(0, 4);
      if (related.length < 4) related = related.concat(sortList(C.all().filter(function (x) { return x.id !== p.id && x.cat === p.cat && related.indexOf(x) < 0; }), '').slice(0, 4 - related.length));
      /*
        В каталоге лежат только настоящие, прошедшие модерацию отзывы.
        Проверочных записей здесь больше нет: список пуст ровно тогда,
        когда отзывов нет, и карточка так и говорит.
      */
      var revs = [];
      details.forEach(function (detail, i) {
        (detail && detail.reviews || []).forEach(function (rv) {
          if (!rv || rv.demo) return;
          var copy = Object.assign({}, rv);
          if (members.length > 1) {
            copy.productColor = (fam.colors || [])[i] || C.colorTitle(members[i].color) || '';
            if (copy.productColor) copy.productCode = members[i].code;
            else copy.productVariant = members[i].code;
          }
          revs.push(copy);
        });
      });
      /*
        Демо и настоящие отзывы живут порознь и складываться не должны.
        Сводка считает только настоящие; демо-отзывы стоят отдельным
        показывает ровно то, что написали люди.
      */
      var revAvg = revs.length ? Math.round(revs.reduce(function (a, r) { return a + (r.rate || 0); }, 0) / revs.length * 10) / 10 : 0;
      var src = p.img;
      /*
        Для основного снимка атлас — запасной вариант, а не первый.

        В атласе лежит ячейка 240 пикселей: этого хватает карточке в
        списке, ради чего он и собирался, но в галерее такой кадр
        занимает всю колонку и выглядит мыльным. Если этап загрузки
        картинок (vtt:images) положил рядом полноразмерный файл, брать
        надо его — миниатюры при этом остаются миниатюрами.

        Прежний код смотрел только на наличие ячейки в атласе и потому
        показывал её даже там, где локальный оригинал уже лежал.
      */
      /*
        Ведущая косая черта здесь необязательна. На сайте адреса
        абсолютные («/assets/img/…»), а сборка превью переписывает их в
        относительные («assets/img/…»): корневые пути артефакт не
        отдаёт. Проверка на «^/assets/img/» проходила только на сайте, и
        в опубликованном превью полноразмерный файл молча проигрывал
        ячейке атласа.
      */
      var localFull = /^\/?assets\/img\//.test(String(p.img || '')) && !/no-photo/.test(String(p.img));
      var hasAtlas = !localFull && !!(C.thumb && C.thumb(p.id));
      /*
        Оригинал у поставщика — улучшение поверх ячейки, а не замена ей.
        Кладём его отдельной картинкой над атласом: загрузилась — видно
        полный снимок, не загрузилась (нет сети, закрыт хост, офлайн) —
        она убирает себя сама и остаётся ячейка. Список адресов задаёт
        сборка превью, в боевой сборке его нет.
      */
      var fullSrc = hasAtlas && window.HB_FULL_IMG ? window.HB_FULL_IMG[p.id] : null;
      /*
        Снимка у товара может не быть вовсе: поставщик присылает у таких
        позиций PhotoUrl «dummy.jpg», и в каталог уходит заглушка.

        Галерея этого не учитывала и всё равно добавляла два вида
        «Крупный план» — то есть увеличение серого прямоугольника, — и
        подпись «Открыть фото». Карточка обещала три снимка там, где нет
        ни одного. Теперь при отсутствии снимка остаётся только то, что
        действительно есть: сама заглушка и совместимость.
      */
      var noPhoto = !localFull && !hasAtlas;
      /*
        Кадры галереи — это снимки, а не куски одного снимка.

        Раньше здесь из единственного файла делали ещё два вида: тот же
        адрес с фоном, сдвинутым на 18 и на 82 процента. Получалось три
        миниатюры на одну фотографию, и человек, выбравший вторую, по
        «Открыть фото» видел первую. Это была не галерея, а обещание
        снимков, которых нет.

        Теперь список кадров приходит из данных (d.photos): сборка
        кладёт туда только те файлы, что действительно лежат в проекте.
        Поля нет — кадр ровно один, и галерея показывает одну
        фотографию, ничего не изображая.

        Совместимость кадром не считается: это сведения о товаре, и она
        по-прежнему идёт отдельным видом после снимков.
      */
      var frames = [];
      if (noPhoto) { /* нечего показывать: ниже встанет заглушка */ }
      else if (hasAtlas) frames.push({ atlas: true, src: '', alt: p.name });
      else {
        var list = (d.photos && d.photos.length) ? d.photos : [src];
        for (var fi = 0; fi < list.length; fi++) {
          var fsrc = String(list[fi] || '');
          if (!fsrc) continue;
          var dup = false;
          for (var fj = 0; fj < frames.length; fj++) if (frames[fj].src === fsrc) dup = true;
          if (dup) continue;
          frames.push({ src: fsrc, alt: p.name });
        }
      }
      /* Подпись кадра: один снимок — просто товар, несколько — с номером,
         чтобы читающий с экрана понимал, какой именно кадр открыт. */
      var shots = frames.length;
      /*
        Крупные планы возвращаются — но настоящими видами.

        Прежде их было два, и они ломались об одно: выбранный фрагмент
        открывался в увеличении общим кадром. Теперь фрагмент — это тот
        же файл с заданной точкой и масштабом, и увеличение открывает
        ровно её: крупный план стал местом на снимке, а не отдельной
        картинкой, которой нет.

        Добавляются они только к достаточно крупному снимку: на файле
        400×283 рассматривать во фрагменте нечего, и обещать это не
        надо. Размер приходит из данных — его меряет сборка.
      */
      var big = d.imgSize && Math.max(d.imgSize[0], d.imgSize[1]) >= 560;
      if (big && shots && !frames[0].atlas) {
        frames.push({ src: frames[0].src, alt: p.name, crop: { x: 0.2, y: 0.5 }, label: 'Крупный план, левая часть' });
        frames.push({ src: frames[0].src, alt: p.name, crop: { x: 0.8, y: 0.5 }, label: 'Крупный план, правая часть' });
      }
      frames.forEach(function (f, k) {
        if (f.crop) f.alt = p.name + ' — ' + f.label.toLowerCase();
        else if (shots > 1) f.alt = p.name + ' — фото ' + (k + 1) + ' из ' + shots;
      });
      var views = frames.map(function (f, k) { return { t: 'photo', f: k }; });
      gFrames = frames; gFrame = 0; gView = 0;
      var thumbs = views.map(function (v, i) {
        var f = frames[v.f], inner, title;
        if (f.crop) {
          inner = '<span class="tz" style="background-image:url(' + f.src + ');background-position:' +
            (f.crop.x * 100) + '% ' + (f.crop.y * 100) + '%"></span>';
          title = f.label;
        } else if (v.f === 0) { inner = imgHtml(p, { alt: '' }); title = shots > 1 ? 'Фото 1' : 'Фото товара'; }
        else { inner = '<img src="' + esc(f.src) + '" alt="" loading="lazy">'; title = 'Фото ' + (v.f + 1); }
        return '<div class="thumb ' + (i === 0 ? 'on' : '') + '" data-view="' + i + '" title="' + esc(title) + '">' + inner + '</div>';
      }).join('');
      /* Полоса из одной миниатюры ничего не переключает — не показываем её. */
      if (views.length < 2) thumbs = '';
      var key = [];
      if (p.res) key.push(['Ресурс', fmt(p.res) + ' страниц']);
      if (p.color) key.push(['Цвет', C.colorTitle(p.color)]);
      if (p.chip !== null) key.push(['Чип', p.chip ? 'Есть' : 'Нет']);
      if (p.type) key.push(['Тип', p.type]);
      /* «Оригинальный аналог» у импортированного товара берётся из
         OriginalNumber поставщика, а не собирается из бренда и артикула:
         собранная строка была бы догадкой. */
      /* Совпадение с собственным артикулом — не «аналог»: у VTT
         OriginalNumber часто повторяет NameAlias, и строка «Оригинальный
         аналог: HB-TK-8115C» сообщала бы, что товар аналог самого себя. */
      if (d.originalNumber && d.originalNumber !== p.code) key.push(['Оригинальный аналог', d.originalNumber]);
      else if (p.src !== 'vtt' && p.code && p.type !== 'Тонер') {
        key.push(['Оригинальный аналог', C.brandName(p.brand) + ' ' + p.code.replace(/^HB-/i, '')]);
      }
      /* Срок гарантии — обязательство магазина, а не поле выгрузки. Для
         импортированных позиций его здесь нет: подставлять чужому товару
         срок, которого никто не подтверждал, нельзя. */
      if (p.src !== 'vtt') key.push(['Гарантия', '12 месяцев']);
      /*
        Дополняем блок «Коротко о товаре» тем, что поставщик действительно
        передал. Раньше у импортированной позиции здесь стояли три строки
        (ресурс, цвет, тип), а колонка тянулась во всю высоту фотографии —
        и под ними зияла пустота в половину экрана.

        Берём из готовых характеристик карточки, а не собираем заново:
        так в короткий список не попадёт ничего, чего нет в полном. Что
        сюда не идёт: остатки склада (внутренние данные), габариты и вес
        (единицы в выгрузке не указаны) и всё, что уже показано выше.
      */
      var already = key.map(function (r) { return r[0]; });
      var pick = function (prefix, label) {
        for (var i = 0; i < (d.specs || []).length; i++) {
          var name = String(d.specs[i][0] || ''), val = String(d.specs[i][1] || '').trim();
          if (name.indexOf(prefix) !== 0 || !val) continue;
          if (already.indexOf(label) >= 0) return;
          var comma = name.indexOf(',');
          var unit = comma > 0 ? name.slice(comma + 1).trim() : '';
          key.push([label, unit ? val + ' ' + unit : val]);
          already.push(label);
          return;
        }
      };
      pick('Артикул', 'Артикул');
      pick('Для техники', 'Для техники');
      pick('Особенности', 'Особенности');
      pick('Объём', 'Объём');
      pick('В упаковке', 'В упаковке');
      pick('Штрихкод', 'Штрихкод');
      /*
        Совместимость — отдельный раздел карточки, а не кадр галереи.

        Раньше она стояла миниатюрой в ряду фотографий: нажал — и вместо
        снимка список моделей. У одного товара такая миниатюра была, у
        соседнего нет, и разницу объяснить было нечем: у первого перечень
        разобрался, у второго рассыпался. Плюс сам ряд обещал лишнюю
        фотографию там, где её нет.

        Теперь блок есть у КАЖДОГО товара, стоит на одном месте и выглядит
        одинаково. Отличается только содержимое, и ровно настолько,
        насколько отличаются данные: перечень моделей со ссылками на
        подбор; подтверждённое поставщиком назначение, если аппараты он не
        назвал; или единое «уточняйте по артикулу», когда нет и этого.
      */
      var compatBlock = (function () {
        var head = '<h3>Совместимые модели принтеров ' + brandLogo(p.brand, 18, '') + '</h3>';
        if (d.models.length) {
          var chips = d.models.map(function (m) {
            /* В чипе только обозначение аппарата. Марка написана в
               заголовке блока, а в перечне поставщика попадаются модели
               соседних марок — приписывать им марку товара нельзя. */
            return '<a class="chip" href="' + link.printer(printerKey(p.brand, m)) + '">' + esc(m) + '</a>';
          }).join('');
          return '<div class="compat"><h3>Совместимые модели принтеров ' + brandLogo(p.brand, 18, '') + '</h3>' +
            '<div class="tags">' + chips + '</div>' +
            '<p class="cnote">Перечень собран из данных поставщика по артикулу ' + esc(p.code) +
            '. Сверьте обозначение на корпусе аппарата — у близких моделей расходники отличаются.</p></div>';
        }
        if (d.fitNote) {
          return '<div class="compat compat-note">' + head +
            '<p class="cnote">' + esc(d.fitNote) + '</p>' +
            '<p class="cnote">Точную применимость подтвердим по артикулу ' + esc(p.code) +
            ' — напишите или позвоните. <a href="' + link.page('contacts') + '">Контакты</a></p></div>';
        }
        return '<div class="compat compat-note">' + head +
          '<p class="cnote">Совместимость уточняйте по артикулу ' + esc(p.code) +
          ': конкретные аппараты поставщик не назвал, а придумывать перечень мы не будем. ' +
          '<a href="' + link.page('contacts') + '">Напишите нам</a> — проверим по документации.</p></div>';
      })();
      var tabs = [['desc', 'Описание'], ['specs', 'Характеристики'],
        ['reviews', 'Отзывы' + (revs.length ? ' <i>' + revs.length + '</i>' : '')],
        ['delivery', 'Доставка и оплата']];
      var allSpecs = d.specs || [];
      var srow = function (x) { return '<div class="sr"><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b></div>'; };
      var specRows = allSpecs.map(srow).join('');
      var SHORT = 9;
      /* Компактный набор и полный список лежат рядом: раскрытие идёт на месте,
         без подгрузки и без перескока страницы, повторное нажатие сворачивает. */
      var specShort = allSpecs.slice(0, SHORT).map(srow).join('');
      var specMore = allSpecs.length > SHORT
        ? '<div class="sr-rest" hidden>' + allSpecs.slice(SHORT).map(srow).join('') + '</div>' +
          '<button class="spec-more" type="button" data-spec-more aria-expanded="false">' +
          '<span data-more-txt>Все характеристики (' + allSpecs.length + ')</span>' + ic('chev-down', 16) + '</button>'
        : '';

      /*
         Название товара — отдельная строка сетки во всю ширину контента:
         раньше оно жило в собственном блоке с max-width и на широком экране
         прижималось к левому краю, оставляя половину строки пустой.
      */
      return '<div class="wrap"><div class="ph1 pph">' + crumbs([['Главная', link.home()], [C.catName(p.cat), link.catalog(p.cat)], [C.brandName(p.brand), link.catalog(p.cat, p.brand)], [p.code, '']]) + '</div>' +
        '<div class="pgrid"><header class="phead">' +
        '<h1>' + esc(p.name) + '</h1>' +
        '<div class="pmeta">' +
        (revs.length
          ? '<span class="rate">' + stars(revAvg, 16) + '<b>' + ratef(revAvg) + '</b><a href="' + link.product(p, { tab: 'reviews' }) + '" data-tab-link="reviews">' + revs.length + ' ' + plural(revs.length, 'отзыв', 'отзыва', 'отзывов') + '</a></span>'
          : '<span class="rate rate-none"><a href="' + link.product(p, { tab: 'reviews' }) + '" data-tab-link="reviews">Отзывы</a></span>') +
        /* «Код товара» приходит из каталога, а не считается на месте хешем от
           адреса. Прежний способ менял код вместе с адресом: когда с витрины
           убрали повреждённую упаковку, 449 нормальных товаров переехали на
           освободившиеся адреса и сменили номер — покупатель, знавший
           670235, перестал находить товар. Теперь номер выдаётся один раз
           и живёт с товаром. */
        '<span>Артикул: <b>' + esc(p.code) + '</b></span><span>Код товара: <b>' + esc(String(p.no || '')) + '</b></span>' + badge(p) + '</div></header>' +
        /* Без снимка блок не кнопка: нажимать не на что, и роль button с
           подписью «Открыть фото крупнее» обманывала бы и мышь, и
           экранный диктор. */
        '<div class="gallery"><div class="gmain' + (hasAtlas ? ' has-atlas' : '') + (noPhoto ? ' no-photo' : '') + '" id="gmain"' +
        (noPhoto ? ' aria-label="Фото товара не передано поставщиком"' :
          ' role="button" tabindex="0" aria-label="Открыть фото крупнее: ' + esc(p.name) + '"') +
        ' data-src="' + (hasAtlas || noPhoto ? '' : src) + '">' + imgHtml(p, { alt: p.name, eager: true, view: 'img', noAtlas: localFull, cls: hasAtlas ? 'g-atlas-img' : '' }) +
        (fullSrc ? '<img class="g-full" data-full="' + esc(fullSrc) + '" alt="' + esc(p.name) + '" hidden>' : '') +
        /* Площадка для крупного плана: тот же файл, показанный вблизи.
           Пустая, пока фрагмент не выбран. */
        (big && shots && !frames[0].atlas ? '<div class="gzoom" data-gview="zoom" hidden></div>' : '') +
        (badge(p) ? '<div class="cbadges">' + badge(p) + '</div>' : '') + '<span class="gbrand">Для принтеров ' + brandLogo(p.brand, 16, '') + '</span>' +
        (noPhoto ? '<span class="gnote">' + ic('info', 15) + 'Поставщик не передал фото</span>'
          : '<span class="zoom">' + ic('zoom', 16) + 'Открыть фото</span>') + '</div>' + (thumbs ? '<div class="thumbs">' + thumbs + '</div>' : '') + '</div>' +
        '<div class="pinfo"><div class="keyspecs"><h3>Коротко о товаре</h3>' + key.map(function (k) { return '<div class="krow"><span>' + esc(k[0]) + '</span><b>' + esc(k[1]) + '</b></div>'; }).join('') + '</div>' +
        compatBlock +
        /*
          Ссылка на характеристики.

          Раньше она вела на «#» и открывала… вкладку «Описание»,
          дораскрывая в ней короткий список. Человек нажимал «Все
          характеристики» и оставался с описанием — ровно то, чего не
          просил. Теперь это настоящий адрес карточки с ?tab=specs:
          он открывает вкладку «Характеристики», переживает обновление
          страницы, работает с клавиатуры и в новой вкладке, а без
          скрипта просто загружает ту же страницу уже на нужной вкладке.
        */
        '<a class="allspecs" href="' + link.product(p, { tab: 'specs' }) + '" data-spec-jump>Все характеристики ' + ic('chev-down', 16) + '</a></div>' +
        /* Выбор цвета стоит первым в колонке покупки: цвет выбирают
           раньше количества, а на телефоне колонки складываются так, что
           этот блок оказывается сразу под фотографией — до цены и до
           кнопки, а не после них. */
        '<div class="buy"><div class="prow">' + priceBlock(p) + '<span class="per">за 1 шт.</span></div>' +
        (p.old && p.old > p.price ? '<div class="saveline">' + ic('percent', 16) + 'Скидка ' + fmt(p.old - p.price) + ' ₽ от прежней цены</div>' : '') +
        (p.stock ? '<div class="avail"><i></i>В наличии на складе в Москве</div><div class="stock">Дату отгрузки подтверждает менеджер</div>' : '<div class="avail out"><i></i>Нет в наличии</div><div class="stock">Срок поставки уточняйте у менеджера</div>') +
        (!p.stock
          ? '<div class="brow">' + stockAlertButton(p, 'btn-y btn-lg') + '</div>'
          : noPrice(p)
          ? '<div class="brow"><a class="btn btn-y btn-lg" href="' + link.page('contacts') + '">' + ic('phone', 22) + 'Запросить цену</a></div>' +
            '<div class="stock">Поставщик не передал цену на эту позицию — её подтверждает менеджер.</div>'
          : '<div class="brow"><div class="qty"><button type="button" data-q="-1" aria-label="Меньше" disabled>' + ic('minus', 18) + '</button><span id="pq" data-price="' + p.price + '">1</span><button type="button" data-q="1" aria-label="Больше">' + ic('plus', 18) + '</button></div><button class="btn btn-y btn-lg" type="button" data-add="' + p.id + '" data-useq="1">' + ic('cart', 22) + 'В корзину</button></div>') +
        /* Сумма считается от действующей цены и обновляется на месте: покупателю
           не приходится умножать в уме и гадать, что попадёт в корзину. */
        (!p.stock || noPrice(p) ? '' : '<div class="qsum" id="qsum" aria-live="polite">Итого за <b data-qs-q>1</b> шт.: <b data-qs-t>' + fmt(p.price) + ' ₽</b></div>') +
        /* «Купить в 1 клик» у товара без цены означало бы заказ на сумму,
           которой нет. Кнопки нет — есть запрос цены выше. */
        (!p.stock || noPrice(p) ? '' : '<button class="btn btn-o btn-full" type="button" data-quick="' + p.id + '">Купить в 1 клик</button>') +
        '<div class="acts"><button type="button" class="' + (S.cmp[p.id] ? 'on' : '') + '" data-cmp="' + p.id + '" aria-pressed="' + !!S.cmp[p.id] + '" title="' + (S.cmp[p.id] ? 'Убрать из сравнения' : 'Добавить к сравнению') + '">' + ic('compare', 16) + (S.cmp[p.id] ? 'В сравнении' : 'В сравнение') + '</button><button type="button" class="' + (S.fav[p.id] ? 'on' : '') + '" data-fav="' + p.id + '">' + ic('heart', 16) + (S.fav[p.id] ? 'В избранном' : 'В избранное') + '</button></div>' +
        '<div class="dlist"><div>' + ic('truck', 18) + '<div><b>Курьер по Москве</b><span>Дату и интервал подтверждает менеджер</span></div></div><div>' + ic('pin', 18) + '<div><b>Самовывоз по предварительному согласованию</b><span>Москва, Ясеневая ул., д. 50</span></div></div><div>' + ic('card', 18) + '<div><b>Оплата при получении или по счёту</b><span>Наличными или картой курьеру; юрлицам — счёт и документы</span></div></div><div>' + ic('shield', 18) + '<div><b>Гарантия ресурса</b><span>Срок указан в карточке и документах</span></div></div></div>' +
        (maxCfg()
          ? maxEl('ask-max', 'Написать о товаре ' + p.name + ' в мессенджере MAX, откроется в новой вкладке',
              maxIcon(26) + '<div><b>Написать в MAX</b>' +
              (maxOn()
                ? '<span>Спросим наличие, совместимость и сроки</span>'
                : '<span class="maxnote">' + maxPending() + '</span>') +
              '</div>' + (maxOn() ? ic('external', 16, 'ic ext') : ''))
          : '<a class="ask" href="' + link.page('contacts') + '">' + ic('chat', 22) + '<div><b>Задать вопрос о товаре</b><span>Ответим в чате или по телефону</span></div></a>') + '</div></div>' +
        variantsBlock(fam, p) +
        /* Роли вкладок проставлены явно: по ним экранный диктор
           объявляет, какая панель открыта, а `aria-controls` связывает
           кнопку с её содержимым. */
        '<div class="tabs" id="ptabs" role="tablist">' + tabs.map(function (t) {
          return '<button type="button" role="tab" id="tab-' + t[0] + '" aria-controls="panel-' + t[0] + '"' +
            ' aria-selected="' + (tab === t[0] ? 'true' : 'false') + '" class="' + (tab === t[0] ? 'on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="tabbody">' +
        '<div data-panel="desc" id="panel-desc" role="tabpanel" aria-labelledby="tab-desc"' + (tab !== 'desc' ? ' hidden' : '') + ' class="desc-grid"><div class="desc">' + d.desc + '</div><div class="spec-t"><div class="sh">Основные характеристики</div>' + specShort + specMore + '</div></div>' +
        '<div data-panel="specs" id="panel-specs" role="tabpanel" aria-labelledby="tab-specs"' + (tab !== 'specs' ? ' hidden' : '') + '><div class="spec-t spec-full"><div class="sh">Характеристики</div>' + specRows + '</div></div>' +
        /*
          Отзывы.

          Их может не быть — и это нормальное состояние карточки, а не
          дырка, которую надо чем-то закрыть. Раньше здесь показывались
          записи, собранные сборщиком из десяти заготовок: имя, город,
          «покупка подтверждена», «отзыв полезен?». Покупателя это
          обманывало дважды — и текстом, и звёздами, которые шли в
          рейтинг и в микроразметку.

          Теперь правило простое: показывается только то, что пришло от
          настоящих людей и прошло модерацию. Нет таких записей — так и
          написано. «Покупка подтверждена» ставится исключительно там,
          где источник это подтвердил (rv.verified), а не всем подряд.
        */
        '<div data-panel="reviews" id="panel-reviews" role="tabpanel" aria-labelledby="tab-reviews"' + (tab !== 'reviews' ? ' hidden' : '') + '>' +
        '<div class="rev-grid">' +
        (revs.length
          ? '<div class="rev-sum"><div class="big"><b>' + ratef(revAvg) + '</b><span>из 5</span></div>' + stars(revAvg, 20) +
            '<div class="cnt">' + revs.length + ' ' + plural(revs.length, 'отзыв', 'отзыва', 'отзывов') + '</div>' +
            '<div class="bars">' + [5, 4, 3, 2, 1].map(function (n) {
              var c = revs.filter(function (r) { return Math.round(r.rate) === n; }).length;
              return '<div><span>' + n + '</span><i style="--w:' + Math.round(c / revs.length * 100) + '%"></i><span>' + c + '</span></div>';
            }).join('') + '</div>' +
            '<button class="btn btn-k btn-full" type="button" data-scroll="#rev-form">Написать отзыв</button></div>'
          : '<div class="rev-sum rev-sum-empty"><div class="rev-none">' + ic('chat', 28) +
            '<b>Отзывов пока нет</b>' +
            '<span>Расскажите о товаре первым — это поможет другим покупателям.</span></div>' +
            '<button class="btn btn-k btn-full" type="button" data-scroll="#rev-form">Написать отзыв</button></div>') +
        '<div class="rev-list">' +
        revs.map(function (rv) {
          var name = rv.name || 'Покупатель';
          return '<article class="rev"><div class="rh"><div class="who"><span class="ava">' + esc(name.slice(0, 1)) + '</span><div><b>' + esc(name) + '</b><span>' +
            (rv.city ? esc(rv.city) : '') +
            (rv.productColor ? (rv.city ? ' · ' : '') + 'Цвет: ' + esc(rv.productColor) +
              (rv.productCode ? ' · ' + esc(rv.productCode) : '') : '') +
            (rv.productVariant ? (rv.city ? ' · ' : '') + 'Вариант: ' + esc(rv.productVariant) : '') +
            /* Подтверждение покупки — факт из источника, а не оформление.
               Без подтверждения отметки нет вовсе. */
            (rv.verified ? (rv.city ? ' · ' : '') + '<span class="ver">' + ic('check', 12) + 'Покупка подтверждена</span>' : '') +
            '</span></div></div>' + (rv.date ? '<span class="date">' + esc(rv.date) + '</span>' : '') + '</div>' +
            (rv.rate ? '<div class="rt">' + stars(rv.rate) + (rv.printer ? '<span>Принтер: ' + esc(rv.printer) + '</span>' : '') + '</div>' : '') +
            '<p>' + esc(rv.text || '') + '</p>' +
            (rv.plus || rv.minus ? '<div class="pm">' + (rv.plus ? '<div><b>Достоинства</b>' + esc(rv.plus) + '</div>' : '') + (rv.minus ? '<div><b>Недостатки</b>' + esc(rv.minus) + '</div>' : '') + '</div>' : '') +
            (rv.reply ? '<div class="rreply"><b>Ответ магазина</b><p>' + esc(typeof rv.reply === 'string' ? rv.reply : rv.reply.text) + '</p></div>' : '') +
            '</article>';
        }).join('') +
        /*
          Форма отзыва отправляет данные на сервер (POST /api/review) и
          сообщает ровно то, что произошло. Раньше она писала «Спасибо»
          сразу по нажатию, не отправив ничего и ничего не сохранив, —
          отзыв исчезал, а человек был уверен, что он опубликован.

          В превью сервера нет вовсе, и форма об этом честно скажет
          после первой же попытки отправки, а не сделает вид, что всё
          получилось.
        */
        '<form class="rev-form" id="rev-form" data-rev-form="' + esc(p.id) + '" novalidate>' +
        '<h3>Оставить отзыв</h3>' +
        '<p>Расскажите, как расходник работает на вашем принтере — это поможет другим покупателям.</p>' +
        /*
          Оценка не выбрана заранее.

          Раньше здесь стояла пятёрка «по умолчанию»: форма открывалась с
          отмеченной 5, и человек, который её не трогал, отправлял отзыв с
          оценкой, которую не ставил. Такие пятёрки — не мнение о товаре, а
          нетронутый переключатель, но в среднем рейтинге они неотличимы от
          настоящих.

          Теперь оценку выбирают явно, а без неё форма не отправляется и
          прямо об этом говорит. Проверка продублирована на сервере:
          клиентскую обходит кто угодно, а пустую оценку в очереди
          модерации потом не отличить от намеренной.
        */
        '<div class="frate" role="radiogroup" aria-label="Оценка от 1 до 5" aria-required="true"' +
        ' id="rev-rate" aria-describedby="rev-rate-note">' +
        '<span class="flabel">Оценка</span>' +
        [1, 2, 3, 4, 5].map(function (n) {
          return '<label class="fstar"><input type="radio" name="rate" value="' + n + '"><span>' + n + '</span></label>';
        }).join('') +
        '<span class="fhint" id="rev-rate-note">от 1 до 5, обязательно</span></div>' +
        /*
          Поле e-mail появилось не для красоты. Под формой стояла подпись
          «Ваш email не публикуется», а самого поля не было: обещание
          относилось к тому, чего форма не спрашивала. Теперь адрес
          спрашивается явно, он обязателен — по нему модератор возвращается
          к автору, если отзыв нужно уточнить, — и на витрину он не идёт.

          Подписи у полей настоящие, а не только placeholder: placeholder
          исчезает при первом же символе, и человек перестаёт понимать, что
          он сейчас заполняет.
        */
        '<div class="row"><label class="rfield"><span class="flabel">Ваше имя</span>' +
        '<input type="text" name="name" maxlength="80" autocomplete="name" placeholder="Как вас подписать" required></label>' +
        '<label class="rfield"><span class="flabel">E-mail</span>' +
        '<input type="email" name="email" maxlength="120" autocomplete="email" inputmode="email" placeholder="name@example.ru" required' +
        ' aria-describedby="rev-email-note"></label></div>' +
        '<label class="rfield rfield-wide"><span class="flabel">Модель принтера <i>необязательно</i></span>' +
        '<input type="text" name="printer" maxlength="80" placeholder="Например, Kyocera Ecosys M8130cidn"></label>' +
        '<label class="rfield rfield-wide"><span class="flabel">Отзыв</span>' +
        '<textarea name="text" maxlength="2000" placeholder="Достоинства, недостатки, впечатления от печати" required></textarea></label>' +
        '<div class="fbtn"><button class="btn btn-y" type="submit">Отправить отзыв</button>' +
        '<span id="rev-email-note">Отзыв появится на странице после проверки модератором. ' +
        'E-mail нужен только для связи с вами по этому отзыву: он не публикуется и не попадает в рассылку.</span></div>' +
        '<div class="rev-msg" id="rev-msg" role="status" aria-live="polite" hidden></div>' +
        /* Три закрывающих тега: форма, .rev-list, .rev-grid — и четвёртый
           на саму панель. Без него следующая панель оказывалась ВНУТРИ
           этой, а панель отзывов скрыта, пока открыта другая вкладка: так
           «Доставка и оплата» не показывала ничего. */
        '</form></div></div></div>' +
        '<div data-panel="delivery" id="panel-delivery" role="tabpanel" aria-labelledby="tab-delivery"' + (tab !== 'delivery' ? ' hidden' : '') + '>' +
        deliveryPanel() + '</div>' +
        '</div>' +
        '<div class="sec"><div class="sec-head"><h2>Похожие товары</h2><a class="more" href="' + link.catalog(p.cat, p.brand) + '">Все для ' + esc(C.brandName(p.brand)) + ' ' + ic('arrow-right', 18) + '</a></div><div class="grid4">' + related.map(card).join('') + '</div></div>' +
        /* Закреплённая панель покупки. Кнопка несёт те же data-add и data-useq,
           что и штатная, поэтому добавляет тот же товар в том же количестве —
           одна и та же ветка обработчика, без параллельной логики. */
        '<div class="buybar" id="buybar" role="region" aria-hidden="true"' +
          ' aria-label="Быстрая покупка: ' + esc(p.name) + '" data-name="' + esc(p.name) +
          '" data-price="' + (p.price || 0) + '">' +
          '<div class="bbinfo"><div class="bbproduct">' +
            '<b class="bbname" title="' + esc(p.name) + '">' + esc(p.name) + '</b>' +
            (p.code && String(p.code).length <= 32 ? '<span class="bbcode">Артикул: ' + esc(p.code) + '</span>' : '') +
          '</div><div class="bbterms">' +
            (p.stock ? '<span>Добавим <b data-bb-q>1 шт.</b></span>' +
              (noPrice(p) ? '<span>Цена по запросу</span>' : '<span>Итого <b data-bb-total>' + fmt(p.price) + ' ₽</b></span>') : '') +
            '<span class="bin" data-bb-in hidden></span>' +
            (p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Нет в наличии</span>') +
          '</div></div>' +
          (!p.stock ? stockAlertButton(p, 'btn-y') : noPrice(p)
            ? '<a class="btn btn-o" href="' + link.page('contacts') + '" aria-label="Запросить цену: ' + esc(p.name) + '">' +
              ic('phone', 18) + '<span class="bt">Запросить цену</span></a>'
            : '<button class="btn btn-y" type="button" data-add="' + p.id + '" data-useq="1"' +
              ' aria-label="Добавить в корзину: ' + esc(p.name) + '">' +
              ic('cart', 18) + '<span class="bt">В корзину</span></button>') +
        '</div></div>';
      });
    });
  }

  /*
    Цвета серии.

    Блок один и стоит сразу под карточкой. Раньше их было два: переключатель
    в колонке покупки и «Комплект из 4 цветов» ниже — одни и те же четыре
    товара дважды на одном экране.

    Каждый цвет — отдельный товар со своей ценой, своим наличием и своим
    адресом, поэтому у плитки две самостоятельные части: ссылка на карточку
    (фото, цвет, артикул) и кнопка, которая кладёт в корзину именно этот
    цвет. Кнопка не внутри ссылки намеренно: вложенная в ссылку кнопка
    ведёт себя непредсказуемо и с клавиатуры, и на телефоне.

    Остатков в штуках здесь нет. Покупателю хватает «в наличии» или «под
    заказ», а числа со склада — внутренние данные, которые к тому же
    устаревают между выгрузками.

    Покупка всего набора осталась, но только когда она честная: если
    какого-то цвета нет, кнопка прямо говорит, сколько из скольких положит.
  */
  function variantsBlock(fam, current) {
    if (!fam || !fam.items || fam.items.length < 2) return '';
    var labels = fam.colors || [];
    var inStock = fam.items.filter(function (x) { return x.stock; });
    var priced = fam.items.filter(function (x) { return x.price > 0; });
    var sumAll = priced.reduce(function (a, x) { return a + x.price; }, 0);
    var sumStock = inStock.filter(function (x) { return x.price > 0; }).reduce(function (a, x) { return a + x.price; }, 0);

    var tiles = fam.items.map(function (x, i) {
      var here = x.id === current.id;
      return '<article class="var' + (here ? ' on' : '') + (x.stock ? '' : ' out') + '">' +
        (here ? '<span class="var-here">Вы смотрите</span>' : '') +
        '<a class="var-top" href="' + link.product(x) + '"' + (here ? ' aria-current="page"' : '') + '>' +
          '<span class="var-img">' + imgHtml(x, { alt: '' }) + '</span>' +
          '<span class="var-c"><b>' + esc(labels[i] || x.color || 'Цвет') + '</b><span>' + esc(x.code) + '</span></span>' +
        '</a>' +
        '<div class="var-b">' +
          '<div class="var-p">' + (x.price > 0 ? fmt(x.price) + ' ₽' : 'Цена по запросу') + '</div>' +
          '<div class="var-s' + (x.stock ? '' : ' out') + '"><i></i>' + (x.stock ? 'В наличии' : 'Нет в наличии') + '</div>' +
          (!x.stock ? stockAlertButton(x, 'btn-o var-add') : x.price > 0
            ? '<button class="btn btn-y var-add" type="button" data-add="' + x.id + '"' +
              ' aria-label="Добавить в корзину: ' + esc(x.name) + '">' + ic('cart', 16) + 'В корзину</button>'
            : '<a class="btn btn-o var-add" href="' + link.page('contacts') + '">Запросить цену</a>') +
        '</div></article>';
    }).join('');

    var missing = fam.items.filter(function (x) { return !x.stock; });
    var note = missing.length
      ? '<p class="vars-note">' + ic('info', 16) + (missing.length === 1
          ? 'Одного цвета сейчас нет на складе — можно запросить уведомление о поступлении.'
          : missing.length + ' ' + plural(missing.length, 'цвета', 'цветов', 'цветов') + ' сейчас нет на складе — можно запросить уведомление о поступлении.') + '</p>'
      : '';
    /* Кнопка на весь набор появляется, только когда у всех цветов есть
       цена: иначе «весь комплект за N ₽» — сумма не за то, что положат. */
    var kit = priced.length === fam.items.length && inStock.length
      ? '<div class="vars-foot"><div class="vars-sum">' +
          (missing.length ? 'В наличии ' + inStock.length + ' из ' + fam.items.length : 'Весь набор') +
          '<b>' + fmt(missing.length ? sumStock : sumAll) + ' ₽</b></div>' +
          '<button class="btn btn-k" type="button" data-kit="' + fam.id + '">' + ic('cart', 18) +
          (missing.length ? 'Добавить ' + inStock.length + ' из ' + fam.items.length : 'Весь набор в корзину') + '</button></div>'
      : '';

    return '<section class="vars" id="vars"><div class="vars-h">' +
      '<h2>Все цвета рядом</h2>' +
      '<p>' + (fam.series ? 'Серия ' + esc(fam.series) + '. ' : '') +
      esc(String(fam.label || '').replace(/\.$/, '')) + '. Каждый цвет продаётся отдельно.</p></div>' +
      '<div class="vars-l">' + tiles + '</div>' + note + kit + '</section>';
  }

  function printerKey(brand, model) {
    var TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
    return (C.brandName(brand) + ' ' + model).toLowerCase().replace(/[а-яё]/g, function (c) { return TR[c] ?? c; }).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* Страница под модель принтера — то, ради чего каталог вообще индексируется. */
  function printer(r) {
    return C.printer(r.key).then(function (info) {
      if (!info) return notfound();
      /* Наличие первым ключом и здесь: подбор по принтеру — такая же
         товарная подборка, и начинаться она обязана с того, что можно
         купить сегодня. */
      var items = sortList(info.products.filter(Boolean), '');
      var byCat = {};
      items.forEach(function (p) { (byCat[p.cat] ||= []).push(p); });
      return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Подбор по принтеру', link.plain('finder')], [info.label, '']]) +
        '<h1>Расходные материалы для ' + esc(info.label) + ' <span>' + items.length + ' ' + plural(items.length, 'товар', 'товара', 'товаров') + '</span></h1>' +
        '<p class="lead">Картриджи, тонеры и запчасти Hi-Black, которые подходят к ' + esc(info.label) + '. Совместимость проверена по таблицам производителя, ресурс соответствует оригинальному расходнику.</p></div>' +
        '<div class="layout"><aside class="side">' + sideCats('') + sideInfo() + '</aside><div class="content">' +
        Object.keys(byCat).map(function (cid) {
          return '<div class="sec" style="margin-top:0"><div class="sec-head"><h2>' + esc(C.catName(cid)) + '</h2><a class="more" href="' + link.catalog(cid, info.brand) + '">Все для ' + esc(C.brandName(info.brand)) + ' ' + ic('arrow-right', 18) + '</a></div><div class="grid3">' + byCat[cid].map(card).join('') + '</div></div>';
        }).join('') + priceStamp() +
        '<div class="sec">' + advantages() + '</div>' +
        '<div class="seo"><h3>Как подобрать картридж для ' + esc(info.label) + '</h3><p>Модель принтера указана на передней панели или на наклейке сзади корпуса. Для ' + esc(info.label) + ' подходят перечисленные выше расходники Hi-Black: они повторяют оригинальный картридж по ресурсу и качеству печати, но стоят заметно дешевле. Если нужного варианта нет в наличии, напишите нам — подберём замену с тем же ресурсом.</p></div>' +
        '</div></div></div>';
    });
  }

  function cart() {
    var items = cartItems(), n = cartCount(), pricing = cartPricing(items);
    var sum = pricing.gross, promo = pricing.discount;
    var unavailable = items.filter(function (it) { return !it.p.stock; });
    if (!items.length) {
      return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Корзина', '']]) + '<h1>Корзина</h1></div><div class="empty big"><h3>В корзине пока пусто</h3><p>Подберите картридж по модели принтера или загляните в лучшие предложения.</p><div class="acts"><a class="btn btn-y" href="' + link.plain('finder') + '">Подобрать по принтеру</a><a class="btn btn-o" href="' + link.catalog('') + '">В каталог</a></div></div></div>';
    }
    var addon = C.all().filter(function (x) { return !S.cart[x.id] && x.stock && x.price > 0; }).slice(0, 3);
    var rows = items.map(function (it, index) {
      var p = it.p, line = pricing.lines[index];
      return '<div class="item"><a class="img" href="' + link.product(p) + '">' + imgHtml(p, {}) + '</a>' +
        '<div class="ibody"><a class="t" href="' + link.product(p) + '">' + esc(p.name) + '</a><div class="m"><span>Артикул ' + esc(p.code) + '</span>' + (p.res ? '<span>Ресурс ' + fmt(p.res) + ' стр.</span>' : '') + '<span>Для ' + brandLogo(p.brand, 12, '') + '</span>' + (p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Нет в наличии</span>') + '</div><div class="u">' + (promo ? 'До скидки ' : '') + fmt(p.price) + ' ₽ за шт.</div>' + (!p.stock ? stockAlertButton(p, 'btn-o') : '') + '</div>' +
        '<div class="ictl"><div class="qty"><button type="button" data-cq="' + p.id + '" data-d="-1" aria-label="Меньше">' + ic('minus', 18) + '</button><span>' + it.q + '</span><button type="button" data-cq="' + p.id + '" data-d="1" aria-label="Больше">' + ic('plus', 18) + '</button></div>' +
        /* Расчёт строки пишем целиком, включая одну штуку: покупателю не
           приходится держать в голове, откуда взялась сумма. */
        '<div class="sum"><small class="calc">' + it.q + ' шт. × ' + fmt(p.price) + ' ₽ = ' + fmt(line.gross) + ' ₽</small>' +
        (promo ? '<small class="disc">Скидка 5%: −' + fmt(line.discount) + ' ₽</small><del>' + fmt(line.gross) + ' ₽</del>' : '') +
        '<div class="price">' + fmt(line.net) + ' ₽</div></div></div>' +
        '<button class="rm" type="button" data-rm="' + p.id + '" aria-label="Удалить">' + ic('trash', 18) + '</button></div>';
    }).join('');
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Корзина', '']]) + '<h1>Корзина <span>' + n + ' ' + plural(n, 'товар', 'товара', 'товаров') + ' · ' + fmt(pricing.net) + ' ₽</span></h1>' +
      '<div class="steps"><div class="step on"><i>1</i><span>Корзина</span></div><div class="step"><i>2</i><span>Доставка и оплата</span></div><div class="step"><i>3</i><span>Подтверждение</span></div></div></div>' +
      '<div class="cgrid"><div class="clist"><div class="chead"><span>' + n + ' ' + plural(n, 'товар', 'товара', 'товаров') + '</span><div class="r"><a href="#" data-fav-all>' + ic('heart', 16) + 'Всё в избранное</a><a href="#" data-clear-cart>' + ic('trash', 16) + 'Очистить корзину</a></div></div>' + rows +
      '<div class="cfootr"><form class="promo" id="promo-form"><div class="field"><input type="text" name="promo" placeholder="Промокод" value="' + esc(S.promo || '') + '" aria-label="Промокод"></div><button class="btn btn-o" type="submit">Применить</button>' + (promo ? '<span class="ok">' + ic('check', 16) + 'Скидка 5% применена</span>' : (S.promoErr ? '<span class="err">Промокод не найден</span>' : '<span class="muted xs">Для теста: HIBLACK5</span>')) + '</form><a class="back" href="' + link.catalog('') + '">' + ic('chev-left', 16) + 'Продолжить покупки</a></div></div>' +
      '<div class="summary"><h3>Ваш заказ</h3><div class="srow"><span>Товары, ' + n + ' шт.</span><b>' + fmt(sum) + ' ₽</b></div><div class="srow"><span>Скидка 5%' + (promo ? ' · HIBLACK5' : '') + '</span><b>' + (promo ? '−' + fmt(promo) + ' ₽' : '0 ₽') + '</b></div><div class="srow"><span>Доставка</span><b class="soft">рассчитаем на следующем шаге</b></div><div class="srow total"><span>Итого</span><b>' + fmt(pricing.net) + ' ₽</b></div>' + (unavailable.length ? '<p class="cart-stock-warning">В корзине есть товар без наличия. Удалите его или подпишитесь на уведомление, чтобы оформить остальные товары.</p>' : '<a class="btn btn-y btn-lg btn-full" href="' + link.plain('checkout') + '">Оформить заказ' + ic('arrow-right', 20) + '</a>') + '<div class="payrow"><span>НАЛИЧНЫМИ</span><span>КАРТОЙ КУРЬЕРУ</span><span>ПО СЧЁТУ</span></div><div class="biz">' + ic('building', 20) + '<div><b>Заказ для компании?</b>На следующем шаге выберите «Юридическое лицо» — счёт придёт на почту, документы отдадим с заказом.</div></div><div class="note">Согласия на обработку персональных данных и условия оферты подтверждаются на шаге оформления — отдельными галочками.</div>' +
      maxEl('maxhelp', 'Задать вопрос по заказу в мессенджере MAX, откроется в новой вкладке',
        maxIcon(26) + '<span>Написать в MAX</span>' +
        (maxOn() ? '' : '<i class="maxnote">' + maxPending() + '</i>')) +
      '</div>' +
      '<div class="sec addon-sec"><div class="sec-head"><h3>Добавить к заказу</h3><a class="more" href="' + link.catalog('') + '">Ещё ' + ic('arrow-right', 18) + '</a></div><div class="addon">' + addon.map(function (p) {
        return '<div class="mini"><a class="img" href="' + link.product(p) + '">' + imgHtml(p, {}) + '</a><div class="mb"><a class="t" href="' + link.product(p) + '">' + esc(p.name) + '</a><div class="p"><div class="price">' + fmt(p.price) + ' ₽</div><button class="add" type="button" data-add="' + p.id + '" aria-label="В корзину">' + ic('plus', 18) + '</button></div></div></div>';
      }).join('') + '</div></div></div>' +
      '<div class="sec">' + advantages() + '</div></div>';
  }

  /*
    Тарифы и формулировки совпадают со страницей «Доставка». Там, где сумму
    считает менеджер (за МКАД, СДЭК), в цене стоит null: писать «бесплатно»
    или выдумывать число нельзя.
  */
  var DEL = [
    ['courier', 'Курьер по Москве в пределах МКАД', 'До подъезда, интервал 09:00–18:00. Дату и интервал подтверждает менеджер', 500],
    ['courier-out', 'Курьер за МКАД', '1 000 ₽ за первые 5 км от МКАД, далее 50 ₽ за километр. Итог подтверждает менеджер', null],
    ['cdek', 'СДЭК до пункта выдачи или постамата', 'По России, в выбранную вами точку. Стоимость — по тарифам СДЭК', null],
    ['pickup', 'Самовывоз по предварительному согласованию', 'Москва, Ясеневая ул., д. 50. Приезжайте после подтверждения менеджера', 0],
  ];
  var PAY = [
    ['cash', 'При получении', 'Наличными или картой курьеру магазина'],
    ['invoice', 'По счёту', 'Счёт придёт на почту. Организациям — закрывающие документы с заказом'],
  ];

  /*
    Вкладка «Доставка и оплата».

    Раньше здесь лежал абзац текста из site.json, а всё видное место
    занимал блок «Счёт для юридических лиц и ИП» — причём он стоял ВНЕ
    вкладок и потому висел под описанием и отзывами тоже. Покупатель,
    открывший вкладку, не находил ни способов доставки, ни способов
    оплаты: вкладка называлась одним, а показывала другое.

    Теперь способы доставки берутся из того же массива DEL, а оплаты —
    из PAY, по которым собран шаг оформления заказа. Разойтись им негде:
    это одни и те же данные, а не пересказ. Цену доставки показываем
    только там, где она в этих данных задана числом; где её считает
    менеджер — так и написано, без придуманных тарифов.
  */
  function deliveryRows(list) {
    return list.map(function (x) {
      var fixed = x[3] != null;
      var cost = fixed ? (x[3] ? fmt(x[3]) + ' ₽' : 'бесплатно') : 'рассчитает менеджер';
      return '<div class="drow"><div class="dr-t"><b>' + esc(x[1]) + '</b>' +
        '<span class="dr-c' + (fixed ? ' num' : '') + '">' + esc(cost) + '</span></div>' +
        '<span class="dr-d">' + esc(x[2]) + '</span></div>';
    }).join('');
  }
  function deliveryPanel() {
    var c = (C.site && C.site.contacts) || {};
    return '<div class="dlv">' +
      '<section class="dlv-b"><h3>' + ic('truck', 20) + 'Доставка</h3>' +
      '<div class="drows">' + deliveryRows(DEL) + '</div>' +
      /* Адрес самовывоза — уточнение к строке списка, а не отдельный
         раздел: отдельным он читался как второй самовывоз. */
      '<p class="dlv-n">Способ доставки выбирается на шаге оформления заказа — там же считается её стоимость. ' +
      'Самовывоз: ' + esc(c.address || '') + (c.metro ? ', метро ' + esc(c.metro) : '') +
      (c.pickupHours ? ', ' + esc(c.pickupHours) : '') + '.</p></section>' +

      '<section class="dlv-b"><h3>' + ic('card', 20) + 'Оплата</h3>' +
      '<div class="drows">' + PAY.map(function (x) {
        return '<div class="drow"><div class="dr-t"><b>' + esc(x[1]) + '</b></div>' +
          '<span class="dr-d">' + esc(x[2]) + '</span></div>';
      }).join('') + '</div>' +
      /* Онлайн-оплаты на сайте пока нет, и обещать её нельзя: покупатель
         дойдёт до шага оформления и не найдёт там ни карты, ни СБП.
         Формулировка взята со страницы «Оплата», она же единственный
         источник правды об этом. */
      '<p class="dlv-n">Оплата картой на сайте и через СБП появится после подключения платёжного провайдера. ' +
      'Сейчас доступны оплата при получении и оплата по счёту. ' +
      '<a href="' + link.page('payment') + '">Подробно об оплате</a></p></section>' +

      '<section class="b2b"><div class="b2b-h">' + ic('building', 26) + '<div><h2>Юридическим лицам и ИП</h2>' +
      '<p>Оплата по безналичному расчёту с полным пакетом документов.</p></div>' +
      '<a class="btn btn-o" href="' + link.page('business') + '">Условия для юрлиц' + ic('arrow-right', 18) + '</a></div>' +
      '<div class="b2b-l"><div>' + ic('doc', 20) + '<div><b>Счёт на оплату</b><span>Придёт на почту после оформления заказа</span></div></div>' +
      '<div>' + ic('check', 20) + '<div><b>Закрывающие документы</b><span>УПД или накладная и счёт-фактура — вместе с заказом или по ЭДО</span></div></div>' +
      '<div>' + ic('user', 20) + '<div><b>Выбор «Юридическое лицо»</b><span>Отметьте на шаге оформления и укажите реквизиты</span></div></div></div>' +
      '<p class="b2b-note">' + ic('mail', 18) + '<span>На шаге оформления выберите «Юридическое лицо» и заполните реквизиты компании. ' +
      'Если удобнее, отправьте карточку организации и запрос на <a href="mailto:' + esc(c.email || '') + '">' +
      esc(c.email || '') + '</a>.</span></p></section>' +

      '<p class="dlv-n dlv-warr">' + ic('shield', 18) + '<span>Гарантийный срок указан в карточке товара и в документах на заказ. ' +
      '<a href="' + link.page('warranty') + '">Гарантия и возврат</a></span></p>' +
      '</div>';
  }

  function checkout(r) {
    if (r.query.quick && C.byId(r.query.quick) && C.byId(r.query.quick).stock && !S.cart[r.query.quick]) { S.cart[r.query.quick] = 1; save(); updateHeader(); }
    var items = cartItems(), pricing = cartPricing(items), sum = pricing.gross, promo = pricing.discount;
    if (!items.length || items.some(function (it) { return !it.p.stock; })) return cart();
    var d = S.co || {}, deliv = d.deliv || 'courier', pay = d.pay || 'cash', biz = d.biz === '1';
    var drow = DEL.filter(function (x) { return x[0] === deliv; })[0] || DEL[0];
    var dcost = drow[3] == null ? 0 : drow[3];
    var dtext = drow[3] == null ? 'рассчитает менеджер' : (drow[3] ? fmt(drow[3]) + ' ₽' : 'бесплатно');
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Корзина', link.plain('cart')], ['Оформление заказа', '']]) + '<h1>Оформление заказа</h1>' +
      '<div class="steps"><a class="step done" href="' + link.plain('cart') + '"><i>' + ic('check', 14) + '</i><span>Корзина</span></a><div class="step on"><i>2</i><span>Доставка и оплата</span></div><div class="step"><i>3</i><span>Подтверждение</span></div></div></div>' +
      '<form class="cgrid" id="co-form"><div class="co">' +
      '<section class="cobox"><h3>1. Получатель</h3><div class="segs"><label class="seg' + (!biz ? ' on' : '') + '"><input type="radio" name="biz" value="0"' + (!biz ? ' checked' : '') + '>Физическое лицо</label><label class="seg' + (biz ? ' on' : '') + '"><input type="radio" name="biz" value="1"' + (biz ? ' checked' : '') + '>Юридическое лицо</label></div>' +
      '<div class="row2"><label class="fld"><span>Имя и фамилия</span><input type="text" name="name" required value="' + esc(d.name || '') + '" placeholder="Иван Петров"></label><label class="fld"><span>Телефон</span><input type="tel" name="phone" required value="' + esc(d.phone || '') + '" placeholder="+7 (___) ___-__-__"></label></div>' +
      '<div class="row2"><label class="fld"><span>Email</span><input type="email" name="email" value="' + esc(d.email || '') + '" placeholder="Для чека и статуса заказа"></label>' + (biz ? '<label class="fld"><span>ИНН компании</span><input type="text" name="inn" value="' + esc(d.inn || '') + '" placeholder="10 или 12 цифр"></label>' : '<span></span>') + '</div>' +
      (biz ? '<label class="fld"><span>Название организации</span><input type="text" name="company" value="' + esc(d.company || '') + '" placeholder="ООО «Компания»"></label>' : '') + '</section>' +
      '<section class="cobox"><h3>2. Доставка</h3><div class="opts">' + DEL.map(function (x) {
        return '<label class="opt' + (deliv === x[0] ? ' on' : '') + '"><input type="radio" name="deliv" value="' + x[0] + '"' + (deliv === x[0] ? ' checked' : '') + '><span class="rd"></span><span class="ot"><b>' + x[1] + '</b><span>' + x[2] + '</span></span><span class="oc">' + (x[3] == null ? 'по расчёту' : (x[3] ? fmt(x[3]) + ' ₽' : 'бесплатно')) + '</span></label>';
      }).join('') + '</div>' +
      (deliv === 'pickup' ? '<div class="pickup">' + ic('pin', 18) + '<div><b>Магазин и склад</b><span>' + esc(C.site.contacts.address) + ' · ' + esc(C.site.contacts.pickupHours) + '</span></div></div>' : '<label class="fld"><span>Адрес доставки</span><input type="text" name="address" value="' + esc(d.address || '') + '" placeholder="Город, улица, дом, квартира или офис"></label>') +
      '<label class="fld"><span>Комментарий к заказу</span><input type="text" name="comment" value="' + esc(d.comment || '') + '" placeholder="Код домофона, удобное время, пожелания"></label></section>' +
      '<section class="cobox"><h3>3. Оплата</h3><div class="opts">' + PAY.map(function (x) {
        return '<label class="opt' + (pay === x[0] ? ' on' : '') + '"><input type="radio" name="pay" value="' + x[0] + '"' + (pay === x[0] ? ' checked' : '') + '><span class="rd"></span><span class="ot"><b>' + x[1] + '</b><span>' + x[2] + '</span></span></label>';
      }).join('') + '</div><div class="note">Заказ уходит на сервер магазина, оплата в прототипе не проводится.</div></section></div>' +
      '<div class="summary"><h3>Ваш заказ</h3><div class="colist">' + items.map(function (it, index) {
        var line = pricing.lines[index];
        return '<div class="coi">' + imgHtml(it.p, {}) + '<div class="coi-title"><span>' + esc(it.p.name) + '</span>' +
          '<small>' + it.q + ' × ' + fmt(it.p.price) + ' ₽' + (promo ? ' · скидка ' + fmt(line.discount) + ' ₽' : '') +
          '</small></div><b>' + fmt(line.net) + ' ₽</b></div>';
      }).join('') + '</div><div class="srow"><span>Товары</span><b>' + fmt(sum) + ' ₽</b></div>' + (promo ? '<div class="srow"><span>Скидка 5% · HIBLACK5</span><b>−' + fmt(promo) + ' ₽</b></div>' : '') + '<div class="srow"><span>Доставка</span><b' + (drow[3] == null ? ' class="soft"' : '') + '>' + dtext + '</b></div><div class="srow total"><span>Итого</span><b>' + fmt(pricing.net + dcost) + ' ₽</b></div>' +
      '<div class="agrees" id="agrees">' +
      '<label class="agree"><input type="checkbox" name="agree-pd"><span>Я даю согласие на <a href="' + link.page('pdconsent') + '">обработку персональных данных</a> и ознакомлен(а) с <a href="' + link.page('privacy') + '">Политикой конфиденциальности</a></span></label>' +
      '<label class="agree"><input type="checkbox" name="agree-terms"><span>Я принимаю <a href="' + link.page('terms') + '">Пользовательское соглашение</a> и условия <a href="' + link.page('offer') + '">Публичной оферты</a></span></label>' +
      '<div class="agree-err" id="agree-err" hidden>' + ic('info', 16) + '<span>Без подтверждения двух обязательных согласий оформить заказ нельзя</span></div>' +
      '</div>' +
      '<button class="btn btn-y btn-lg btn-full" type="submit">Подтвердить заказ' + ic('arrow-right', 20) + '</button></div></form></div>';
  }

  function order(r) {
    var o = S.lastOrder || {};
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Заказ оформлен', '']]) +
      '<div class="steps"><div class="step done"><i>' + ic('check', 14) + '</i><span>Корзина</span></div><div class="step done"><i>' + ic('check', 14) + '</i><span>Доставка и оплата</span></div><div class="step on"><i>3</i><span>Подтверждение</span></div></div></div>' +
      '<div class="empty big"><div class="okmark">' + ic('check', 34) + '</div><h1>Спасибо! Заказ №' + esc(r.n || o.n || '—') + ' принят</h1><p>' + (o.name ? esc(o.name) + ', м' : 'М') + 'ы отправили подтверждение ' + (o.email ? 'на ' + esc(o.email) : 'в SMS') + '. Менеджер свяжется с вами в рабочее время, чтобы подтвердить ' + (o.deliv === 'pickup' ? 'время самовывоза' : 'доставку') + '.</p>' +
      (o.offline ? '<p class="muted small">Заказ сохранён в браузере: сервер приёма заказов в прототипе не запущен.</p>' : '<p class="muted small">Это прототип: оплата не проводилась.</p>') +
      '<div class="acts"><a class="btn btn-y" href="' + link.home() + '">На главную</a><a class="btn btn-o" href="' + link.catalog('') + '">Продолжить покупки</a></div></div></div>';
  }

  function favorites() {
    var items = C.all().filter(function (p) { return S.fav[p.id]; });
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Избранное', '']]) + '<h1>Избранное <span>' + items.length + ' ' + plural(items.length, 'товар', 'товара', 'товаров') + '</span></h1></div>' +
      (items.length ? '<div class="grid4" style="margin-top:28px">' + items.map(card).join('') + '</div>' : '<div class="empty big"><h3>В избранном пока ничего нет</h3><p>Нажмите на сердечко на карточке товара — он появится здесь.</p><a class="btn btn-o" href="' + link.catalog('') + '">В каталог</a></div>') + '</div>';
  }

  function compare() {
    var items = C.all().filter(function (p) { return S.cmp[p.id]; });
    if (!items.length) return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Сравнение', '']]) + '<h1>Сравнение</h1></div><div class="empty big"><h3>Список сравнения пуст</h3><p>Добавьте два-три картриджа кнопкой «Сравнить» на карточке — покажем их характеристики рядом.</p><a class="btn btn-o" href="' + link.catalog('') + '">В каталог</a></div></div>';
    var rows = [
      ['Цена', function (p) { return '<b class="price" style="font-size:18px">' + (noPrice(p) ? 'Цена по запросу' : fmt(p.price) + ' ₽') + '</b>'; }],
      ['Бренд принтера', function (p) { return brandLogo(p.brand, 16, ''); }],
      ['Ресурс', function (p) { return p.res ? fmt(p.res) + ' стр.' : '—'; }],
      ['Цвет', function (p) { return C.colorTitle(p.color) || '—'; }],
      ['Чип', function (p) { return p.chip === true ? 'Есть' : (p.chip === false ? 'Нет' : '—'); }],
      ['Тип', function (p) { return p.type; }],
      ['Рейтинг', function (p) { return stars(p.rate) + ' ' + ratef(p.rate) + ' · ' + p.reviews; }],
      ['Наличие', function (p) { return p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Нет в наличии</span>'; }],
    ];
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Сравнение', '']]) + '<h1>Сравнение <span>' + items.length + ' ' + plural(items.length, 'товар', 'товара', 'товаров') + '</span></h1></div>' +
      '<div class="cmp-wrap"><table class="cmp"><thead><tr><th></th>' + items.map(function (p) {
        return '<th><a href="' + link.product(p) + '">' + imgHtml(p, { alt: p.name }) + '<span>' + esc(p.name) + '</span></a>' +
          (!p.stock ? stockAlertButton(p, 'btn-o btn-sm') : noPrice(p)
            ? '<a class="btn btn-o btn-sm" href="' + link.page('contacts') + '">Запросить цену</a>'
            : '<button class="btn btn-y btn-sm" type="button" data-add="' + p.id + '">В корзину</button>') +
          '<button class="rmc" type="button" data-cmp="' + p.id + '">' + ic('close', 14) + 'Убрать</button></th>';
      }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
        return '<tr><td>' + r[0] + '</td>' + items.map(function (p) { return '<td>' + r[1](p) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function finder() {
    var popular = ['M2135dn', 'M2040dn', 'FS-1040', 'M125', 'M401', 'M104', 'P1102', 'HL-L2300', 'DCP-L2500', 'MF3010', 'LBP6030', 'ML-2160', 'Phaser 3020', 'WorkCentre 3025', 'P2207', 'SP 3400N'];
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Подбор по принтеру', '']]) + '<h1>Подбор расходников по принтеру</h1></div>' +
      '<div class="finder-page"><div class="fp-box"><p>Введите модель принтера или МФУ — покажем все подходящие картриджи, тонеры и чернила Hi-Black.</p>' + finderForm(true) +
      '<h3>Популярные модели</h3><div class="tags">' + popular.map(function (m) { return '<a class="chip" href="' + link.search(m) + '">' + esc(m) + '</a>'; }).join('') + '</div></div>' +
      '<div class="fp-side"><h3>Где найти модель принтера</h3><ol><li>На передней панели или крышке — крупная надпись, например <b>ECOSYS M2135dn</b>.</li><li>На наклейке сзади или снизу устройства — строка «Model».</li><li>В настройках печати на компьютере — название принтера в списке устройств.</li></ol><p>Не нашли — напишите нам модель в чат или позвоните: подберём вручную.</p><a class="btn btn-o" href="' + link.page('contacts') + '">Контакты</a></div></div></div>';
  }

  function login() {
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Вход', '']]) + '</div><div class="login"><h1>Вход в личный кабинет</h1><p class="muted">История заказов, повторный заказ в один клик, документы для юрлиц.</p><form id="login-form"><label class="fld"><span>Телефон или email</span><input type="text" required placeholder="+7 или name@company.ru"></label><label class="fld"><span>Пароль</span><input type="password" required placeholder="••••••••"></label><button class="btn btn-y btn-lg btn-full" type="submit">Войти</button><div class="lrow"><a href="#">Забыли пароль?</a><a href="#">Регистрация</a></div><p class="muted xs">В прототипе вход не выполняется — это демонстрация формы.</p></form></div></div>';
  }

  function page(r) {
    var pg = C.site.pages.filter(function (x) { return x.id === r.id; })[0];
    if (!pg) return notfound();
    var body = C.site.pageText[pg.id] || '';
    if (pg.id === 'lines') body += '<div class="lines">' + C.site.lines.map(function (l) { return '<div class="line-c"><b>' + esc(l[0]) + '</b><span>' + esc(l[1]) + '</span></div>'; }).join('') + '</div>';
    if (pg.id === 'compat') {
      return C.compatibility().then(function (all) { return shell(pg, body + compatTable(all)); });
    }
    return shell(pg, body);
  }

  /* Обёртка информационной страницы: крошки, заголовок, боковая колонка. */
  function shell(pg, body) {
    return '<div class="wrap"><div class="layout"><aside class="side">' + sideCats('') + sideInfo() + '</aside><div class="content"><div class="ph1" style="padding-top:0">' + crumbs([['Главная', link.home()], [pg.title, '']]) + '<h1>' + esc(pg.title) + '</h1></div><div class="desc page-text">' + body + '</div></div></div></div>';
  }

  /*
    Таблица совместимости: все модели принтеров, к которым у нас есть расходники.
    Данные лежат отдельным файлом и подгружаются только на этой странице — класть
    235 моделей в общий пакет каталога незачем. Поиск фильтрует уже отрисованный
    список, без перерисовки страницы.
  */
  function compatTable(all) {
    var byBrand = {};
    Object.keys(all).forEach(function (k) { (byBrand[all[k].brand] ||= []).push(k); });
    var brands = Object.keys(byBrand).sort(function (a, b) { return byBrand[b].length - byBrand[a].length; });
    var rows = brands.map(function (bid) {
      var list = byBrand[bid].sort(function (a, b) { return all[a].model.localeCompare(all[b].model, 'ru', { numeric: true }); });
      return '<div class="cmpt-b">' +
        '<div class="cmpt-h" id="cmp-' + bid + '">' + brandLogo(bid, 20, 'blogo') + '<h3>' + esc(C.brandName(bid)) + '</h3><span>' + list.length + ' ' + plural(list.length, 'модель', 'модели', 'моделей') + '</span></div>' +
        '<div class="cmpt-g">' + list.map(function (k) {
          var e = all[k];
          return '<a class="cmpt-i" href="' + link.printer(k) + '" data-model="' + esc((e.model + ' ' + C.brandName(bid)).toLowerCase()) + '">' +
            '<b>' + esc(e.model) + '</b><span>' + e.rows.length + ' ' + plural(e.rows.length, 'расходник', 'расходника', 'расходников') + '</span></a>';
        }).join('') + '</div></div>';
    }).join('');
    return '<div class="cmpt">' +
      '<div class="cmpt-top"><label class="cmpt-f">' + ic('search', 18) +
      '<input type="search" id="cmpt-q" placeholder="Модель принтера, например M2135dn" aria-label="Поиск по модели принтера"></label>' +
      '<a class="btn btn-y" href="' + link.plain('finder') + '">Подобрать по принтеру</a></div>' +
      '<div class="cmpt-jump">' + brands.map(function (b) {
        return '<button class="chip" type="button" data-jump="cmp-' + b + '">' + esc(C.brandName(b)) + '</button>';
      }).join('') + '</div>' +
      '<div id="cmpt-list">' + rows + '</div>' +
      '<div class="empty" id="cmpt-none" hidden><h3>Такой модели в таблице нет</h3><p>Проверьте написание или откройте подбор — там ищется по части названия.</p></div>' +
      '</div>';
  }

  function notfound() {
    return '<div class="wrap"><div class="empty big"><h3>Страница не найдена</h3><p>Возможно, товар снят с продажи или адрес набран с ошибкой. Попробуйте найти нужный расходник по модели принтера.</p><div class="acts"><a class="btn btn-y" href="' + link.plain('finder') + '">Подобрать по принтеру</a><a class="btn btn-o" href="' + link.home() + '">На главную</a></div></div></div>';
  }

  var routes = { home: home, catalog: catalog, product: product, printer: printer, cart: cart, checkout: checkout, order: order, favorites: favorites, compare: compare, page: page, finder: finder, login: login, notfound: notfound };

  /* --------------------------------------------------------- отрисовка */
  /*
    Прокрутка при смене маршрута.

    html{scroll-behavior:smooth} превращает обычный scrollTo в анимацию, а
    переход по хешу её обрывает: в сборке одним файлом карточка похожего товара
    открывалась там же, где стояла прокрутка, а на сервере доезжала до верха
    почти секунду. Поэтому здесь прокрутка всегда мгновенная — на время вызова
    плавность отключается инлайновым стилем, а браузерам поновее хватает
    behavior:'instant'.
  */
  function scrollToY(y) {
    var el = document.documentElement, prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); }
    catch (e) { window.scrollTo(0, y); }
    el.style.scrollBehavior = prev;
  }
  /* Свою прокрутку по истории браузер бы восстанавливал поверх нашей. */
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  /*
    Смена страницы должна быть заметной, но не медленной. Порядок такой:
    гасим текущее содержимое (~180 мс), одновременно готовим новое, потом
    мгновенно подменяем, ставим прокрутку в ноль и проявляем с лёгким
    движением вверх (~260 мс). Итого около 440 мс.

    Смена цвета внутри одной серии — отдельный случай: там страница остаётся
    на месте, а меняется только карточка, поэтому кроссфейд короче и без
    прокрутки. Иначе выбор цвета выбрасывал бы наверх.
  */
  var NAV_OUT = 180, NAV_IN = 260, SWAP = 380;
  var navLine = document.getElementById('navline');
  var navMode = 'page', navBusy = false;
  function reduced() {
    /* HB_STATIC ставит предрендер: снимок страницы не должен содержать
       классов анимации и включённой полосы прогресса. */
    return !!window.HB_STATIC || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function lineOn() { if (navLine) { navLine.classList.remove('done'); navLine.classList.add('on'); } }
  function lineOff() {
    if (!navLine) return;
    navLine.classList.add('done');
    setTimeout(function () { navLine.classList.remove('on', 'done'); }, 260);
  }

  var lastKey = null, lastPath = null;
  /*
    Строка поиска следует за адресом.

    Раньше она жила своей жизнью: набрал «300972», открыл выдачу, нажал
    логотип — главная открылась, а в поле по-прежнему «300972». Дальше
    хуже: с этим текстом в поле человек уходил в каталог, видел там весь
    ассортимент и не понимал, почему поиск «не сработал».

    Правило простое: поле показывает запрос ровно тогда, когда он есть в
    адресе. На странице поиска — сам запрос, везде остальное — пусто. Это
    же правило само собой закрывает «назад» и «вперёд»: они проходят
    через ту же отрисовку.

    Поле не трогается, пока в нём стоит курсор: перебивать текст под
    руками у человека нельзя. Такое бывает, когда страница перерисовалась
    не от навигации, а сама по себе.
  */
  /*
    Догрузка оригинала снимка поверх ячейки атласа.

    Адрес ставится из кода, а не атрибутом в разметке: обработчик onerror
    в атрибуте блокируется политикой безопасности страницы превью, и
    вместо тихого отката получалась битая картинка с надписью «Фото не
    загрузилось» прямо поверх нормального снимка.

    Порядок такой: сначала вешаем обработчики, потом адрес. Не
    загрузилось — картинка убирает себя, и остаётся ячейка атласа.
  */
  function loadFullPhoto() {
    var el = document.querySelector('.g-full[data-full]');
    if (!el) return;
    var url = el.getAttribute('data-full');
    el.removeAttribute('data-full');
    el.addEventListener('load', function () { if (el.naturalWidth > 0) el.hidden = false; });
    el.addEventListener('error', function () { el.remove(); });
    el.src = url;
  }

  function syncSearchBox(r) {
    var el = document.querySelector('#search-form input[name=q]');
    if (!el || document.activeElement === el) return;
    var want = r.route === 'catalog' && r.query && r.query.q ? r.query.q : '';
    if (el.value !== want) el.value = want;
  }

  function render() {
    var r = parse(), fn = routes[r.route] || notfound;
    /*
      Увеличение закрывается до перехода, а список кадров обнуляется:
      иначе на новой странице осталось бы открытым окно с фотографией
      предыдущего товара, а «Открыть фото» на карточке без снимка
      показало бы чужой кадр из прошлого состояния.
    */
    closePhoto();
    gFrames = []; gFrame = 0; gView = 0;
    lbReset();
    var key = r.route + ':' + (r.slug || r.id || r.key || '');
    var keepScroll = (r.route === 'catalog' && lastPath === 'catalog') || (r.route === 'product' && key === lastKey) || (r.route === 'cart' && lastPath === 'cart') || (r.route === 'checkout' && lastPath === 'checkout');
    var mode = navMode; navMode = 'page';
    if (mode === 'variant') keepScroll = true;
    var soft = !reduced() && lastPath !== null;
    var y = window.scrollY;
    var sideEl = app.querySelector('.side.open'), sideY = sideEl ? sideEl.scrollTop : 0;

    if (soft) {
      navBusy = true;
      lineOn();
      /* Класс проявления мог остаться от предыдущего перехода: если его не
         снять, два состояния наложатся и содержимое мигнёт. */
      app.classList.remove('nav-in', 'swap-in');
      app.classList.add(mode === 'variant' ? 'swap-out' : 'nav-out');
    }
    var ready = Promise.all([
      Promise.resolve(fn(r)),
      soft ? wait(mode === 'variant' ? SWAP / 2 : NAV_OUT) : null,
    ]).then(function (a) { return a[0]; });

    return ready.then(function (html) {
      app.classList.remove('nav-out', 'swap-out');
      app.innerHTML = html;
      /* Класс страницы переписывается целиком, поэтому переносим отметку о
         показанном баннере cookie — иначе липкая панель покупки на телефоне
         уезжает под него. */
      var hadCookie = document.body.classList.contains('has-cookie');
      /* bar-on выставляет наблюдатель липкой панели; при смене страницы сбрасываем. */
      document.body.className = 'pg-' + r.route + (r.route === 'catalog' && r.query.f === '1' ? ' noscroll' : '') + (hadCookie ? ' has-cookie' : '');
      var s2 = app.querySelector('.side.open'); if (s2) s2.scrollTop = sideY;
      var h1 = app.querySelector('h1');
      document.title = r.route === 'home' ? 'Hi-Black — фирменный магазин расходных материалов для принтеров'
        : (h1 ? h1.textContent.replace(/\s+/g, ' ').trim() + ' — Hi-Black' : 'Hi-Black');
      document.querySelectorAll('.nav a').forEach(function (a) {
        a.classList.toggle('on', a.getAttribute('href') === link.catalog(r.cat || ' '));
      });
      closeMenu(); closeMob();
      var toTab = r.route === 'product' && r.query.tab && key !== lastKey;
      scrollToY(keepScroll ? y : 0);
      if (soft) {
        var cls = mode === 'variant' ? 'swap-in' : 'nav-in';
        app.classList.add(cls);
        setTimeout(function () {
          app.classList.remove(cls);
          navBusy = false;
          lineOff();
        }, mode === 'variant' ? SWAP / 2 : NAV_IN);
      }
      /* Ещё раз на следующем кадре: переход по хешу браузер доделывает после
         нас и иначе возвращает страницу туда, где она стояла. */
      if (!keepScroll && !toTab) requestAnimationFrame(function () { scrollToY(0); });
      if (toTab) {
        var t = document.getElementById('ptabs');
        if (t) setTimeout(function () { t.scrollIntoView({ block: 'start' }); }, 30);
      }
      lastKey = key; lastPath = r.route;
      syncSearchBox(r);
      loadFullPhoto();
      updateHeader();
      initSlider();
      initBuybar();
    }).catch(function (e) {
      app.innerHTML = '<div class="wrap"><div class="empty big"><h3>Не удалось загрузить страницу</h3><p>' + esc(e.message) + '</p><a class="btn btn-o" href="' + link.home() + '">На главную</a></div></div>';
    });
  }
  window.addEventListener('popstate', render);
  window.addEventListener('hashchange', function () { if (OFFLINE) render(); });

  /* Внутренние ссылки открываются без перезагрузки. */
  /*
    Картинка, которая не загрузилась.

    Причин хватает: сервер поставщика недоступен, файла нет, а строгая
    политика страницы может запретить чужой хост целиком. Браузер в
    таком случае не показывает ничего — остаётся пустой прямоугольник,
    и витрина выглядит сломанной, хотя сломана только одна ссылка.
    Поэтому место картинки честно подписывается тем же текстом, что и у
    товара без фото.

    Слушатель один и в фазе перехвата: событие error у картинок не
    всплывает, и повесить его на каждый <img> значило бы дублировать
    обработчик в десяти местах разметки.
  */
  /*
    Запасной источник. Адрес прокси несёт в себе исходный — значит второй
    попытки не нужно ничего хранить: она извлекается из того же адреса.
    Порядок такой: прокси, затем прямой адрес поставщика, затем подпись.
    Какой из двух хостов разрешён политикой страницы, заранее неизвестно,
    и выбирать вслепую значило бы гадать.
  */
  /*
    Счётчик источников картинок.

    Нужен для проверки снаружи. Какой из двух хостов разрешён политикой
    страницы, из кода не видно, а глазами по девяти тысячам карточек не
    посчитаешь. Поэтому витрина считает сама: сколько картинок пришло с
    прокси, сколько с прямого адреса поставщика, сколько не пришло вовсе.
    Одна строка в консоли — и картина точная:

        HB_IMGDIAG()

    На поведение витрины это не влияет и в разметке не видно.
  */
  var imgStat = { прокси: 0, прямой: 0, свои: 0, заглушка: 0 };
  window.HB_IMGDIAG = function () {
    /* Картинки без адреса в счёт не идут: у лайтбокса <img> живёт в
       разметке заранее и получает src только при открытии. Без этой
       оговорки проверка показывала бы одну несуществующую ошибку. */
    var imgs = [].slice.call(document.images).filter(function (i) { return i.getAttribute('src'); });
    return {
      всегоНаСтранице: imgs.length,
      загрузилось: imgs.filter(function (i) { return i.complete && i.naturalWidth > 0; }).length,
      неЗагрузилось: imgs.filter(function (i) { return i.complete && !i.naturalWidth; }).length,
      поИсточникам: imgStat,
      примеры: imgs.slice(0, 4).map(function (i) { return { src: i.currentSrc || i.src, naturalWidth: i.naturalWidth }; }),
    };
  };
  document.addEventListener('load', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG' || !el.naturalWidth) return;
    var src = el.currentSrc || el.src || '';
    if (src.indexOf('wsrv.nl/') >= 0) imgStat['прокси'] += 1;
    else if (src.indexOf('b2b.vtt.ru') >= 0) imgStat['прямой'] += 1;
    else imgStat['свои'] += 1;
  }, true);

  function directFromProxy(src) {
    if (!src || src.indexOf('wsrv.nl/') < 0) return null;
    try {
      var u = new URL(src).searchParams.get('url');
      return u ? (/^https?:\/\//i.test(u) ? u : 'https://' + u) : null;
    } catch (err) { return null; }
  }

  document.addEventListener('error', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG' || el.getAttribute('data-imgfail')) return;
    /*
      Оригинал поставщика поверх атласа — улучшение с собственным
      откатом: он убирает себя сам, и остаётся ячейка. Общий обработчик
      сюда лезть не должен — он помечает родителя, и плашка «Фото не
      загрузилось» ложилась поверх нормального снимка.
    */
    if (el.classList.contains('g-full')) return;
    if (!el.getAttribute('src')) return;
    if (!el.getAttribute('data-retried')) {
      var direct = directFromProxy(el.getAttribute('src'));
      if (direct) { el.setAttribute('data-retried', '1'); el.src = direct; return; }
    }
    el.setAttribute('data-imgfail', '1');
    imgStat['заглушка'] += 1;
    if (el.parentElement) el.parentElement.classList.add('hb-imgfail');
  }, true);

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    /* Вкладки переключаются своим обработчиком ниже без смены страницы.
       Иначе первый клик запускает go() и позднюю перерисовку карточки,
       которая сбивает прокрутку к характеристикам. */
    if (a.hasAttribute('data-spec-jump') || a.hasAttribute('data-tab-link')) return;
    var href = a.getAttribute('href');
    /* tel: и прочие внешние схемы уходят системе нетронутыми: выходим раньше,
       чем дело дойдёт до preventDefault, — иначе браузер не получит обычный
       переход из нажатия и звонилка не откроется. */
    if (href && /^(tel|mailto|sms|facetime|facetime-audio|callto):/i.test(href)) return;
    if (href && /^[a-z][a-z0-9+.-]*:/i.test(href) && href.slice(0, 1) !== '/') return;
    /* Ссылки в шапке, подвале и мобильном меню записаны в разметке обычными
       путями и про режим «весь сайт одним файлом» не знают. Перехватываем их
       здесь: без этого браузер уйдёт по /catalog/laser и откроет пустоту. */
    if (!href || href[0] !== '/' || href.indexOf('//') === 0) return;
    e.preventDefault();
    if (navBusy) return;                       // пока идёт переход, второй клик не нужен
    /* Ссылка на другой цвет той же серии — это смена варианта, а не переход
       на новую страницу: прокрутка остаётся на месте, подсветка сразу. */
    var tile = a.closest('.var');
    if (tile && !tile.classList.contains('on')) {
      navMode = 'variant';
      var list = tile.parentNode;
      if (list) list.querySelectorAll('.var').forEach(function (n) { n.classList.remove('on', 'picking'); });
      tile.classList.add('picking');
    }
    if (!OFFLINE && href === location.pathname + location.search) return;
    go(href);
  });

  /* --------------------------------------------------------- действия */
  /*
    Переключение вкладки карточки.

    Вкладка попадает в адрес (?tab=…) — тем же параметром, который читает
    маршрутизатор при отрисовке. Поэтому обновление страницы, «назад» из
    другой карточки и ссылка, отправленная коллеге, открывают ту же
    вкладку, что была. Адрес меняется через replaceState: перерисовывать
    страницу ради переключения вкладки незачем, а в режиме адресов после
    решётки (превью, файл «всё в одном») replaceState ещё и не вызывает
    hashchange, то есть не роняет позицию прокрутки.
  */
  function showTab(name, opts) {
    var tabs = document.querySelectorAll('#ptabs button');
    if (!tabs.length) return false;
    var known = false;
    tabs.forEach(function (b) {
      var on = b.dataset.tab === name;
      if (on) known = true;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!known) return false;
    document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    if (!opts || opts.sync !== false) {
      /* Адрес — вещь необязательная для показа вкладки: если история
         недоступна (песочница, file://), вкладка всё равно открывается. */
      try { history.replaceState({}, '', withQuery({ tab: name === 'desc' ? '' : name })); } catch (e) { }
    }
    return true;
  }

  /* Прокрутка к открытой панели: с учётом липкой шапки и настройки
     «меньше движения». */
  function scrollToTabs() {
    var el = document.getElementById('ptabs');
    if (el) el.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
  }
  /* Живой поиск по таблице совместимости и переход к нужному бренду. */
  document.addEventListener('input', function (e) {
    if (e.target.id !== 'cmpt-q') return;
    var q = e.target.value.trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll('.cmpt-b').forEach(function (b) {
      var vis = 0;
      b.querySelectorAll('.cmpt-i').forEach(function (a) {
        var on = !q || a.dataset.model.indexOf(q) >= 0;
        a.hidden = !on; if (on) vis++;
      });
      b.hidden = !vis; shown += vis;
    });
    document.getElementById('cmpt-none').hidden = !!shown;
  });
  document.addEventListener('click', function (e) {
    var j = e.target.closest('[data-jump]');
    if (!j) return;
    var el = document.getElementById(j.dataset.jump);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  var toast = document.getElementById('toast'), tt;
  function showToast(html) { toast.innerHTML = html; toast.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { toast.classList.remove('show'); }, 2600); }
  function addToCart(id, q) {
    var p = C.byId(id);
    if (!p || !p.stock || noPrice(p)) {
      showToast('Товара сейчас нет в продаже. Оставьте почту для уведомления о поступлении.');
      return false;
    }
    S.cart[id] = (S.cart[id] || 0) + (q || 1);
    save(); updateHeader(); syncBuybar();
    showToast(ic('check', 18) + '<span>' + esc(p.name.slice(0, 48)) + '… — в корзине</span> <a href="' + link.plain('cart') + '">Перейти в корзину</a>');
    return true;
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-add]');
    if (t) {
      var q = 1;
      if (t.dataset.useq) q = pickedQty();
      if (!addToCart(t.dataset.add, q)) return;
      var old = t.innerHTML; t.classList.add('added'); t.innerHTML = ic('check', 18) + 'Добавлено';
      setTimeout(function () { t.innerHTML = old; t.classList.remove('added'); }, 1400);
      return;
    }
    t = e.target.closest('[data-fav]');
    if (t) {
      e.preventDefault();
      var id = t.dataset.fav;
      S.fav[id] = !S.fav[id]; if (!S.fav[id]) delete S.fav[id];
      save(); updateHeader();
      document.querySelectorAll('[data-fav="' + id + '"]').forEach(function (b) {
        b.classList.toggle('on', !!S.fav[id]);
        if (b.closest('.acts')) b.innerHTML = ic('heart', 16) + (S.fav[id] ? 'В избранном' : 'В избранное');
      });
      showToast(ic('heart', 18) + (S.fav[id] ? 'Добавлено в избранное' : 'Убрано из избранного') + ' <a href="' + link.plain('favorites') + '">Открыть</a>');
      if (parse().route === 'favorites') render();
      return;
    }
    t = e.target.closest('[data-view-mode]');
    if (t) {
      /* Меняем только класс контейнера: перерисовка сбросила бы прокрутку, а
         адрес страницы вид не хранит — фильтры, сортировка и номер страницы
         остаются ровно теми же. */
      var mode = t.dataset.viewMode === 'list' ? 'list' : 'tiles';
      var box = document.getElementById('cards');
      if (box) { box.classList.toggle('clist', mode === 'list'); box.classList.toggle('grid3', mode !== 'list'); }
      app.querySelectorAll('[data-view-mode]').forEach(function (b) {
        var on = b.dataset.viewMode === mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (S.view !== mode) { S.view = mode; save(); }
      return;
    }
    t = e.target.closest('[data-cmp]');
    if (t) {
      e.preventDefault();
      var id2 = t.dataset.cmp;
      S.cmp[id2] = !S.cmp[id2]; if (!S.cmp[id2]) delete S.cmp[id2];
      if (count(S.cmp) > 4) { delete S.cmp[id2]; showToast('В сравнении может быть не больше 4 товаров'); return; }
      save(); updateHeader();
      document.querySelectorAll('[data-cmp="' + id2 + '"]').forEach(function (b) {
        var on = !!S.cmp[id2];
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (b.closest('.acts')) {
          b.innerHTML = ic('compare', 16) + (on ? 'В сравнении' : 'В сравнение');
          b.title = on ? 'Убрать из сравнения' : 'Добавить к сравнению';
        } else if (b.classList.contains('cmp-b')) {
          b.innerHTML = ic('compare', 16) + '<span>' + (on ? 'В сравнении' : 'Сравнить') + '</span>';
          b.title = on ? 'Убрать из сравнения' : 'Сравнить';
        }
      });
      showToast(ic('compare', 18) + (S.cmp[id2] ? 'Добавлено к сравнению' : 'Убрано из сравнения') + ' <a href="' + link.plain('compare') + '">Сравнить (' + count(S.cmp) + ')</a>');
      if (parse().route === 'compare') render();
      return;
    }
    t = e.target.closest('[data-kit], [data-kit-all]');
    if (t) {
      var famId = t.dataset.kit || t.dataset.kitAll, onlyStock = !!t.dataset.kit;
      C.family(famId).then(function (f) {
        if (!f) return;
        var add = f.items.filter(function (x) { return x.stock && x.price > 0; });
        if (!add.length) { showToast('Цвета сейчас отсутствуют. Запросите уведомление о поступлении.'); return; }
        add.forEach(function (x) { S.cart[x.id] = (S.cart[x.id] || 0) + 1; });
        save(); updateHeader();
        showToast(ic('check', 18) + '<span>В корзине ' + add.length + ' ' + plural(add.length, 'цвет', 'цвета', 'цветов') +
          (onlyStock && add.length < f.items.length ? ', остальные под заказ' : '') + '</span> <a href="' + link.plain('cart') + '">Перейти в корзину</a>');
      });
      return;
    }
    t = e.target.closest('[data-cq]');
    if (t) { var id3 = t.dataset.cq; S.cart[id3] = Math.max(0, (S.cart[id3] || 0) + (+t.dataset.d)); if (!S.cart[id3]) delete S.cart[id3]; save(); render(); return; }
    t = e.target.closest('[data-rm]');
    if (t) { delete S.cart[t.dataset.rm]; save(); render(); return; }
    t = e.target.closest('[data-clear-cart]');
    if (t) { e.preventDefault(); S.cart = {}; save(); render(); return; }
    t = e.target.closest('[data-fav-all]');
    if (t) { e.preventDefault(); Object.keys(S.cart).forEach(function (id) { S.fav[id] = true; }); save(); updateHeader(); showToast(ic('heart', 18) + 'Товары из корзины добавлены в избранное'); return; }
    t = e.target.closest('[data-q]');
    if (t) { setQty(Math.max(1, (+(document.getElementById('pq') || {}).textContent || 1) + (+t.dataset.q))); return; }
    t = e.target.closest('[data-spec-more]');
    if (t) {
      var rest = t.parentNode.querySelector('.sr-rest'), open = rest.hidden;
      rest.hidden = !open;
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
      t.classList.toggle('on', open);
      var tx = t.querySelector('[data-more-txt]');
      if (tx) tx.textContent = open ? 'Свернуть характеристики' : 'Все характеристики (' + (t.parentNode.querySelectorAll('.sr').length) + ')';
      return;
    }
    t = e.target.closest('[data-tab]');
    if (t) { showTab(t.dataset.tab); return; }
    t = e.target.closest('[data-tab-link]');
    if (t) { e.preventDefault(); showTab(t.dataset.tabLink); scrollToTabs(); return; }
    t = e.target.closest('[data-spec-jump]');
    if (t) {
      /*
        «Все характеристики» открывает вкладку характеристик и
        прокручивает к ней. Раньше здесь стоял showTab('desc'), и после
        нажатия человек оставался на описании — кнопка вкладки при этом
        работала, из-за чего дефект и выглядел необъяснимым.

        Если вкладку переключить не удалось (вёрстка карточки ещё не
        отрисована), preventDefault не делается: тогда сработает обычный
        переход по адресу ?tab=specs, и характеристики всё равно
        откроются.
      */
      if (showTab('specs')) { e.preventDefault(); scrollToTabs(); }
      return;
    }
    t = e.target.closest('[data-scroll]');
    if (t) { var el = document.querySelector(t.dataset.scroll); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    t = e.target.closest('[data-useful]');
    if (t) { t.classList.add('on'); t.innerHTML = ic('check', 14) + 'Спасибо!'; return; }
    t = e.target.closest('[data-open-f]');
    if (t) { var side = app.querySelector('.side'); if (side) side.classList.add('open'); document.body.classList.add('noscroll'); return; }
    t = e.target.closest('[data-close-f]');
    if (t) {
      var sideC = app.querySelector('.side'); if (sideC) sideC.classList.remove('open');
      document.body.classList.remove('noscroll');
      if (parse().query.f) go(withQuery({ f: '' }), true);
      return;
    }
    t = e.target.closest('.thumb[data-view]');
    if (t) { showView(+t.dataset.view); return; }
    t = e.target.closest('[data-sl]');
    if (t) { slideTo(slideIdx + (+t.dataset.sl)); restartSlider(); return; }
    t = e.target.closest('[data-dot]');
    if (t) { slideTo(+t.dataset.dot); restartSlider(); return; }
    /* Увеличивать нечего, если снимка нет: показали бы заглушку во весь
       экран. Проверка по самой площадке, а не по наличию картинки в
       разметке, — заглушка тоже <img>. */
    if (e.target.closest('#gmain')) {
      if (!e.target.closest('#gmain').classList.contains('no-photo')) openPhoto();
      return;
    }
    if (e.target.closest('.thumb.video')) { showToast('Видеообзор — заглушка для прототипа'); return; }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('[data-f]')) {
      var r = parse();
      if (r.route !== 'catalog') return;
      var key = t.dataset.f, patch = {};
      if (t.type === 'checkbox') {
        if (key === 'stock') { patch.stock = t.checked ? '1' : ''; patch.page = ''; }
        else patch = toggleValue(r.query, key, t.value);
      } else {
        patch[key] = t.value; patch.page = '';
        if (key === 'sort' || key === 'pp') patch.acc = '';
      }
      if (app.querySelector('.side.open')) patch.f = '1';
      go(withQuery(patch));
    }
    if (t.name === 'biz' || t.name === 'deliv' || t.name === 'pay') {
      var f = document.getElementById('co-form');
      if (f) { S.co = Object.assign(S.co || {}, formData(f)); save(); render(); }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMenu(); closeMob(); }
    if (e.key === 'Enter' && e.target.matches('[data-f]') && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  function formData(f) {
    var o = {};
    Array.prototype.forEach.call(f.elements, function (el) {
      if (el.name) { if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; } else o[el.name] = el.value; }
    });
    return o;
  }

  /*
    Обязательные согласия. Галочки намеренно не проставлены заранее и кнопка
    остаётся живой: пользователь должен нажать её и увидеть, чего не хватает,
    а не гадать, почему всё серое. Работает и мышью, и с клавиатуры — проверка
    висит на submit формы, а не на click кнопки.
  */
  function agreesOk(f, msg) {
    var boxes = f.querySelectorAll('.agree input[type=checkbox]');
    if (!boxes.length) return true;
    var bad = null;
    Array.prototype.forEach.call(boxes, function (b) {
      var l = b.closest('.agree');
      if (b.checked) { if (l) l.classList.remove('bad'); return; }
      if (l) l.classList.add('bad');
      if (!bad) bad = b;
    });
    var box = f.querySelector('.agrees') || (bad && bad.closest('.agree'));
    if (!bad) { if (box) box.classList.remove('bad'); var okErr = f.querySelector('.agree-err'); if (okErr) okErr.hidden = true; return true; }
    if (box) box.classList.add('bad');
    var err = f.querySelector('.agree-err');
    if (!err) {
      err = document.createElement('div');
      err.className = 'agree-err';
      err.innerHTML = ic('info', 16) + '<span></span>';
      var host = f.querySelector('.agrees') || bad.closest('.agree');
      if (host) host.parentNode.insertBefore(err, host.nextSibling);
    }
    var sp = err.querySelector('span'); if (sp) sp.textContent = msg;
    err.hidden = false;
    try { err.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); } catch (e2) { err.scrollIntoView(); }
    try { bad.focus({ preventScroll: true }); } catch (e3) { bad.focus(); }
    return false;
  }
  /* Снимаем подсветку сразу, как только галочку поставили. */
  /* Поставили оценку — подсветка ошибки уходит сразу, а не на следующей
     попытке отправки: поле, которое уже исправили, не должно продолжать
     выглядеть сломанным. */
  document.addEventListener('change', function (e) {
    var r = e.target;
    if (!r || r.type !== 'radio' || r.name !== 'rate') return;
    var g = r.closest('#rev-rate'); if (g) g.classList.remove('bad');
    var m = document.getElementById('rev-msg');
    if (m && /оценку от 1 до 5/.test(m.textContent)) m.hidden = true;
  });

  document.addEventListener('change', function (e) {
    var b = e.target;
    if (!b || b.type !== 'checkbox' || !b.closest('.agree')) return;
    var f = b.form || b.closest('form'); if (!f) return;
    b.closest('.agree').classList.toggle('bad', !b.checked);
    var left = Array.prototype.filter.call(f.querySelectorAll('.agree input[type=checkbox]'), function (x) { return !x.checked; });
    if (left.length) return;
    var box = f.querySelector('.agrees'); if (box) box.classList.remove('bad');
    var err = f.querySelector('.agree-err'); if (err) err.hidden = true;
  });

  /* На боевом сайте заказ подтверждается только после ответа сервера. */
  function submitOrder(data, items, total) {
    return fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: data, items: items.map(function (x) { return { id: x.p.id, code: x.p.code, name: x.p.name, price: x.p.price, qty: x.q }; }), promo: S.promo || '', total: total }),
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (result) {
        if (!result || !result.ok || !result.number) throw new Error('Заказ не подтверждён сервером');
        return result;
      });
  }

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.id === 'finder-form') {
      e.preventDefault();
      var d = formData(f);
      if (d.q) go(link.search(d.q.trim()));
      else if (d.brand) go(link.catalog('laser', d.brand));
      else go(link.plain('finder'));
      return;
    }
    if (f.id === 'search-form') { e.preventDefault(); go(link.search(f.querySelector('input').value.trim())); return; }
    if (f.id === 'promo-form') {
      e.preventDefault();
      var code = f.promo.value.trim().toUpperCase();
      if (code === 'HIBLACK5') { S.promo = code; S.promoErr = false; } else { S.promo = ''; S.promoErr = !!code; }
      save(); render();
      return;
    }
    if (f.id === 'co-form') {
      e.preventDefault();
      if (!agreesOk(f, 'Без подтверждения двух обязательных согласий оформить заказ нельзя')) return;
      var d2 = formData(f), items = cartItems();
      var chosen = DEL.filter(function (x) { return x[0] === d2.deliv; })[0] || DEL[0];
      var total = cartPricing(items).net + (chosen[3] || 0);
      S.co = d2;
      var btn = f.querySelector('button[type=submit]');
      var was = btn.innerHTML;
      btn.disabled = true; btn.textContent = 'Отправляем…';
      (OFFLINE ? Promise.reject(new Error('offline')) : submitOrder(d2, items, total))
        .then(function (res) { finishOrder(d2, res.number, false); })
        .catch(function () {
          if (OFFLINE) return finishOrder(d2, 10240 + (S.orders = (S.orders || 0) + 1), true);
          btn.disabled = false; btn.innerHTML = was;
          showToast('Не удалось отправить заказ. Корзина сохранена — попробуйте ещё раз или позвоните нам.');
        });
      return;
    }
    if (f.id === 'contact-form') {
      e.preventDefault();
      if (!agreesOk(f, 'Без согласия на обработку персональных данных отправить обращение нельзя')) return;
      f.querySelectorAll('.fld').forEach(function (l) { l.classList.remove('bad'); });
      var need = ['name', 'email', 'message'], miss = null;
      need.forEach(function (k) {
        var el = f.elements[k];
        if (!el || miss) return;
        if (!String(el.value).trim() || (k === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value.trim()))) miss = el;
      });
      if (miss) { var fl = miss.closest('.fld'); if (fl) fl.classList.add('bad'); miss.focus(); return; }
      var cbtn = f.querySelector('button[type=submit]'), cwas = cbtn.innerHTML;
      cbtn.disabled = true; cbtn.textContent = 'Отправляем…';
      var cbody = { type: 'contact', name: f.elements.name.value.trim(), email: f.elements.email.value.trim(), phone: f.elements.phone.value.trim(), topic: f.elements.topic.value, note: f.elements.message.value.trim() };
      (OFFLINE ? Promise.reject(new Error('offline')) : fetch('/api/callback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cbody),
      }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }))
        .then(function (res) {
          if (!res || !res.ok) throw new Error('Обращение не подтверждено сервером');
          cbtn.disabled = false; cbtn.innerHTML = cwas;
          f.reset();
          showToast(ic('check', 18) + '<span>Обращение отправлено. Ответим в рабочее время.</span>');
        }).catch(function () {
          cbtn.disabled = false; cbtn.innerHTML = cwas;
          showToast('Не удалось отправить обращение. Попробуйте ещё раз или позвоните нам.');
        });
      return;
    }
    /*
      Отзыв.

      Раньше эта строка просто заменяла форму на «Спасибо за отзыв!» —
      не отправив ничего и нигде ничего не сохранив. Человек уходил
      уверенным, что отзыв написан, а его не существовало.

      Теперь форма делает ровно то, о чём сообщает:
        • проверяет, что есть имя и текст, и что текст не в два слова;
        • блокирует кнопку на время отправки и запоминает отправленное,
          чтобы повторное нажатие не создало второй такой же отзыв;
        • отправляет POST /api/review, где сервер кладёт запись в
          очередь модерации со статусом pending;
        • сообщает именно то, что произошло: отправлено на проверку —
          не «опубликовано»;
        • а там, где сервера нет (превью, файл «всё в одном»), честно
          говорит, что отправлять некуда, вместо ложного «Спасибо».
    */
    if (f.id === 'rev-form') {
      e.preventDefault();
      var rmsg = f.querySelector('#rev-msg');
      var say = function (kind, text) {
        if (!rmsg) return;
        rmsg.hidden = false;
        rmsg.className = 'rev-msg rev-msg-' + kind;
        rmsg.textContent = text;
      };
      var rname = (f.elements.name.value || '').trim();
      var remail = (f.elements.email.value || '').trim();
      var rtext = (f.elements.text.value || '').trim();
      var rated = f.querySelector('input[name=rate]:checked');
      var rgroup = f.querySelector('#rev-rate');
      /* Порядок проверок — порядок полей на экране: человеку не за чем
         прыгать снизу вверх к ошибке, о которой ему скажут позже. */
      if (rgroup) rgroup.classList.toggle('bad', !rated);
      if (!rated) {
        say('bad', 'Поставьте оценку от 1 до 5 — заранее мы её за вас не выбираем.');
        var firstStar = f.querySelector('input[name=rate]');
        if (firstStar) firstStar.focus();
        return;
      }
      if (!rname) { say('bad', 'Укажите имя — без него отзыв не принимаем.'); f.elements.name.focus(); return; }
      /*
        Адрес проверяется по форме, а не по списку доменов: чей-то
        редкий почтовый домен — не повод отказать в отзыве. Проверка
        одна и та же на клиенте и на сервере, потому что клиентскую
        легко обойти, а серверная одна оставляет человека без внятного
        объяснения.
      */
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(remail)) {
        say('bad', 'Проверьте e-mail: он нужен, чтобы модератор мог связаться с вами по этому отзыву. Публиковать его мы не будем.');
        f.elements.email.focus(); return;
      }
      if (rtext.length < 20) { say('bad', 'Напишите хотя бы пару предложений: по двум словам другому покупателю не понять, подошёл расходник или нет.'); f.elements.text.focus(); return; }

      /* Повторную отправку того же текста на тот же товар не делаем:
         дрогнувшая рука не должна превращаться в два одинаковых отзыва
         в очереди модерации. */
      var rkey = 'hb-rev:' + f.dataset.revForm + ':' + rtext.length + ':' + rtext.slice(0, 40);
      try { if (sessionStorage.getItem(rkey)) { say('ok', 'Этот отзыв уже отправлен на проверку.'); return; } } catch (err) { }

      var rbtn = f.querySelector('button[type=submit]'), rwas = rbtn.innerHTML;
      rbtn.disabled = true; rbtn.textContent = 'Отправляем…';
      var rbody = {
        product: f.dataset.revForm,
        name: rname,
        /* Адрес уходит только в очередь модерации. На витрину он не
           попадает ни в каком виде — ни в карточку, ни в разметку. */
        email: remail,
        rate: Number(rated.value),
        printer: (f.elements.printer.value || '').trim(),
        text: rtext,
      };
      (OFFLINE
        ? Promise.reject(new Error('offline'))
        : fetch('/api/review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rbody),
        }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }))
        .then(function () {
          try { sessionStorage.setItem(rkey, '1'); } catch (err) { }
          /* reset снимает и оценку: форма снова открывается пустой. */
          f.reset();
          if (rgroup) rgroup.classList.remove('bad');
          say('ok', 'Отзыв отправлен на проверку. Он появится на странице после модерации — обычно в течение рабочего дня.');
        })
        .catch(function (err) {
          say('bad', String(err && err.message) === 'offline'
            ? 'Это превью — статические страницы без сервера, отправлять отзыв некуда. Ничего не отправлено и нигде не сохранено. На рабочем сайте эта же форма отправляет отзыв на модерацию.'
            : 'Не удалось отправить отзыв: сервер не принял запрос. Ничего не сохранено — попробуйте ещё раз позже.');
        })
        .then(function () { rbtn.disabled = false; rbtn.innerHTML = rwas; });
      return;
    }
    if (f.id === 'login-form') { e.preventDefault(); showToast('В прототипе вход не выполняется'); return; }
  });
  function finishOrder(d, number, offline) {
    S.lastOrder = { n: number, name: d.name, email: d.email, deliv: d.deliv, offline: offline };
    S.cart = {}; S.promo = '';
    save();
    go(url('/order/' + number));
  }

  /* ------------------------------------------------------------ меню */
  var btn = document.getElementById('catbtn'), menu = document.getElementById('catmenu');
  function closeMenu() { if (menu) { menu.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    var o = menu.classList.toggle('open');
    btn.classList.toggle('open', o);
    btn.setAttribute('aria-expanded', o ? 'true' : 'false');
  });
  document.addEventListener('click', function (e) { if (menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); });

  var mob = document.getElementById('mobmenu'), mobbtn = document.getElementById('mobbtn');
  function openMob() { mob.classList.add('open'); mob.setAttribute('aria-hidden', 'false'); mobbtn.setAttribute('aria-expanded', 'true'); document.body.classList.add('noscroll'); }
  function closeMob() {
    if (!mob || !mob.classList.contains('open')) return;
    mob.classList.remove('open'); mob.setAttribute('aria-hidden', 'true'); mobbtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('noscroll');
  }
  mobbtn.addEventListener('click', function () { if (mob.classList.contains('open')) closeMob(); else openMob(); });
  mob.addEventListener('click', function (e) { if (e.target.closest('a') || e.target.closest('[data-mm-close]')) closeMob(); });

  /*
    Обратный звонок. Заявка уходит тем же путём, что и заказ, отдельным типом:
    без сервера (в сборке одним файлом) показываем, что заявка принята, — форма
    нужна и в макете, и кнопка не должна выглядеть мёртвой.
  */
  var cb = document.getElementById('callback'), cbPrev = null;
  function cbOpen() {
    cbPrev = document.activeElement;
    cb.classList.add('open'); cb.setAttribute('aria-hidden', 'false');
    document.body.classList.add('noscroll');
    var f = cb.querySelector('input[name=name]'); if (f) setTimeout(function () { f.focus(); }, 60);
  }
  function cbClose() {
    cb.classList.remove('open'); cb.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('noscroll');
    if (cbPrev && cbPrev.focus) cbPrev.focus();
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-callback]')) { e.preventDefault(); closeMob(); cbOpen(); return; }
    if (e.target.closest('[data-cb-close]')) cbClose();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && cb.classList.contains('open')) cbClose(); });
  document.getElementById('cb-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, name = f.elements.name.value.trim(), phone = f.elements.phone.value.replace(/[^0-9+]/g, '');
    f.querySelectorAll('.fld').forEach(function (l) { l.classList.remove('bad'); });
    if (!agreesOk(f, 'Без согласия на обработку персональных данных заявку отправить нельзя')) return;
    if (!name) { f.querySelector('input[name=name]').closest('.fld').classList.add('bad'); f.elements.name.focus(); return; }
    if (phone.replace(/\D/g, '').length < 10) { f.querySelector('input[name=phone]').closest('.fld').classList.add('bad'); f.elements.phone.focus(); return; }
    var btn = f.querySelector('button[type=submit]'), was = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Отправляем…';
    var body = { type: 'callback', name: name, phone: f.elements.phone.value.trim(), note: f.elements.note.value.trim() };
    (OFFLINE ? Promise.reject(new Error('offline')) : fetch('/api/callback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }))
      .then(function (res) {
        if (!res || !res.ok) throw new Error('Заявка не подтверждена сервером');
        btn.disabled = false; btn.innerHTML = was;
        f.reset(); cbClose();
        showToast(ic('check', 18) + '<span>Заявка принята. Перезвоним в рабочее время.</span>');
      }).catch(function () {
        btn.disabled = false; btn.innerHTML = was;
        showToast('Не удалось отправить заявку. Попробуйте ещё раз или позвоните нам.');
      });
  });

  /*
    Быстрый заказ. Это не оформление: ни адреса, ни доставки, ни оплаты —
    только имя, телефон и два обязательных согласия. Остальное менеджер
    уточняет по телефону, поэтому спрашивать это в модалке нечего.
  */
  var qm = document.getElementById('quick'), qPrev = null, qItem = null;
  function qOpen(id, q) {
    var p = C.byId(id); if (!p || !qm || !p.stock || noPrice(p)) return;
    qItem = { p: p, q: Math.max(1, q | 0) };
    var sum = p.price * qItem.q;
    document.getElementById('q-prod').innerHTML =
      imgHtml(p, {}) +
      '<div class="qp-t"><b>' + esc(p.name) + '</b><span>Артикул ' + esc(p.code) + '</span></div>' +
      '<div class="qp-s"><span>' + qItem.q + ' шт. × ' + fmt(p.price) + ' ₽</span><b>' + fmt(sum) + ' ₽</b></div>';
    var f = document.getElementById('q-form');
    f.reset();
    /* Галочки не должны «помнить» прошлое открытие: согласие даётся заново. */
    f.querySelectorAll('.agree').forEach(function (l) { l.classList.remove('bad'); });
    f.querySelectorAll('.fld').forEach(function (l) { l.classList.remove('bad'); });
    var box = f.querySelector('.agrees'); if (box) box.classList.remove('bad');
    var err = f.querySelector('.agree-err'); if (err) err.hidden = true;
    f.querySelectorAll('.fld-err').forEach(function (n) { n.remove(); });
    qPrev = document.activeElement;
    qm.classList.add('open'); qm.setAttribute('aria-hidden', 'false');
    document.body.classList.add('noscroll');
    setTimeout(function () { var n = f.elements.name; if (n) n.focus(); }, 60);
  }
  function qClose() {
    if (!qm || !qm.classList.contains('open')) return;
    qm.classList.remove('open'); qm.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('noscroll');
    if (qPrev && qPrev.focus) qPrev.focus();
  }
  function fldErr(el, msg) {
    var fld = el.closest('.fld'); if (!fld) return;
    fld.classList.add('bad');
    if (!fld.querySelector('.fld-err')) {
      var n = document.createElement('span');
      n.className = 'fld-err'; n.textContent = msg;
      fld.appendChild(n);
    } else fld.querySelector('.fld-err').textContent = msg;
    el.focus();
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-quick]');
    if (t) { e.preventDefault(); qOpen(t.dataset.quick, t.dataset.qty ? +t.dataset.qty : pickedQty()); return; }
    if (e.target.closest('[data-q-close]')) qClose();
    /* Ссылка из модалки уводит на страницу — окно надо закрыть, иначе фон
       останется заблокированным. */
    var a = e.target.closest('.modal.open a[href]');
    if (a && a.getAttribute('href') && a.getAttribute('href')[0] !== '#') { qClose(); cbClose(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') qClose(); });
  if (qm) document.getElementById('q-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    f.querySelectorAll('.fld').forEach(function (l) { l.classList.remove('bad'); });
    f.querySelectorAll('.fld-err').forEach(function (n) { n.remove(); });
    var name = f.elements.name.value.trim(), phone = f.elements.phone.value.trim();
    if (!name) { fldErr(f.elements.name, 'Укажите имя — менеджеру нужно знать, к кому обращаться'); return; }
    if (phone.replace(/\D/g, '').length < 10) { fldErr(f.elements.phone, 'Укажите телефон из 10 цифр — по нему подтвердим заказ'); return; }
    if (!agreesOk(f, 'Без подтверждения двух обязательных согласий оформить заказ нельзя')) return;
    if (!qItem) return;
    var btn = f.querySelector('button[type=submit]'), was = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Отправляем…';
    var d = { name: name, phone: phone, type: 'quick' };
    var items = [{ p: qItem.p, q: qItem.q }], total = qItem.p.price * qItem.q;
    (OFFLINE ? Promise.reject(new Error('offline')) : submitOrder(d, items, total))
      .then(function (res) { finishQuick(d, res.number, false); })
      .catch(function () {
        if (OFFLINE) return finishQuick(d, 10240 + (S.orders = (S.orders || 0) + 1), true);
        showToast('Не удалось отправить заказ. Попробуйте ещё раз или позвоните нам.');
      })
      .then(function () { btn.disabled = false; btn.innerHTML = was; });
  });
  function finishQuick(d, number, offline) {
    /* Корзину быстрый заказ не трогает: это отдельная покупка одного товара. */
    S.lastOrder = { n: number, name: d.name, email: '', deliv: '', offline: offline, quick: true };
    save();
    qClose();
    go(url('/order/' + number));
  }

  var lb = document.getElementById('lightbox');
  var lbFrom = null;
  /*
    Состояние галереи — одно на страницу.

    gFrames — кадры текущего товара по порядку, gFrame — какой из них
    выбран, gView — какой вид открыт (снимок или «Совместимость»).
    Читают это и миниатюры, и основное фото, и увеличение, поэтому
    разойтись им негде. При переходе на другой товар список сбрасывается
    в render() — иначе на новой карточке остался бы кадр предыдущей.
  */
  var gFrames = [], gFrame = 0, gView = 0;
  /*
    Увеличение фотографии.

    Открывается и нажатием, и с клавиатуры: у площадки роль кнопки и
    свой tabindex, поэтому Enter и пробел работают так же, как щелчок.
    Закрывается щелчком по фону, крестиком и Esc, после чего фокус
    возвращается туда, откуда пришёл, — иначе человек с клавиатурой
    остаётся в начале страницы.

    Картинка показывается в том размере, какой есть в источнике. У
    позиций из атласа это 240 пикселей: крупнее снимка поставщика здесь
    нет, и растягивать его, изображая чёткость, нечестно — вместо этого
    под фотографией стоит прямая оговорка.
  */
  /*
    Увеличение открывает ВЫБРАННЫЙ кадр.

    Прежде эта функция смотрела на data-src площадки — адрес первого
    снимка, записанный при отрисовке, — и о выборе миниатюры не знала
    ничего. Выбрана вторая, открывается первая. Теперь кадр берётся из
    того же gFrame, по которому подсвечена миниатюра и показано основное
    фото, так что все трое всегда сходятся.
  */
  /*
    Увеличение, которое действительно увеличивает.

    Как было. У картинки в окне стояли только max-width и max-height, а
    браузер без заданного размера рисует <img> в натуральную величину.
    У собственных снимков магазина натуральная величина — 400×283 (для
    HB-KX-FAT410A7 это /assets/img/products/p_388.webp), а площадка на
    карточке шире пятисот пикселей и вписывает снимок в себя. Нажатие на
    «Открыть фото» делало картинку МЕНЬШЕ, чем она была на странице.

    Как стало. Кадр вписывается в сцену размером почти во весь экран —
    пропорции считаются от натурального размера, ничего не обрезается и
    не растягивается. Дальше работает масштабирование: колесо, кнопки,
    двойное нажатие, «плюс» и «минус» с клавиатуры, щипок на телефоне;
    перетаскивание двигает увеличенный кадр.

    Маленький исходник этим не «чинится» — подменять его чужим снимком
    нельзя. Он так же вписывается в сцену и так же масштабируется, а
    рядом честно написано, какого он размера на самом деле.
  */
  var lbStage = document.getElementById('lb-stage');
  var lbZoom = 1, lbX = 0, lbY = 0, lbFit = { w: 0, h: 0 }, lbNat = { w: 0, h: 0 };
  var LB_MAX = 4, LB_STEP = 1.4;

  /*
    Размер сцены берётся у самой сцены, а не считается заново.

    Раньше поля были записаны числами и в двух местах: в скрипте и в
    стилях. Они разошлись, и подпись про размер исходника легла поверх
    снимка. Теперь отступы задаёт только CSS, а скрипт спрашивает
    готовый размер — расходиться нечему.
  */
  function lbBox() {
    var r = lbStage ? lbStage.getBoundingClientRect() : null;
    if (!r || r.width < 40) return { w: Math.max(80, window.innerWidth - 32), h: Math.max(80, window.innerHeight - 160) };
    return { w: Math.max(80, r.width), h: Math.max(80, r.height) };
  }
  function lbApply() {
    var el = lb.querySelector('img'), at = lb.querySelector('.lb-atlas');
    var node = (el && !el.hidden) ? el : at;
    if (!node) return;
    node.style.transform = 'translate(' + lbX.toFixed(1) + 'px,' + lbY.toFixed(1) + 'px) scale(' + lbZoom.toFixed(3) + ')';
    node.style.cursor = lbZoom > 1 ? 'grab' : 'zoom-in';
    var sc = lb.querySelector('.lb-scale');
    /* Проценты считаются от НАТУРАЛЬНОГО размера файла, а не от
       вписанного: человеку важно, во сколько раз он видит оригинал. */
    if (sc) sc.textContent = lbNat.w ? Math.round(lbFit.w * lbZoom / lbNat.w * 100) + '%' : Math.round(lbZoom * 100) + '%';
    var minus = lb.querySelector('[data-zoom="-1"]'), plus = lb.querySelector('[data-zoom="1"]');
    if (minus) minus.disabled = lbZoom <= 1.001;
    if (plus) plus.disabled = lbZoom >= LB_MAX - 0.001;
  }
  /* Сдвиг ограничен так, чтобы кадр нельзя было утащить за пределы сцены
     и потерять из виду. */
  function lbClamp() {
    var box = lbBox();
    var w = lbFit.w * lbZoom, h = lbFit.h * lbZoom;
    var mx = Math.max(0, (w - box.w) / 2), my = Math.max(0, (h - box.h) / 2);
    lbX = Math.min(mx, Math.max(-mx, lbX));
    lbY = Math.min(my, Math.max(-my, lbY));
  }
  function lbFitNow() {
    var el = lb.querySelector('img'), at = lb.querySelector('.lb-atlas');
    var box = lbBox();
    if (el && !el.hidden && el.naturalWidth) {
      lbNat = { w: el.naturalWidth, h: el.naturalHeight };
      var k = Math.min(box.w / lbNat.w, box.h / lbNat.h);
      lbFit = { w: Math.round(lbNat.w * k), h: Math.round(lbNat.h * k) };
      el.style.width = lbFit.w + 'px';
      el.style.height = lbFit.h + 'px';
    } else if (at && !at.hidden) {
      /* Ячейка атласа — квадрат 240 пикселей: другого исходника нет. */
      lbNat = { w: 240, h: 240 };
      var side = Math.min(box.w, box.h);
      lbFit = { w: side, h: side };
      at.style.width = side + 'px';
      at.style.height = side + 'px';
    } else return;
    lbClamp();
    lbApply();
  }
  function lbSetZoom(z, ox, oy) {
    var was = lbZoom;
    lbZoom = Math.min(LB_MAX, Math.max(1, z));
    if (lbZoom === was) return;
    if (ox != null) {
      /* Точка под курсором остаётся на месте — иначе кадр уезжает
         из-под пальца и приходится искать деталь заново. */
      var r = lbZoom / was;
      lbX = ox - (ox - lbX) * r;
      lbY = oy - (oy - lbY) * r;
    }
    if (lbZoom === 1) { lbX = 0; lbY = 0; }
    lbClamp();
    lbApply();
  }
  function lbResetZoom() { lbZoom = 1; lbX = 0; lbY = 0; lbApply(); }

  function showFrameInLb(k) {
    var g = document.getElementById('gmain'); if (!g) return false;
    var img = lb.querySelector('img'), at = lb.querySelector('.lb-atlas'), note = lb.querySelector('.lb-note');
    var f = gFrames[k];
    lbResetZoom();
    if (f && !f.atlas && f.src) {
      /*
        Для увеличения берётся САМЫЙ КРУПНЫЙ файл этого товара.

        Кадр на странице и кадр в окне — не обязательно один файл. Рядом
        с миниатюрой атласа может лежать оригинал поставщика, и в окно
        идёт он. Но только этого товара и только этого кадра: подменять
        мелкий снимок чужим крупным нельзя — покупатель будет
        рассматривать не то, что заказывает.
      */
      var full = k === 0 ? g.querySelector('.g-full') : null;
      img.src = (full && full.complete && full.naturalWidth > 0) ? (full.currentSrc || full.src) : f.src;
      img.alt = f.alt || '';
      img.hidden = false; at.hidden = true;
      at.style.width = ''; at.style.height = '';
      note.hidden = true; note.textContent = '';
      var fit = function () {
        lbFitNow();
        /*
          Выбран крупный план — увеличение открывает ИМЕННО его.

          Это и было сломано: фрагмент выбирали, а открывался общий вид.
          Фрагмент здесь не отдельная картинка, а точка на снимке и
          масштаб, поэтому открыть его — значит приблизить кадр к этой
          точке. Дальше человек волен отдалить и посмотреть целиком.
        */
        if (f.crop) {
          lbZoom = 2.2;
          lbX = (0.5 - f.crop.x) * lbFit.w * lbZoom;
          lbY = (0.5 - f.crop.y) * lbFit.h * lbZoom;
          lbClamp();
          lbApply();
        }
        /* Про маленький исходник говорим прямо, а не прячем его за
           растягиванием: видно, во сколько раз кадр уже увеличен. */
        /* Порог не выдуман: собственные снимки магазина не больше 520
           пикселей, снимки поставщика — от 600. Оговорка нужна первым и
           только им, иначе она стояла бы почти на каждой карточке и её
           перестали бы читать. */
        if (img.naturalWidth && Math.max(img.naturalWidth, img.naturalHeight) < 560) {
          note.hidden = false;
          note.textContent = 'Исходный снимок ' + img.naturalWidth + '×' + img.naturalHeight + ' пикселей — ' +
            'крупнее у этой позиции нет. Масштаб и перетаскивание работают, но при сильном увеличении кадр будет мягче.';
        } else { note.hidden = true; note.textContent = ''; }
      };
      if (img.complete && img.naturalWidth) fit();
      else img.onload = fit;
    } else {
      var cell = g.querySelector('.atimg');
      if (!cell) return false;
      img.onload = null;
      img.hidden = true; img.removeAttribute('src'); img.alt = '';
      img.style.width = ''; img.style.height = '';
      at.hidden = false;
      at.style.backgroundImage = cell.style.backgroundImage;
      at.style.backgroundSize = cell.style.backgroundSize;
      at.style.backgroundPosition = cell.style.backgroundPosition;
      at.setAttribute('aria-label', (f && f.alt) || g.getAttribute('aria-label') || 'Фото товара');
      note.hidden = false;
      note.textContent = 'Снимок поставщика доступен только в размере 240 пикселей — более крупного исходника у этой позиции нет.';
      lbFitNow();
    }
    gFrame = k;
    lbCount();
    return true;
  }
  /* Счётчик и стрелки появляются только там, где кадров правда несколько. */
  function lbCount() {
    var many = gFrames.length > 1;
    var c = lb.querySelector('.lb-count'), pv = lb.querySelector('[data-lb="-1"]'), nx = lb.querySelector('[data-lb="1"]');
    if (c) { c.hidden = !many; c.textContent = many ? (gFrame + 1) + ' / ' + gFrames.length : ''; }
    if (pv) pv.hidden = !many;
    if (nx) nx.hidden = !many;
  }
  function lbStep(dir) {
    if (gFrames.length < 2) return;
    var k = (gFrame + dir + gFrames.length) % gFrames.length;
    if (!showFrameInLb(k)) return;
    /* Стрелки двигают тот же выбор, что и миниатюры: закрыв увеличение,
       человек остаётся на кадре, до которого долистал. */
    showView(k);
  }
  function openPhoto() {
    var g = document.getElementById('gmain');
    if (!g) return;
    if (!gFrames.length) return;
    var k = Math.min(Math.max(0, gFrame), gFrames.length - 1);
    if (!showFrameInLb(k)) return;
    lbFrom = g;
    lb.hidden = false;
    lb.classList.add('open');
    var zp = lb.querySelector('.lb-zoom'); if (zp) zp.hidden = false;
    /* Размер сцены известен только после показа окна: пока оно скрыто,
       считать вписывание не по чему. */
    lbFitNow();
    var x = lb.querySelector('.x'); if (x) x.focus();
  }
  /* Снимок из закрытого окна тоже убирается: пока он там лежал, на
     следующем товаре в разметке оставался кадр предыдущего. */
  function lbReset() {
    var img = lb.querySelector('img'), at = lb.querySelector('.lb-atlas'), note = lb.querySelector('.lb-note');
    if (img) { img.onload = null; img.removeAttribute('src'); img.alt = ''; img.hidden = false; img.style.width = ''; img.style.height = ''; }
    if (at) { at.hidden = true; at.style.backgroundImage = ''; at.style.width = ''; at.style.height = ''; }
    if (note) { note.hidden = true; note.textContent = ''; }
    var zp = lb.querySelector('.lb-zoom'); if (zp) zp.hidden = true;
    lbResetZoom();
    lbCount();
  }
  function closePhoto() {
    if (!lb.classList.contains('open')) return;
    /* Масштаб не переживает закрытие: следующий кадр открывается целиком. */
    lbResetZoom();
    lb.classList.remove('open');
    lb.hidden = true;
    if (lbFrom && document.contains(lbFrom)) lbFrom.focus();
    lbFrom = null;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePhoto(); return; }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var g = e.target.closest && e.target.closest('#gmain');
    if (!g || g.classList.contains('no-photo')) return;
    /* Пробел на площадке фото не должен заодно прокручивать страницу. */
    e.preventDefault();
    openPhoto();
  });
  lb.addEventListener('click', function (e) {
    var nav = e.target.closest && e.target.closest('[data-lb]');
    /* Нажатие на стрелку листает кадр, а не закрывает окно. */
    if (nav) { e.stopPropagation(); lbStep(+nav.dataset.lb); return; }
    var z = e.target.closest && e.target.closest('[data-zoom]');
    if (z) {
      e.stopPropagation();
      var d = +z.dataset.zoom;
      if (d === 0) lbResetZoom(); else lbSetZoom(lbZoom * (d > 0 ? LB_STEP : 1 / LB_STEP));
      return;
    }
    /* Щелчок по самому кадру приближает, а не закрывает: закрытие — это
       фон, крестик и Esc. Иначе попытка рассмотреть деталь выкидывала бы
       из окна. */
    if (e.target.closest && e.target.closest('#lb-stage')) {
      e.stopPropagation();
      if (lbDragged) { lbDragged = false; return; }
      var r = lb.getBoundingClientRect();
      lbSetZoom(lbZoom > 1 ? 1 : 2, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
      return;
    }
    closePhoto();
  });
  /*
    Клавиатура: стрелки листают кадры, «плюс» и «минус» масштабируют,
    ноль возвращает исходный размер. Всё то же, что делают кнопки, —
    чтобы окном можно было пользоваться без мыши.
  */
  document.addEventListener('keydown', function (e) {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); lbStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lbStep(1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); lbSetZoom(lbZoom * LB_STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); lbSetZoom(lbZoom / LB_STEP); }
    else if (e.key === '0') { e.preventDefault(); lbResetZoom(); }
  });
  /* Колесо мыши масштабирует к точке под курсором. */
  lb.addEventListener('wheel', function (e) {
    if (!lb.classList.contains('open')) return;
    e.preventDefault();
    var r = lb.getBoundingClientRect();
    lbSetZoom(lbZoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
  }, { passive: false });

  var lbDragged = false;
  /* Перетаскивание мышью работает только когда есть что двигать. */
  (function () {
    var on = false, sx = 0, sy = 0, bx = 0, by = 0;
    lbStage.addEventListener('mousedown', function (e) {
      if (lbZoom <= 1) return;
      on = true; lbDragged = false;
      sx = e.clientX; sy = e.clientY; bx = lbX; by = lbY;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!on) return;
      lbX = bx + (e.clientX - sx); lbY = by + (e.clientY - sy);
      if (Math.abs(e.clientX - sx) > 3 || Math.abs(e.clientY - sy) > 3) lbDragged = true;
      lbClamp(); lbApply();
    });
    window.addEventListener('mouseup', function () { on = false; });
  })();
  /*
    Палец: одним двигаем кадр или листаем, двумя — щипок.

    Листание срабатывает только в исходном масштабе: когда кадр уже
    приближен, горизонтальный жест человек делает, чтобы дотянуться до
    края снимка, а не чтобы уйти на соседний.
  */
  (function () {
    var x0 = null, y0 = null, bx = 0, by = 0, moved = false;
    var pinch = 0, zoom0 = 1;
    var dist = function (t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    lb.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) { pinch = dist(e.touches); zoom0 = lbZoom; x0 = null; return; }
      if (e.touches.length !== 1) { x0 = null; return; }
      pinch = 0; moved = false;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; bx = lbX; by = lbY;
    }, { passive: true });
    lb.addEventListener('touchmove', function (e) {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        lbSetZoom(zoom0 * (dist(e.touches) / pinch));
        return;
      }
      if (x0 === null || lbZoom <= 1) return;
      e.preventDefault();
      lbX = bx + (e.touches[0].clientX - x0); lbY = by + (e.touches[0].clientY - y0);
      moved = true;
      lbClamp(); lbApply();
    }, { passive: false });
    lb.addEventListener('touchend', function (e) {
      if (pinch) { if (!e.touches.length) pinch = 0; return; }
      if (x0 === null || !e.changedTouches || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (moved || lbZoom > 1) return;
      /* Горизонтальный жест — листание, вертикальный оставляем окну. */
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      lbStep(dx < 0 ? 1 : -1);
    }, { passive: true });
  })();
  /* Поворот телефона и изменение окна пересчитывают вписывание. */
  window.addEventListener('resize', function () { if (lb.classList.contains('open')) lbFitNow(); });

  /*
    Переключение вида в галерее.

    Выбранный кадр — одно состояние на всех: миниатюру, основное фото и
    увеличение. Раньше состояний было два — класс «on» у миниатюры и
    отдельно то, что читал лайтбокс, — и они расходились: выбрана вторая
    миниатюра, а «Открыть фото» показывает первую. Теперь номер кадра
    лежит в одном месте (gFrame), и всё остальное читает его.
  */
  function showView(i) {
    var g = document.getElementById('gmain'); if (!g) return;
    var thumbs = app.querySelectorAll('.thumb[data-view]');
    var th = thumbs[i];
    /* Миниатюр может не быть вовсе (один вид) — кадр всё равно первый. */
    if (thumbs.length && !th) return;
    if (th) thumbs.forEach(function (x) { x.classList.toggle('on', x === th); });
    var img = g.querySelector('[data-gview="img"]');
    var zoomEl = g.querySelector('[data-gview="zoom"]');
    gView = i;
    gFrame = Math.min(i, Math.max(0, gFrames.length - 1));
    var f = gFrames[gFrame];
    if (f && f.crop) {
      /* Крупный план — та же фотография, показанная вблизи. Отдельного
         файла у неё нет и быть не должно: это место на снимке. */
      if (zoomEl) {
        zoomEl.style.backgroundImage = 'url(' + f.src + ')';
        zoomEl.style.backgroundPosition = (f.crop.x * 100) + '% ' + (f.crop.y * 100) + '%';
        zoomEl.hidden = false;
        zoomEl.setAttribute('role', 'img');
        zoomEl.setAttribute('aria-label', f.alt || '');
      }
      if (img) img.hidden = true;
    } else {
      if (zoomEl) zoomEl.hidden = true;
      if (f && img && !f.atlas && img.tagName === 'IMG' && f.src && img.getAttribute('src') !== f.src) {
        img.src = f.src;
        img.alt = f.alt || '';
      }
      if (img) img.hidden = false;
    }
    /* Полноразмерный снимок поставщика относится только к первому
       кадру: у остальных своего оригинала нет, и оставленная поверх
       картинка показала бы чужой вид. */
    var full = g.querySelector('.g-full');
    if (full) full.hidden = gFrame !== 0 || !(full.complete && full.naturalWidth > 0);
    g.dataset.frame = String(gFrame);
  }

  var slideIdx = 0, sliderTimer = null;
  function slideTo(i) {
    var sl = document.getElementById('slider'); if (!sl) return;
    var slides = sl.querySelectorAll('.slide'), n = slides.length;
    slideIdx = (i + n) % n;
    slides.forEach(function (x, k) { x.classList.toggle('on', k === slideIdx); });
    sl.querySelectorAll('[data-dot]').forEach(function (d, k) { d.classList.toggle('on', k === slideIdx); });
    var ctrl = sl.querySelector('.sctrl'); if (ctrl) ctrl.classList.toggle('dark', slideIdx !== 0);
  }
  function restartSlider() {
    clearInterval(sliderTimer); sliderTimer = null;
    if (document.getElementById('slider')) sliderTimer = setInterval(function () { if (!document.hidden) slideTo(slideIdx + 1); }, 6500);
  }
  function initSlider() {
    var sl = document.getElementById('slider');
    clearInterval(sliderTimer); sliderTimer = null; slideIdx = 0;
    if (!sl) return;
    restartSlider();
    sl.addEventListener('mouseenter', function () { clearInterval(sliderTimer); sliderTimer = null; });
    sl.addEventListener('mouseleave', restartSlider);
    var x0 = null;
    sl.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    sl.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) { slideTo(slideIdx + (dx < 0 ? 1 : -1)); restartSlider(); }
      x0 = null;
    });
  }

  /*
    Закреплённая панель покупки на странице товара.

    Наблюдаем не за карточкой покупки целиком, а именно за кнопкой «В корзину».
    Карточка высокая и на десктопе липкая: она подолгу остаётся на экране,
    когда самой кнопки уже не видно, — а дубль нужен ровно тогда, когда из
    видимой области ушла кнопка.

    Направление прокрутки роли не играет. isIntersecting=false означает, что
    кнопки на экране нет совсем — неважно, ушла она вверх или ещё не доехала
    снизу. На телефоне блок покупки лежит под галереей, и при открытии
    страницы кнопки не видно: панель нужна и там, иначе покупать нечем.

    Панель показывается только если покупка вообще возможна: нет кнопки или
    она заблокирована — панель убирается из разметки, дублировать нечего.
  */
  var bbObs = null;
  var bbResize = null;
  function measureBuybar(bar) {
    if (!bar || !bar.isConnected) return;
    var h = Math.round(bar.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--buybar-h', h + 'px');
  }
  function initBuybar() {
    if (bbObs) { bbObs.disconnect(); bbObs = null; }
    var bar = document.getElementById('buybar');
    if (!bar) return;
    var btn = app.querySelector('.buy [data-add], .buy [data-stock-alert]');
    if (!btn || btn.disabled || btn.hasAttribute('aria-disabled')) { bar.remove(); return; }
    syncBuybar();
    /*
      Высота панели зависит от ширины экрана и от длины названия: на
      телефоне она складывается в столбец и занимает вдвое больше, чем на
      десктопе. Запас под неё в конце страницы считает CSS, поэтому число
      надо измерить, а не угадать — угаданное давало белую полосу под
      футером на всю ширину экрана.
    */
    measureBuybar(bar);
    if (!('IntersectionObserver' in window)) { bar.remove(); return; }
    bbObs = new IntersectionObserver(function (en) {
      var on = !en[0].isIntersecting;
      bar.classList.toggle('show', on);
      /* Скринридер не должен находить панель, пока она уехала за край. */
      bar.setAttribute('aria-hidden', on ? 'false' : 'true');
      /* Плашке cookie и всплывающему уведомлению есть куда подняться. */
      document.body.classList.toggle('bar-on', on);
      /* Мерить имеет смысл, когда панель видна: у скрытой высота нулевая
         на части браузеров. */
      if (on) measureBuybar(bar);
    }, { threshold: 0 });
    bbObs.observe(btn);
    /* Поворот экрана меняет и ширину панели, и число строк в названии. */
    if (bbResize) window.removeEventListener('resize', bbResize);
    bbResize = function () { measureBuybar(document.getElementById('buybar')); };
    window.addEventListener('resize', bbResize);
  }

  /*
    Уведомление о cookie. Показывается один раз: отметка живёт в localStorage,
    поэтому при недоступном хранилище (приватный режим) баннер просто появится
    снова — это лучше, чем упасть с ошибкой.
  */
  (function () {
    /* Ключ с версией: когда текст или вид уведомления меняются, согласие
       спрашивается заново — старая отметка hb-cookie-ok больше не читается. */
    var box = document.getElementById('cookie'), KEY = 'hb_cookie_consent_v2';
    if (!box) return;
    var ok = false;
    try { ok = localStorage.getItem(KEY) === '1'; } catch (e) { }
    if (window.HB_STATIC || ok) return;
    box.hidden = false;
    document.body.classList.add('has-cookie');
    /* Карточка плавает над нижним краем, и её высота зависит от ширины экрана.
       Меряем расстояние от её верха до низа окна — по нему поднимаются
       всплывающие уведомления, чтобы не оказаться под ней. */
    var fit = function () {
      var r = box.getBoundingClientRect();
      document.documentElement.style.setProperty('--cookie-h', Math.round(window.innerHeight - r.top) + 'px');
    };
    fit();
    window.addEventListener('resize', fit);
    document.getElementById('cookie-ok').addEventListener('click', function () {
      box.hidden = true;
      document.body.classList.remove('has-cookie');
      window.removeEventListener('resize', fit);
      document.documentElement.style.removeProperty('--cookie-h');
      try { localStorage.setItem(KEY, '1'); } catch (e) { }
    });
  })();

  /* Точка входа для сборщика статических страниц (tools/build-seo.mjs):
     он переключает адрес и дожидается отрисовки, чтобы снять готовый HTML. */
  window.HBRender = render;

  /* Старт: пока каталог грузится, на экране остаётся предрендер страницы. */
  /* Подвал статичен, поэтому элемент MAX собирается здесь — из той же
     настройки, что и остальные точки. Пока адреса нет, в разметке остаётся
     span без href; когда адрес появится, узел заменяется на настоящую ссылку. */
  function fillMaxLinks() {
    var m = maxCfg();
    var nodes = document.querySelectorAll('[data-max-link]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!m) { node.hidden = true; continue; }
      var inner = maxIcon(26) + '<span>Написать в MAX</span>' +
        (maxOn() ? '' : '<i class="maxnote">' + maxPending() + '</i>');
      var html = maxEl('fmax', 'Написать нам в мессенджере MAX, откроется в новой вкладке', inner)
        .replace('class="fmax', 'data-max-link class="fmax');
      node.outerHTML = html;
    }
  }

  C.ready().then(fillMaxLinks).then(render).catch(function (e) {
    app.innerHTML = '<div class="wrap"><div class="empty big"><h3>Каталог недоступен</h3><p>' + esc(e.message) + '</p></div></div>';
  });
})();
