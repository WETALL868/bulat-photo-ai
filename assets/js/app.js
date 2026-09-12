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
    return Object.keys(S.cart).map(function (id) { return { p: C.byId(id), q: S.cart[id] }; }).filter(function (x) { return x.p && x.q > 0; });
  }
  function cartCount() { return cartItems().reduce(function (a, x) { return a + x.q; }, 0); }
  function cartSum() { return cartItems().reduce(function (a, x) { return a + x.q * x.p.price; }, 0); }
  function count(o) { return Object.keys(o).filter(function (k) { return o[k]; }).length; }
  function updateHeader() {
    document.getElementById('cart-n').textContent = cartCount();
    document.getElementById('cart-sum').textContent = fmt(cartSum()) + ' ₽';
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
  function sortList(l, s) {
    var by = function (f) { return function (a, b) { return f(a, b) || a.row - b.row; }; };
    l = l.slice();
    if (s === 'price') l.sort(by(function (a, b) { return a.price - b.price; }));
    else if (s === '-price') l.sort(by(function (a, b) { return b.price - a.price; }));
    else if (s === 'rating') l.sort(by(function (a, b) { return b.rate - a.rate || b.reviews - a.reviews; }));
    else if (s === 'new') l.sort(by(function (a, b) { return hash(b.id) - hash(a.id); }));
    else l.sort(function (a, b) { return a.row - b.row; });
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
    /* Пометка демо идёт первой и не прячется: товар из проверочной
       выгрузки должен быть виден как проверочный в любом списке. */
    var demo = p.demo ? '<span class="badge badge-demo">ДЕМО</span>' : '';
    if (p.badge === 'hit') return demo + '<span class="badge badge-hit">Хит</span>';
    if (p.badge === 'res') return demo + '<span class="badge badge-new">Увеличенный ресурс</span>';
    return demo;
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
    if (p.color) s.push('<span><b>' + p.color + '</b></span>');
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
  /*
    Закреплённая панель показывает то же, что и карточка покупки: сколько штук
    уйдёт по нажатию и сколько этого товара уже лежит в корзине. Иначе человек,
    поставивший «3 шт.» наверху, нажимал бы внизу кнопку, не понимая, что
    добавит три, и не видел бы результата — панель закрывает сам счётчик шапки.
  */
  function syncBuybar() {
    var bar = document.getElementById('buybar');
    if (!bar) return;
    var qEl = bar.querySelector('[data-bb-q]');
    if (qEl) {
      var q = pickedQty();
      qEl.hidden = q <= 1;
      qEl.textContent = q > 1 ? q + ' шт.' : '';
    }
    var inEl = bar.querySelector('[data-bb-in]');
    var btn = bar.querySelector('[data-add]');
    if (inEl && btn) {
      var n = S.cart[btn.dataset.add] || 0;
      inEl.hidden = !n;
      inEl.innerHTML = n ? '<i>в корзине</i><b>' + n + '</b>' : '';
    }
  }
  function card(p) {
    var fav = S.fav[p.id] ? ' on' : '', cmp = S.cmp[p.id] ? ' on' : '';
    return '<div class="card" data-id="' + p.id + '">' +
      '<a class="cmedia" href="' + link.product(p) + '"><img src="' + p.img + '" alt="' + esc(p.name) + '" loading="lazy">' + (badge(p) ? '<div class="cbadges">' + badge(p) + '</div>' : '') + '<span class="cbrand" title="Для принтеров ' + esc(C.brandName(p.brand)) + '">' + brandLogo(p.brand, 16) + '</span></a>' +
      '<div class="cacts"><button class="ibtn fav' + fav + '" type="button" data-fav="' + p.id + '" title="' + (S.fav[p.id] ? 'Убрать из избранного' : 'В избранное') + '" aria-label="' + (S.fav[p.id] ? 'Убрать из избранного' : 'В избранное') + '">' + ic('heart', 18) + '</button></div>' +
      '<div class="cbody"><a class="ctitle" href="' + link.product(p) + '">' + esc(p.name) + '</a>' +
      '<div class="crate">' + stars(p.rate) + '<span>' + ratef(p.rate) + '</span><a href="' + link.product(p, { tab: 'reviews' }) + '"><span class="rn">' + p.reviews + '</span><span class="rw"> ' + plural(p.reviews, 'отзыв', 'отзыва', 'отзывов') + '</span></a></div>' +
      '<div class="cspecs">' + specsShort(p) + '</div>' +
      (p.stock ? '<div class="avail"><i></i>В наличии</div>' : '<div class="avail out"><i></i>Под заказ, 3–5 дней</div>') + '</div>' +
      /* Цена и кнопки — отдельный блок, а не хвост описания: в виде списком он
         становится третьей колонкой карточки, в плитке просто идёт следом. */
      '<div class="cside"><div class="cfoot">' + priceBlock(p) +
      (noPrice(p)
        ? '<a class="btn btn-o" href="' + link.page('contacts') + '">' + ic('phone', 18) + 'Запросить</a>'
        : '<button class="btn btn-y" type="button" data-add="' + p.id + '">' + ic('cart', 18) + 'В корзину</button>') + '</div>' +
      /* Иконка в углу карточки читалась как декорация — сравнение получило
         подпись и место в нижнем ряду, рядом с покупкой в один клик. */
      '<div class="cbot">' + (noPrice(p) ? '<span class="oneclick oneclick-off">Цену уточняет менеджер</span>' : '<button class="oneclick" type="button" data-quick="' + p.id + '" data-qty="1">Купить в 1 клик</button>') +
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
  /* Отметка, когда последний раз обновлялись цены. Для магазина, где цены
     приходят из внешней системы, это честная и полезная информация. */
  function priceStamp() {
    if (!C.live || !C.live.updatedAtMoscow) return '';
    return '<div class="stamp">' + ic('refresh', 14) + 'Цены и наличие обновлены ' + esc(C.live.updatedAtMoscow) + '</div>';
  }

  /* ---------------------------------------------------------- страницы */

  function home() {
    return C.featured().then(function (best) {
      var tags = ['HP LaserJet Pro M125', 'Kyocera M2135dn', 'Canon i-SENSYS MF3010', 'Brother HL-L2300', 'Samsung ML-2160', 'Xerox Phaser 3020', 'Pantum P2207', 'Ricoh SP 3400N', 'HP LaserJet 1018', 'Kyocera FS-1040', 'HP LJ Pro M104', 'Canon LBP6030', 'Brother DCP-L2500', 'Kyocera M2040dn', 'Xerox WorkCentre 3025', 'HP LJ Pro 400 M401', 'Epson L3150', 'Canon PIXMA G3411'];
      var tiles = C.cats.slice(0, 3).map(function (c) {
        return '<a class="tile" href="' + link.catalog(c.id) + '"><span class="ph"><img src="' + c.img + '" alt="" loading="lazy"></span>' +
          '<span class="tt"><h3>' + esc(c.name) + '</h3><p>' + esc(c.desc) + '</p>' +
          '<span class="cta">' + c.count + ' ' + plural(c.count, 'товар', 'товара', 'товаров') + ic('arrow-right', 16) + '</span></span></a>';
      }).join('');
      var tilesS = C.cats.slice(3).map(function (c) {
        return '<a class="tile-s" href="' + link.catalog(c.id) + '"><span><b>' + esc(c.name) + '</b><span>' + esc(c.desc) + '</span></span><span class="ph"><img src="' + c.img + '" alt="" loading="lazy"></span></a>';
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
      var sorted = sortList(all, q.sort);
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
      var prices = applyFilters(source, cat, brand, q, 'price').map(function (x) { return x.price; });
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

      var sortOpts = [['pop', 'По популярности'], ['price', 'Сначала дешевле'], ['-price', 'Сначала дороже'], ['rating', 'По рейтингу'], ['new', 'Новинки']];
      var toolbar = '<div class="toolbar"><div class="l"><button class="sel mfilterbtn" type="button" data-open-f>' + ic('sliders', 18) + 'Фильтры' + (applied.length ? ' <i class="fn">' + applied.length + '</i>' : '') + '</button><label class="sel sel-sort' + ((q.sort && q.sort !== 'pop') ? ' picked' : '') + '">' + ic('sort', 18) + '<select data-f="sort" aria-label="Сортировка">' + sortOpts.map(function (o) {
        return '<option value="' + o[0] + '"' + ((q.sort || 'pop') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
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
    return Promise.all([C.detail(p.id), C.family(p.fam)]).then(function (res) {
      var d = res[0] || { compat: '', models: [], specs: [], desc: '', reviews: [] };
      var fam = res[1];
      var tab = r.query.tab || 'desc';
      var related = C.all().filter(function (x) { return x.id !== p.id && x.brand === p.brand && x.cat === p.cat; }).slice(0, 4);
      if (related.length < 4) related = related.concat(C.all().filter(function (x) { return x.id !== p.id && x.cat === p.cat && related.indexOf(x) < 0; }).slice(0, 4 - related.length));
      var revs = d.reviews || [];
      /* Демо-набор определяется по самим записям, а не по флагу товара:
         так пометка не разъедется, если демо-записи появятся где-то ещё. */
      var isDemoRevs = revs.length > 0 && revs.every(function (r) { return r.demo; });
      var sum5 = revs.filter(function (r) { return r.rate === 5; }).length;
      var sum4 = revs.filter(function (r) { return r.rate === 4; }).length;
      /* У демо-набора в шапке показывается средняя по самим демо-записям,
         а не p.rate: p.rate у импортированного товара равен нулю и таким
         обязан остаться — он уходит в микроразметку и в счётчики. Цифру
         из шапки от настоящей отличает пометка ДЕМО рядом с ней и плашка
         над всем блоком. */
      var revAvg = revs.length ? Math.round(revs.reduce(function (a, r) { return a + (r.rate || 0); }, 0) / revs.length * 10) / 10 : 0;
      var headRate = isDemoRevs ? revAvg : p.rate;
      var src = p.img;
      var views = [{ t: 'img' }, { t: 'zoom', pos: '18% 50%' }, { t: 'zoom', pos: '82% 50%' }];
      if (d.models.length) views.push({ t: 'compat' });
      var thumbs = views.map(function (v, i) {
        var inner = v.t === 'img' ? '<img src="' + src + '" alt="">' : (v.t === 'zoom' ? '<span class="tz" style="background-image:url(' + src + ');background-position:' + v.pos + '"></span>' : brandLogo(p.brand, 14, '') + '<span class="tl">Совместимость</span>');
        return '<div class="thumb ' + (i === 0 ? 'on' : '') + (v.t === 'compat' ? ' tcompat' : '') + '" data-view="' + i + '" title="' + (v.t === 'img' ? 'Общий вид' : (v.t === 'zoom' ? 'Крупный план' : 'Совместимые модели')) + '">' + inner + '</div>';
      }).join('');
      var compatCard = '<div class="gcompat" data-gview="compat" hidden>' + brandLogo(p.brand, 34, '') + '<h3>Подходит для принтеров ' + esc(C.brandName(p.brand)) + '</h3><div class="tags">' + d.models.map(function (m) {
        return '<a class="chip" href="' + link.printer(printerKey(p.brand, m)) + '">' + esc(m) + '</a>';
      }).join('') + '</div></div>';
      var key = [];
      if (p.res) key.push(['Ресурс', fmt(p.res) + ' страниц']);
      if (p.color) key.push(['Цвет', p.color]);
      if (p.chip !== null) key.push(['Чип', p.chip ? 'Есть' : 'Нет']);
      if (p.type) key.push(['Тип', p.type]);
      /* «Оригинальный аналог» у импортированного товара берётся из
         OriginalNumber поставщика, а не собирается из бренда и артикула:
         собранная строка была бы догадкой. */
      if (d.originalNumber) key.push(['Оригинальный аналог', d.originalNumber]);
      else if (p.src !== 'vtt' && p.code && p.type !== 'Тонер') {
        key.push(['Оригинальный аналог', C.brandName(p.brand) + ' ' + p.code.replace(/^HB-/i, '')]);
      }
      /* Срок гарантии — обязательство магазина, а не поле выгрузки. Для
         импортированных позиций его здесь нет: подставлять чужому товару
         срок, которого никто не подтверждал, нельзя. */
      if (p.src !== 'vtt') key.push(['Гарантия', '12 месяцев']);
      var compatChips = d.models.map(function (m) {
        return '<a class="chip" href="' + link.printer(printerKey(p.brand, m)) + '">' + esc(C.brandName(p.brand) + ' ' + m) + '</a>';
      }).join('');
      var tabs = [['desc', 'Описание'], ['specs', 'Характеристики'], ['reviews', 'Отзывы <i>' + p.reviews + '</i>'], ['delivery', 'Доставка и оплата']];
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
        '<div class="pmeta"><span class="rate">' + stars(p.rate, 16) + '<b>' + ratef(p.rate) + '</b><a href="#" data-tab-link="reviews">' + p.reviews + ' ' + plural(p.reviews, 'отзыв', 'отзыва', 'отзывов') + '</a></span><span>Артикул: <b>' + esc(p.code) + '</b></span><span>Код товара: <b>' + (100000 + hash(p.id) % 900000) + '</b></span>' + badge(p) + '</div></header>' +
        '<div class="gallery"><div class="gmain" id="gmain" data-src="' + src + '"><img src="' + src + '" alt="' + esc(p.name) + '" data-gview="img"><div class="gzoom" data-gview="zoom" style="background-image:url(' + src + ')" hidden></div>' + compatCard + (badge(p) ? '<div class="cbadges">' + badge(p) + '</div>' : '') + '<span class="gbrand">Для принтеров ' + brandLogo(p.brand, 16, '') + '</span><span class="zoom">' + ic('zoom', 16) + 'Открыть фото</span></div><div class="thumbs">' + thumbs + '</div></div>' +
        '<div class="pinfo"><div class="keyspecs"><h3>Коротко о товаре</h3>' + key.map(function (k) { return '<div class="krow"><span>' + esc(k[0]) + '</span><b>' + esc(k[1]) + '</b></div>'; }).join('') + '</div>' +
        (compatChips ? '<div class="compat"><h3>Подходит для принтеров ' + brandLogo(p.brand, 18, '') + '</h3><div class="tags">' + compatChips + '</div></div>' : '') +
        '<a class="allspecs" href="#" data-spec-jump>Все характеристики ' + ic('chev-down', 16) + '</a></div>' +
        '<div class="buy"><div class="prow">' + priceBlock(p) + '<span class="per">за 1 шт.</span></div>' +
        (p.old && p.old > p.price ? '<div class="saveline">' + ic('percent', 16) + 'Скидка ' + fmt(p.old - p.price) + ' ₽ от прежней цены</div>' : '') +
        (p.stock ? '<div class="avail"><i></i>В наличии на складе в Москве</div><div class="stock">Дату отгрузки подтверждает менеджер</div>' : '<div class="avail out"><i></i>Под заказ</div><div class="stock">Привезём со склада поставщика за 3–5 дней</div>') +
        (noPrice(p)
          ? '<div class="brow"><a class="btn btn-y btn-lg" href="' + link.page('contacts') + '">' + ic('phone', 22) + 'Запросить цену</a></div>' +
            '<div class="stock">Поставщик не передал цену на эту позицию — её подтверждает менеджер.</div>'
          : '<div class="brow"><div class="qty"><button type="button" data-q="-1" aria-label="Меньше" disabled>' + ic('minus', 18) + '</button><span id="pq" data-price="' + p.price + '">1</span><button type="button" data-q="1" aria-label="Больше">' + ic('plus', 18) + '</button></div><button class="btn btn-y btn-lg" type="button" data-add="' + p.id + '" data-useq="1">' + ic('cart', 22) + 'В корзину</button></div>') +
        /* Сумма считается от действующей цены и обновляется на месте: покупателю
           не приходится умножать в уме и гадать, что попадёт в корзину. */
        (noPrice(p) ? '' : '<div class="qsum" id="qsum" aria-live="polite">Итого за <b data-qs-q>1</b> шт.: <b data-qs-t>' + fmt(p.price) + ' ₽</b></div>') +
        /* «Купить в 1 клик» у товара без цены означало бы заказ на сумму,
           которой нет. Кнопки нет — есть запрос цены выше. */
        (noPrice(p) ? '' : '<button class="btn btn-o btn-full" type="button" data-quick="' + p.id + '">Купить в 1 клик</button>') +
        '<div class="acts"><button type="button" class="' + (S.cmp[p.id] ? 'on' : '') + '" data-cmp="' + p.id + '" aria-pressed="' + !!S.cmp[p.id] + '" title="' + (S.cmp[p.id] ? 'Убрать из сравнения' : 'Добавить к сравнению') + '">' + ic('compare', 16) + (S.cmp[p.id] ? 'В сравнении' : 'В сравнение') + '</button><button type="button" class="' + (S.fav[p.id] ? 'on' : '') + '" data-fav="' + p.id + '">' + ic('heart', 16) + (S.fav[p.id] ? 'В избранном' : 'В избранное') + '</button></div>' +
        '<div class="dlist"><div>' + ic('truck', 18) + '<div><b>Курьер по Москве</b><span>Дату и интервал подтверждает менеджер</span></div></div><div>' + ic('pin', 18) + '<div><b>Самовывоз по предварительному согласованию</b><span>Москва, Ясеневая ул., д. 50</span></div></div><div>' + ic('card', 18) + '<div><b>Оплата картой, СБП или по счёту</b><span>Юрлицам — счёт и закрывающие документы</span></div></div><div>' + ic('shield', 18) + '<div><b>Гарантия ресурса</b><span>Срок указан в карточке и документах</span></div></div></div>' +
        (maxCfg()
          ? maxEl('ask-max', 'Написать о товаре ' + p.name + ' в мессенджере MAX, откроется в новой вкладке',
              maxIcon(26) + '<div><b>Написать в MAX</b>' +
              (maxOn()
                ? '<span>Спросим наличие, совместимость и сроки</span>'
                : '<span class="maxnote">' + maxPending() + '</span>') +
              '</div>' + (maxOn() ? ic('external', 16, 'ic ext') : ''))
          : '<a class="ask" href="' + link.page('contacts') + '">' + ic('chat', 22) + '<div><b>Задать вопрос о товаре</b><span>Ответим в чате или по телефону</span></div></a>') + '</div></div>' +
        kitBlock(fam, p) +
        '<div class="tabs" id="ptabs">' + tabs.map(function (t) { return '<button type="button" class="' + (tab === t[0] ? 'on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
        '<div class="tabbody">' +
        '<div data-panel="desc"' + (tab !== 'desc' ? ' hidden' : '') + ' class="desc-grid"><div class="desc">' + d.desc + '</div><div class="spec-t"><div class="sh">Основные характеристики</div>' + specShort + specMore + '</div></div>' +
        '<div data-panel="specs"' + (tab !== 'specs' ? ' hidden' : '') + '><div class="spec-t spec-full"><div class="sh">Характеристики</div>' + specRows + '</div></div>' +
        '<div data-panel="reviews"' + (tab !== 'reviews' ? ' hidden' : '') + ' id="reviews">' +
        /* У импортированного товара настоящих отзывов ещё нет. Блок
           показывается целиком — вёрстку надо согласовать, — но над ним
           стоит плашка, которая снимает любые сомнения в происхождении
           записей. */
        (isDemoRevs
          ? '<div class="demo-note">' + ic('info', 18) +
            '<div><b>ДЕМО / тестовые данные.</b> Это проверочные записи для согласования вёрстки: ' +
            'они собраны из фактических полей выгрузки поставщика и не являются отзывами покупателей. ' +
            'В рейтинг товара, в микроразметку и в карту сайта они не попадают.</div></div>'
          : '') +
        '<div class="rev-grid"><div class="rev-sum' + (isDemoRevs ? ' rev-sum-demo' : '') + '"><div class="big"><b>' + ratef(headRate) + '</b><span>из 5' + (isDemoRevs ? ' · ДЕМО' : '') + '</span></div>' + stars(headRate, 20) + '<div class="cnt">' + (isDemoRevs
          /* Демо-записи не отзывы, поэтому и счётчик, и доля рекомендаций
             показывают ровно то, что есть: отзывов нет. */
          ? '0 отзывов · ' + revs.length + ' демонстрационных ' + plural(revs.length, 'запись', 'записи', 'записей')
          : revs.length + ' ' + plural(revs.length, 'отзыв', 'отзыва', 'отзывов') + ' · ' + Math.round(80 + p.rate * 3) + '% рекомендуют') + '</div><div class="bars"><div><span>5</span><i style="--w:' + Math.round(sum5 / revs.length * 100) + '%"></i><span>' + sum5 + '</span></div><div><span>4</span><i style="--w:' + Math.round(sum4 / revs.length * 100) + '%"></i><span>' + sum4 + '</span></div><div><span>3</span><i style="--w:0%"></i><span>0</span></div><div><span>2</span><i style="--w:0%"></i><span>0</span></div><div><span>1</span><i style="--w:0%"></i><span>0</span></div></div><button class="btn btn-k btn-full" type="button" data-scroll="#rev-form">Написать отзыв</button><div class="note">' + (isDemoRevs ? 'Оценка 5 из 5 стоит у самих демонстрационных записей. Рейтинг товара — 0,0: настоящих отзывов на импортированном товаре ещё нет.' : 'Отзывы в прототипе — примеры: они собраны при сборке каталога и одинаковы при каждом заходе.') + '</div></div>' +
        '<div class="rev-list">' + revs.map(function (rv) {
          /* Демонстрационная запись не имеет права выглядеть как отзыв
             покупателя: у неё нет «покупка подтверждена» и нет блока
             «полезен ли отзыв», зато есть явная плашка ДЕМО. Оценка у
             неё показывается — с той же пометкой, — потому что вёрстку
             строки со звёздами тоже надо согласовать. */
          if (rv.demo) {
            /* Постоянные части записи в каталоге не хранятся: они
               одинаковы у всех демо-записей всех товаров и подставляются
               здесь. В данных лежит только номер, оценка, текст и ответ. */
            var dname = rv.name || ('Демонстрационная запись №' + (rv.n || 1));
            var dreply = typeof rv.reply === 'string' ? rv.reply : (rv.reply && rv.reply.text);
            return '<article class="rev rev-demo"><div class="rh"><div class="who"><span class="ava ava-demo">Д</span><div><b>' + esc(dname) + '</b><span class="demo-tag">ДЕМО / тестовые данные</span></div></div>' +
              (rv.rate ? '<div class="rt rt-demo">' + stars(rv.rate) + '<span>' + ratef(rv.rate) + ' из 5 · демо-оценка, в рейтинг товара не идёт</span></div>' : '') + '</div>' +
              '<p>' + esc(rv.text) + '</p>' +
              (dreply ? '<div class="rreply"><b>ДЕМО / тестовые данные</b><p>' + esc(dreply) + '</p></div>' : '') +
              '</article>';
          }
          return '<article class="rev"><div class="rh"><div class="who"><span class="ava">' + esc(rv.name[0]) + '</span><div><b>' + esc(rv.name) + '</b><span>' + esc(rv.city) + ' · <span class="ver">' + ic('check', 12) + 'Покупка подтверждена</span></span></div></div><span class="date">' + rv.date + '</span></div><div class="rt">' + stars(rv.rate) + '<span>Принтер: ' + esc(rv.printer) + '</span></div><p>' + esc(rv.text) + '</p><div class="pm"><div><b>Достоинства</b>' + esc(rv.plus) + '</div><div><b>Недостатки</b>' + esc(rv.minus) + '</div></div><div class="useful">Отзыв полезен?<button type="button" data-useful>' + ic('check', 14) + 'Да · ' + (rv.useful || 3) + '</button><button type="button">Нет · 0</button></div></article>';
        }).join('') +
        '<form class="rev-form" id="rev-form"><h3>Оставить отзыв</h3><p>Расскажите, как расходник работает на вашем принтере — это поможет другим покупателям.</p><div class="frate">Оценка ' + stars(5, 24) + '</div><div class="row"><div class="field"><input type="text" placeholder="Ваше имя" required></div><div class="field"><input type="text" placeholder="Модель принтера"></div></div><textarea placeholder="Достоинства, недостатки, впечатления от печати" required></textarea><div class="fbtn"><button class="btn btn-y" type="submit">Отправить отзыв</button><span>Отзыв появится после проверки модератором. Ваш email не публикуется.</span></div></form></div></div></div>' +
        '<div data-panel="delivery"' + (tab !== 'delivery' ? ' hidden' : '') + '><div class="desc" style="max-width:820px">' + C.site.pageText.delivery_short + '</div></div>' +
        '</div>' +
        /* Счёт юрлицам вынесен из правой колонки: там он тонул среди мелких
           плашек, а компаниям это первое, что нужно увидеть. */
        '<section class="b2b"><div class="b2b-h">' + ic('building', 26) + '<div><h2>Счёт для юридических лиц и ИП</h2>' +
        '<p>Оплата по безналичному расчёту с полным пакетом документов.</p></div>' +
        '<a class="btn btn-o" href="' + link.page('business') + '">Условия для юрлиц' + ic('arrow-right', 18) + '</a></div>' +
        '<div class="b2b-l"><div>' + ic('doc', 20) + '<div><b>Счёт на оплату</b><span>Придёт на почту после оформления заказа</span></div></div>' +
        '<div>' + ic('check', 20) + '<div><b>Закрывающие документы</b><span>УПД или накладная и счёт-фактура — вместе с заказом</span></div></div>' +
        '<div>' + ic('user', 20) + '<div><b>Выбор «Юридическое лицо»</b><span>Отметьте на шаге оформления и укажите реквизиты</span></div></div></div>' +
        '<p class="b2b-note">' + ic('mail', 18) + '<span>На шаге оформления выберите «Юридическое лицо» и заполните реквизиты компании. ' +
        'Если удобнее, отправьте карточку организации и запрос на <a href="mailto:info@nvprint-msk.ru">info@nvprint-msk.ru</a>.</span></p></section>' +
        '<div class="sec"><div class="sec-head"><h2>Похожие товары</h2><a class="more" href="' + link.catalog(p.cat, p.brand) + '">Все для ' + esc(C.brandName(p.brand)) + ' ' + ic('arrow-right', 18) + '</a></div><div class="grid4">' + related.map(card).join('') + '</div></div>' +
        /* Закреплённая панель покупки. Кнопка несёт те же data-add и data-useq,
           что и штатная, поэтому добавляет тот же товар в том же количестве —
           одна и та же ветка обработчика, без параллельной логики. */
        '<div class="buybar" id="buybar" role="region" aria-hidden="true"' +
          ' aria-label="Быстрая покупка: ' + esc(p.name) + '">' +
          '<div class="bp">' + priceBlock(p) +
            /* Метки стоят рядом с ценой, а не внутри кнопки: обработчик
               нажатия на 1,4 с подменяет содержимое кнопки на «Добавлено»,
               и всё, что лежало бы внутри, на это время исчезало бы. */
            '<div class="bmeta">' +
              '<span class="bq" data-bb-q hidden></span>' +
              '<span class="bin" data-bb-in hidden></span>' +
              (p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Под заказ, 3–5 дней</span>') +
            '</div>' +
          '</div>' +
          (noPrice(p)
            ? '<a class="btn btn-o" href="' + link.page('contacts') + '" aria-label="Запросить цену: ' + esc(p.name) + '">' +
              ic('phone', 18) + '<span class="bt">Запросить цену</span></a>'
            : '<button class="btn btn-y" type="button" data-add="' + p.id + '" data-useq="1"' +
              ' aria-label="Добавить в корзину: ' + esc(p.name) + '">' +
              ic('cart', 18) + '<span class="bt">В корзину</span></button>') +
        '</div></div>';
    });
  }

  /*
    Комплект по цветам.

    Один картридж выпускается в нескольких цветах, и покупателю почти всегда
    нужен не один, а весь набор. Показываем цвета серии рядом и даём положить
    их в корзину одной кнопкой.

    Если часть цветов кончилась, кнопка кладёт только то, что есть, и об этом
    прямо написано: молча добавить неполный комплект — худшее, что можно
    сделать с таким заказом.
  */
  function kitBlock(fam, current) {
    if (!fam || fam.items.length < 2) return '';
    var inStock = fam.items.filter(function (x) { return x.stock; });
    var missing = fam.items.filter(function (x) { return !x.stock; });
    var sumAll = fam.items.reduce(function (a, x) { return a + x.price; }, 0);
    var sumStock = inStock.reduce(function (a, x) { return a + x.price; }, 0);
    var items = fam.items.map(function (x) {
      var here = x.id === current.id;
      return '<a class="kit-i' + (here ? ' on' : '') + (x.stock ? '' : ' out') + '" href="' + link.product(x) + '">' +
        '<span class="kit-img"><img src="' + x.img + '" alt="" loading="lazy"></span>' +
        '<span class="kit-c"><b>' + esc(x.color || 'Цвет') + '</b><span>' + esc(x.code) + '</span></span>' +
        '<span class="kit-pr">' + fmt(x.price) + ' ₽</span>' +
        (x.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Под заказ</span>') +
        (here ? '<span class="kit-here">эта страница</span>' : '') + '</a>';
    }).join('');
    var note = missing.length
      ? '<div class="kit-note">' + ic('info', 16) + '<div>' + (missing.length === 1 ? 'Цвета «' + esc(missing[0].color) + '» сейчас нет на складе.' : 'Части цветов сейчас нет на складе: ' + missing.map(function (x) { return esc(x.color); }).join(', ') + '.') +
        ' Кнопка добавит ' + inStock.length + ' из ' + fam.items.length + ', что есть в наличии. Недостающее привезём под заказ за 3–5 дней — добавьте отдельно кнопкой ниже.</div></div>'
      : '';
    var extra = missing.length
      ? '<button class="kit-all" type="button" data-kit-all="' + fam.id + '">Добавить все ' + fam.items.length + ' ' + plural(fam.items.length, 'цвет', 'цвета', 'цветов') + ', включая под заказ — ' + fmt(sumAll) + ' ₽</button>'
      : '';
    return '<section class="kit"><div class="kit-h"><h2>Комплект из ' + fam.items.length + ' ' + plural(fam.items.length, 'цвета', 'цветов', 'цветов') + '</h2>' +
      '<p>' + esc(String(fam.label).replace(/\.$/, '')) + '. Цвета одной серии — можно взять сразу весь набор.</p></div>' +
      '<div class="kit-list">' + items + '</div>' +
      '<div class="kit-foot"><div class="kit-sum">' + (missing.length ? 'В наличии ' + inStock.length + ' из ' + fam.items.length : 'Комплект целиком') +
      '<b>' + fmt(missing.length ? sumStock : sumAll) + ' ₽</b></div>' +
      (inStock.length ? '<button class="btn btn-y btn-lg" type="button" data-kit="' + fam.id + '">' + ic('cart', 20) + (missing.length ? 'Добавить ' + inStock.length + ' из ' + fam.items.length : 'Весь комплект в корзину') + '</button>' : '') +
      '</div>' + note + extra + '</section>';
  }

  function printerKey(brand, model) {
    var TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
    return (C.brandName(brand) + ' ' + model).toLowerCase().replace(/[а-яё]/g, function (c) { return TR[c] ?? c; }).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* Страница под модель принтера — то, ради чего каталог вообще индексируется. */
  function printer(r) {
    return C.printer(r.key).then(function (info) {
      if (!info) return notfound();
      var items = info.products.filter(Boolean);
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
    var items = cartItems(), n = cartCount(), sum = cartSum(), promo = S.promo === 'HIBLACK5' ? Math.round(sum * 0.05) : 0;
    if (!items.length) {
      return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Корзина', '']]) + '<h1>Корзина</h1></div><div class="empty big"><h3>В корзине пока пусто</h3><p>Подберите картридж по модели принтера или загляните в лучшие предложения.</p><div class="acts"><a class="btn btn-y" href="' + link.plain('finder') + '">Подобрать по принтеру</a><a class="btn btn-o" href="' + link.catalog('') + '">В каталог</a></div></div></div>';
    }
    var addon = C.all().filter(function (x) { return !S.cart[x.id]; }).slice(0, 3);
    var rows = items.map(function (it) {
      var p = it.p;
      return '<div class="item"><a class="img" href="' + link.product(p) + '"><img src="' + p.img + '" alt="" loading="lazy"></a>' +
        '<div class="ibody"><a class="t" href="' + link.product(p) + '">' + esc(p.name) + '</a><div class="m"><span>Артикул ' + esc(p.code) + '</span>' + (p.res ? '<span>Ресурс ' + fmt(p.res) + ' стр.</span>' : '') + '<span>Для ' + brandLogo(p.brand, 12, '') + '</span>' + (p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Под заказ</span>') + '</div><div class="u">' + fmt(p.price) + ' ₽ за шт.</div></div>' +
        '<div class="ictl"><div class="qty"><button type="button" data-cq="' + p.id + '" data-d="-1" aria-label="Меньше">' + ic('minus', 18) + '</button><span>' + it.q + '</span><button type="button" data-cq="' + p.id + '" data-d="1" aria-label="Больше">' + ic('plus', 18) + '</button></div>' +
        /* Расчёт строки пишем целиком, включая одну штуку: покупателю не
           приходится держать в голове, откуда взялась сумма. */
        '<div class="sum"><small class="calc">' + it.q + ' шт. × ' + fmt(p.price) + ' ₽ =</small><div class="price">' + fmt(p.price * it.q) + ' ₽</div></div></div>' +
        '<button class="rm" type="button" data-rm="' + p.id + '" aria-label="Удалить">' + ic('trash', 18) + '</button></div>';
    }).join('');
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Корзина', '']]) + '<h1>Корзина <span>' + n + ' ' + plural(n, 'товар', 'товара', 'товаров') + ' · ' + fmt(sum) + ' ₽</span></h1>' +
      '<div class="steps"><div class="step on"><i>1</i><span>Корзина</span></div><div class="step"><i>2</i><span>Доставка и оплата</span></div><div class="step"><i>3</i><span>Подтверждение</span></div></div></div>' +
      '<div class="cgrid"><div class="clist"><div class="chead"><span>' + n + ' ' + plural(n, 'товар', 'товара', 'товаров') + '</span><div class="r"><a href="#" data-fav-all>' + ic('heart', 16) + 'Всё в избранное</a><a href="#" data-clear-cart>' + ic('trash', 16) + 'Очистить корзину</a></div></div>' + rows +
      '<div class="cfootr"><form class="promo" id="promo-form"><div class="field"><input type="text" name="promo" placeholder="Промокод" value="' + esc(S.promo || '') + '" aria-label="Промокод"></div><button class="btn btn-o" type="submit">Применить</button>' + (promo ? '<span class="ok">' + ic('check', 16) + 'Скидка 5% применена</span>' : (S.promoErr ? '<span class="err">Промокод не найден</span>' : '<span class="muted xs">Для теста: HIBLACK5</span>')) + '</form><a class="back" href="' + link.catalog('') + '">' + ic('chev-left', 16) + 'Продолжить покупки</a></div></div>' +
      '<div class="summary"><h3>Ваш заказ</h3><div class="srow"><span>Товары, ' + n + ' шт.</span><b>' + fmt(sum) + ' ₽</b></div><div class="srow"><span>Скидка</span><b>' + (promo ? '−' + fmt(promo) + ' ₽' : '0 ₽') + '</b></div><div class="srow"><span>Доставка</span><b class="soft">рассчитаем на следующем шаге</b></div><div class="srow total"><span>Итого</span><b>' + fmt(sum - promo) + ' ₽</b></div><a class="btn btn-y btn-lg btn-full" href="' + link.plain('checkout') + '">Оформить заказ' + ic('arrow-right', 20) + '</a><div class="payrow"><span>НАЛИЧНЫМИ</span><span>КАРТОЙ КУРЬЕРУ</span><span>ПО СЧЁТУ</span></div><div class="biz">' + ic('building', 20) + '<div><b>Заказ для компании?</b>На следующем шаге выберите «Юридическое лицо» — счёт придёт на почту, документы отдадим с заказом.</div></div><div class="note">Согласия на обработку персональных данных и условия оферты подтверждаются на шаге оформления — отдельными галочками.</div>' +
      maxEl('maxhelp', 'Задать вопрос по заказу в мессенджере MAX, откроется в новой вкладке',
        maxIcon(26) + '<span>Написать в MAX</span>' +
        (maxOn() ? '' : '<i class="maxnote">' + maxPending() + '</i>')) +
      '</div>' +
      '<div class="sec addon-sec"><div class="sec-head"><h3>Добавить к заказу</h3><a class="more" href="' + link.catalog('') + '">Ещё ' + ic('arrow-right', 18) + '</a></div><div class="addon">' + addon.map(function (p) {
        return '<div class="mini"><a class="img" href="' + link.product(p) + '"><img src="' + p.img + '" alt="" loading="lazy"></a><div class="mb"><a class="t" href="' + link.product(p) + '">' + esc(p.name) + '</a><div class="p"><div class="price">' + fmt(p.price) + ' ₽</div><button class="add" type="button" data-add="' + p.id + '" aria-label="В корзину">' + ic('plus', 18) + '</button></div></div></div>';
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

  function checkout(r) {
    if (r.query.quick && C.byId(r.query.quick) && !S.cart[r.query.quick]) { S.cart[r.query.quick] = 1; save(); updateHeader(); }
    var items = cartItems(), sum = cartSum(), promo = S.promo === 'HIBLACK5' ? Math.round(sum * 0.05) : 0;
    if (!items.length) return cart();
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
      '<div class="summary"><h3>Ваш заказ</h3><div class="colist">' + items.map(function (it) {
        return '<div class="coi"><img src="' + it.p.img + '" alt="" loading="lazy"><span>' + esc(it.p.name) + '</span><b>' + it.q + ' × ' + fmt(it.p.price) + ' ₽</b></div>';
      }).join('') + '</div><div class="srow"><span>Товары</span><b>' + fmt(sum) + ' ₽</b></div>' + (promo ? '<div class="srow"><span>Скидка</span><b>−' + fmt(promo) + ' ₽</b></div>' : '') + '<div class="srow"><span>Доставка</span><b' + (drow[3] == null ? ' class="soft"' : '') + '>' + dtext + '</b></div><div class="srow total"><span>Итого</span><b>' + fmt(sum - promo + dcost) + ' ₽</b></div>' +
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
      ['Цена', function (p) { return '<b class="price" style="font-size:18px">' + fmt(p.price) + ' ₽</b>'; }],
      ['Бренд принтера', function (p) { return brandLogo(p.brand, 16, ''); }],
      ['Ресурс', function (p) { return p.res ? fmt(p.res) + ' стр.' : '—'; }],
      ['Цвет', function (p) { return p.color || '—'; }],
      ['Чип', function (p) { return p.chip === true ? 'Есть' : (p.chip === false ? 'Нет' : '—'); }],
      ['Тип', function (p) { return p.type; }],
      ['Рейтинг', function (p) { return stars(p.rate) + ' ' + ratef(p.rate) + ' · ' + p.reviews; }],
      ['Наличие', function (p) { return p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Под заказ</span>'; }],
    ];
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link.home()], ['Сравнение', '']]) + '<h1>Сравнение <span>' + items.length + ' ' + plural(items.length, 'товар', 'товара', 'товаров') + '</span></h1></div>' +
      '<div class="cmp-wrap"><table class="cmp"><thead><tr><th></th>' + items.map(function (p) {
        return '<th><a href="' + link.product(p) + '"><img src="' + p.img + '" alt=""><span>' + esc(p.name) + '</span></a><button class="btn btn-y btn-sm" type="button" data-add="' + p.id + '">В корзину</button><button class="rmc" type="button" data-cmp="' + p.id + '">' + ic('close', 14) + 'Убрать</button></th>';
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
  function render() {
    var r = parse(), fn = routes[r.route] || notfound;
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
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
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
    var kit = a.closest('.kit-i');
    if (kit && !kit.classList.contains('on')) {
      navMode = 'variant';
      var list = kit.parentNode;
      if (list) list.querySelectorAll('.kit-i').forEach(function (n) { n.classList.remove('on', 'picking'); });
      kit.classList.add('picking');
    }
    if (!OFFLINE && href === location.pathname + location.search) return;
    go(href);
  });

  /* --------------------------------------------------------- действия */
  function showTab(name) {
    document.querySelectorAll('#ptabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); });
    document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
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
    S.cart[id] = (S.cart[id] || 0) + (q || 1);
    save(); updateHeader(); syncBuybar();
    var p = C.byId(id);
    showToast(ic('check', 18) + '<span>' + esc(p.name.slice(0, 48)) + '… — в корзине</span> <a href="' + link.plain('cart') + '">Перейти в корзину</a>');
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-add]');
    if (t) {
      var q = 1;
      if (t.dataset.useq) q = pickedQty();
      addToCart(t.dataset.add, q);
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
        var add = f.items.filter(function (x) { return onlyStock ? x.stock : true; });
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
    if (t) { e.preventDefault(); showTab(t.dataset.tabLink); document.getElementById('ptabs').scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    t = e.target.closest('[data-spec-jump]');
    if (t) {
      e.preventDefault();
      showTab('desc');
      var st = app.querySelector('.desc-grid .spec-t'), mb = st && st.querySelector('[data-spec-more]');
      if (mb && mb.getAttribute('aria-expanded') !== 'true') mb.click();
      if (st) st.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
      return;
    }
    t = e.target.closest('[data-scroll]');
    if (t) { var el = document.querySelector(t.dataset.scroll); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    t = e.target.closest('[data-more-rev]');
    if (t) { e.preventDefault(); showToast('В прототипе показаны три примера отзывов'); return; }
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
    if (e.target.closest('#gmain') && !e.target.closest('.gcompat')) {
      var g = document.getElementById('gmain');
      lb.querySelector('img').src = g.dataset.src; lb.classList.add('open');
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
    if (e.key === 'Escape') { closeMenu(); closeMob(); lb.classList.remove('open'); }
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

  /* Заказ уходит на сервер; если сервера нет (статичный просмотр), сохраняем локально. */
  function submitOrder(data, items, total) {
    return fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: data, items: items.map(function (x) { return { id: x.p.id, code: x.p.code, name: x.p.name, price: x.p.price, qty: x.q }; }), total: total }),
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
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
      var d2 = formData(f), items = cartItems(), total = cartSum();
      S.co = d2;
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Отправляем…';
      (OFFLINE ? Promise.reject(new Error('offline')) : submitOrder(d2, items, total))
        .then(function (res) { finishOrder(d2, res.number, false); })
        .catch(function () { finishOrder(d2, 10240 + (S.orders = (S.orders || 0) + 1), true); });
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
        .catch(function () { return null; })
        .then(function () {
          cbtn.disabled = false; cbtn.innerHTML = cwas;
          f.reset();
          showToast(ic('check', 18) + '<span>Обращение отправлено. Ответим в рабочее время.</span>');
        });
      return;
    }
    if (f.id === 'rev-form') { e.preventDefault(); f.innerHTML = '<h3>Спасибо за отзыв!</h3><p>Он появится на странице после проверки модератором.</p>'; return; }
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
      .catch(function () { return null; })
      .then(function () {
        btn.disabled = false; btn.innerHTML = was;
        f.reset(); cbClose();
        showToast(ic('check', 18) + '<span>Заявка принята. Перезвоним в рабочее время.</span>');
      });
  });

  /*
    Быстрый заказ. Это не оформление: ни адреса, ни доставки, ни оплаты —
    только имя, телефон и два обязательных согласия. Остальное менеджер
    уточняет по телефону, поэтому спрашивать это в модалке нечего.
  */
  var qm = document.getElementById('quick'), qPrev = null, qItem = null;
  function qOpen(id, q) {
    var p = C.byId(id); if (!p || !qm) return;
    qItem = { p: p, q: Math.max(1, q | 0) };
    var sum = p.price * qItem.q;
    document.getElementById('q-prod').innerHTML =
      '<img src="' + p.img + '" alt="" loading="lazy">' +
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
      .catch(function () { finishQuick(d, 10240 + (S.orders = (S.orders || 0) + 1), true); })
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
  lb.addEventListener('click', function () { lb.classList.remove('open'); });

  function showView(i) {
    var g = document.getElementById('gmain'); if (!g) return;
    var thumbs = app.querySelectorAll('.thumb[data-view]'), th = thumbs[i]; if (!th) return;
    thumbs.forEach(function (x) { x.classList.toggle('on', x === th); });
    var tz = th.querySelector('.tz'), img = g.querySelector('[data-gview="img"]'), zoom = g.querySelector('[data-gview="zoom"]'), comp = g.querySelector('[data-gview="compat"]');
    var kind = th.classList.contains('tcompat') ? 'compat' : (tz ? 'zoom' : 'img');
    img.hidden = kind !== 'img'; zoom.hidden = kind !== 'zoom';
    if (comp) comp.hidden = kind !== 'compat';
    if (kind === 'zoom') zoom.style.backgroundPosition = tz.style.backgroundPosition;
    g.querySelector('.zoom').hidden = kind === 'compat';
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
  function initBuybar() {
    if (bbObs) { bbObs.disconnect(); bbObs = null; }
    var bar = document.getElementById('buybar');
    if (!bar) return;
    var btn = app.querySelector('.buy [data-add]');
    if (!btn || btn.disabled || btn.hasAttribute('aria-disabled')) { bar.remove(); return; }
    syncBuybar();
    if (!('IntersectionObserver' in window)) { bar.remove(); return; }
    bbObs = new IntersectionObserver(function (en) {
      var on = !en[0].isIntersecting;
      bar.classList.toggle('show', on);
      /* Скринридер не должен находить панель, пока она уехала за край. */
      bar.setAttribute('aria-hidden', on ? 'false' : 'true');
      /* Плашке cookie и всплывающему уведомлению есть куда подняться. */
      document.body.classList.toggle('bar-on', on);
    }, { threshold: 0 });
    bbObs.observe(btn);
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
