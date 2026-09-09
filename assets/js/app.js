/* Hi-Black — фирменный магазин. Прототип: одностраничное приложение на hash-роутинге.
   Данные каталога — window.HB (assets/js/data.js), иконки — window.HB_ICONS (assets/js/icons.js). */
(function () {
  'use strict';
  var D = window.HB, ICONS = window.HB_ICONS;
  var app = document.getElementById('app');

  // ---------- helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function norm(s) { return String(s || '').toLowerCase().replace(/[\s\-–—_.,/()]/g, ''); }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function ic(name, size, cls) {
    return '<svg class="' + (cls || 'ic') + '" width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  }
  function stars(rate, size) {
    var full = Math.round(rate), out = '<span class="stars">';
    for (var i = 0; i < 5; i++) out += ic('star', size || 14, 'ic ' + (i < full ? 'on' : 'off'));
    return out + '</span>';
  }
  function brandLogo(b, h, cls) {
    var br = D.brands[b];
    if (!br) return '';
    if (br.logo) return '<img class="' + (cls || 'blogo') + '" src="' + br.logo + '" alt="' + esc(br.name) + '" style="height:' + (h || 18) + 'px">';
    return '<span class="' + (cls || 'blogo') + ' btext">' + esc(br.name) + '</span>';
  }
  function brandName(b) { return D.brands[b] ? D.brands[b].name : ''; }
  function catName(c) { var x = D.cats.filter(function (k) { return k.id === c; })[0]; return x ? x.name : ''; }
  function byId(id) { return D.products.filter(function (p) { return p.id === id; })[0]; }
  function ratef(r) { return String(r.toFixed(1)).replace('.', ','); }
  function plural(n, a, b, c) { n = Math.abs(n) % 100; var n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }

  // ---------- state
  var S = { cart: null, fav: {}, cmp: {}, orders: 0 };
  try { var saved = JSON.parse(localStorage.getItem('hb-proto') || 'null'); if (saved) S = Object.assign(S, saved); } catch (e) { }
  if (!S.cart) S.cart = { 'hb-tk-1150': 2, 'hb-tk-3100': 1, 'hb-cf283a': 1 };
  function save() { try { localStorage.setItem('hb-proto', JSON.stringify(S)); } catch (e) { } }
  function cartItems() { return Object.keys(S.cart).map(function (id) { return { p: byId(id), q: S.cart[id] }; }).filter(function (x) { return x.p && x.q > 0; }); }
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

  // ---------- router
  function parse() {
    var h = (location.hash || '#home').slice(1), i = h.indexOf('?'), path = i < 0 ? h : h.slice(0, i), qs = i < 0 ? '' : h.slice(i + 1), params = {};
    if (qs) qs.split('&').forEach(function (kv) { var j = kv.indexOf('='); var k = j < 0 ? kv : kv.slice(0, j), v = j < 0 ? '' : kv.slice(j + 1); try { params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { params[k] = v; } });
    return { path: path || 'home', params: params };
  }
  function build(path, params) {
    var qs = Object.keys(params || {}).filter(function (k) { var v = params[k]; return v !== undefined && v !== null && v !== '' && v !== false; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return '#' + path + (qs ? '?' + qs : '');
  }
  function go(path, params) { location.hash = build(path, params); }
  function link(path, params) { return build(path, params); }

  // ---------- catalog filtering
  var RES = [{ id: 'r1', name: 'до 3 000 страниц', t: function (r) { return r < 3000; } }, { id: 'r2', name: '3 000 – 7 000', t: function (r) { return r >= 3000 && r < 7000; } }, { id: 'r3', name: '7 000 – 15 000', t: function (r) { return r >= 7000 && r < 15000; } }, { id: 'r4', name: 'более 15 000', t: function (r) { return r >= 15000; } }];
  var COLORS = ['Чёрный', 'Голубой', 'Пурпурный', 'Жёлтый', 'Цветной', 'Серый'];
  var COLOR_HEX = { 'Чёрный': '#141414', 'Голубой': '#2bb5e9', 'Пурпурный': '#e6449a', 'Жёлтый': '#ffd200', 'Цветной': 'linear-gradient(90deg,#2bb5e9,#e6449a,#ffd200)', 'Серый': '#9a9a9a' };
  function list(p) { return (p || '').split(',').filter(Boolean); }
  function applyFilters(p, except) {
    var l = D.products.slice();
    if (p.cat) l = l.filter(function (x) { return x.cat === p.cat; });
    if (p.brand && except !== 'brand') l = l.filter(function (x) { return x.brand === p.brand; });
    if (p.q) { var q = norm(p.q); l = l.filter(function (x) { return norm(x.name + ' ' + x.code + ' ' + x.model + ' ' + x.compat + ' ' + brandName(x.brand)).indexOf(q) >= 0; }); }
    if (p.sale) l = l.filter(function (x) { return x.old; });
    if (p.stock && except !== 'stock') l = l.filter(function (x) { return x.stock; });
    if (except !== 'price') { if (p.pmin) l = l.filter(function (x) { return x.price >= +p.pmin; }); if (p.pmax) l = l.filter(function (x) { return x.price <= +p.pmax; }); }
    if (except !== 'res' && list(p.res).length) { var rs = list(p.res); l = l.filter(function (x) { return x.res != null && rs.some(function (id) { var r = RES.filter(function (k) { return k.id === id; })[0]; return r && r.t(x.res); }); }); }
    if (except !== 'color' && list(p.color).length) { var cs = list(p.color); l = l.filter(function (x) { return cs.indexOf(x.color) >= 0; }); }
    if (except !== 'chip' && list(p.chip).length) { var ch = list(p.chip); l = l.filter(function (x) { return (x.chip === true && ch.indexOf('1') >= 0) || (x.chip === false && ch.indexOf('0') >= 0); }); }
    if (except !== 'type' && list(p.type).length) { var ts = list(p.type); l = l.filter(function (x) { return ts.indexOf(x.type) >= 0; }); }
    return l;
  }
  function sortList(l, s) {
    l = l.slice();
    if (s === 'price') l.sort(function (a, b) { return a.price - b.price; });
    else if (s === '-price') l.sort(function (a, b) { return b.price - a.price; });
    else if (s === 'rating') l.sort(function (a, b) { return b.rate - a.rate || b.n - a.n; });
    else if (s === 'new') l.sort(function (a, b) { return hash(b.id) - hash(a.id); });
    else l.sort(function (a, b) { return b.pop - a.pop; });
    return l;
  }
  function toggleIn(p, key, val) { var arr = list(p[key]); var i = arr.indexOf(val); if (i >= 0) arr.splice(i, 1); else arr.push(val); p[key] = arr.join(','); delete p.page; return p; }

  // ---------- reviews (sample pool)
  var REV_POOL = [
    { name: 'Алексей', city: 'Москва', rate: 5, text: 'Беру уже третий раз, на замену оригиналу. Ресурс по ощущениям такой же — прошлый отходил примерно столько, сколько заявлено, при обычных офисных документах.', plus: 'Встал без проблем, принтер {printer} сразу увидел картридж, счётчик показывает 100%. Печать плотная, без полос.', minus: 'Коробка пришла слегка помятой, но на картридже это не сказалось.' },
    { name: 'Марина', city: 'Тула', rate: 5, text: 'Заказывала для небольшого офиса, за месяц никаких проблем — ни серого фона, ни осыпания тонера. Буду брать ещё.', plus: 'Цена, наличие, отправили в день заказа. Пришёл СДЭКом за два дня.', minus: 'Нет.' },
    { name: 'ООО «Вектор-Сервис»', city: 'Санкт-Петербург', rate: 4, text: 'Закупаем партиями для сервисного обслуживания клиентов с {printer}. За полгода брака не было.', plus: 'Оплата по счёту, документы выдали сразу вместе с товаром. Качество печати не отличить от оригинала.', minus: 'Хотелось бы видеть ресурс не только числом, но и при каком заполнении — нашли только в характеристиках.' },
    { name: 'Дмитрий', city: 'Казань', rate: 5, text: 'Поставил в {printer} вместо оригинала — разницы в отпечатках не увидел ни на тексте, ни на схемах.', plus: 'Ресурс соответствует заявленному, цена в два раза ниже оригинала.', minus: 'Нет.' },
    { name: 'Ольга', city: 'Екатеринбург', rate: 5, text: 'Второй заказ в этом магазине. Всё чётко: подобрали по модели принтера, привезли на следующий день.', plus: 'Подбор по модели в шапке — не надо гадать с артикулом.', minus: 'Курьер приехал ближе к вечеру, хотя интервал был до обеда.' },
    { name: 'ИП Смирнов', city: 'Нижний Новгород', rate: 4, text: 'Используем в {printer} на приёме документов, печатаем много. Картриджа хватает примерно на месяц.', plus: 'Стабильное качество от партии к партии, есть отсрочка по счёту.', minus: 'На одной партии коробки были без защитной плёнки.' },
    { name: 'Сергей', city: 'Воронеж', rate: 5, text: 'Отличная замена оригиналу. Тонер не осыпается, чёткий мелкий текст, фотографии в документах печатает без полос.', plus: 'Гарантия 12 месяцев и реальный обмен по браку — проверял.', minus: 'Нет.' },
    { name: 'Анна', city: 'Самара', rate: 5, text: 'Брала для домашнего {printer}. Всё работает, чип распознался сразу, ничего сбрасывать не пришлось.', plus: 'Быстрая доставка, аккуратная упаковка.', minus: 'Нет.' }
  ];
  var DATES = ['28 августа 2026', '16 августа 2026', '3 августа 2026', '21 июля 2026', '9 июля 2026', '30 июня 2026', '14 июня 2026', '2 июня 2026'];
  function reviewsFor(p) {
    var h = hash(p.id), n = Math.min(3, p.n), out = [];
    var printer = brandName(p.brand) + (p.models[0] ? ' ' + p.models[0] : '');
    for (var i = 0; i < n; i++) { var r = REV_POOL[(h + i * 3) % REV_POOL.length]; out.push({ name: r.name, city: r.city, rate: r.rate, date: DATES[(h + i) % DATES.length], printer: printer, text: r.text.replace('{printer}', printer), plus: r.plus.replace('{printer}', printer), minus: r.minus }); }
    return out;
  }

  // ---------- pieces
  function badge(p) {
    if (p.badge === 'hit') return '<span class="badge badge-hit">Хит</span>';
    if (p.badge === 'sale') return '<span class="badge badge-sale">−' + Math.round(100 - p.price / p.old * 100) + '%</span>';
    if (p.badge === 'res') return '<span class="badge badge-new">Увеличенный ресурс</span>';
    return '';
  }
  function specsShort(p) {
    var s = [];
    if (p.res) s.push('<span>Ресурс <b>' + fmt(p.res) + ' стр.</b></span>');
    if (p.color) s.push('<span><b>' + p.color + '</b></span>');
    if (p.chip === true) s.push('<span><b>С чипом</b></span>'); else if (p.chip === false) s.push('<span><b>Без чипа</b></span>');
    if (!p.res && p.type) s.push('<span><b>' + esc(p.type) + '</b></span>');
    if (p.weight) s.push('<span><b>' + esc(p.weight) + '</b></span>');
    return s.join('');
  }
  function card(p) {
    var fav = S.fav[p.id] ? ' on' : '', cmp = S.cmp[p.id] ? ' on' : '';
    return '<div class="card" data-id="' + p.id + '">' +
      '<a class="cmedia" href="' + link('product', { id: p.id }) + '"><img src="' + D.img[p.img] + '" alt="' + esc(p.name) + '" loading="lazy">' + (badge(p) ? '<div class="cbadges">' + badge(p) + '</div>' : '') + '<span class="cbrand" title="Для принтеров ' + esc(brandName(p.brand)) + '">' + brandLogo(p.brand, 16) + '</span></a>' +
      '<div class="cacts"><button class="ibtn fav' + fav + '" type="button" data-fav="' + p.id + '" title="В избранное">' + ic('heart', 18) + '</button><button class="ibtn cmpb' + cmp + '" type="button" data-cmp="' + p.id + '" title="Сравнить">' + ic('compare', 18) + '</button></div>' +
      '<div class="cbody"><a class="ctitle" href="' + link('product', { id: p.id }) + '">' + esc(p.name) + '</a>' +
      '<div class="crate">' + stars(p.rate) + '<span>' + ratef(p.rate) + '</span><a href="' + link('product', { id: p.id, tab: 'reviews' }) + '"><span class="rn">' + p.n + '</span><span class="rw"> ' + plural(p.n, 'отзыв', 'отзыва', 'отзывов') + '</span></a></div>' +
      '<div class="cspecs">' + specsShort(p) + '</div>' +
      (p.stock ? '<div class="avail"><i></i>В наличии</div>' : '<div class="avail out"><i></i>Под заказ, 3–5 дней</div>') +
      '<div class="cfoot"><div class="price">' + fmt(p.price) + ' ₽' + (p.old ? '<small>' + fmt(p.old) + ' ₽</small>' : '') + '</div><button class="btn btn-y" type="button" data-add="' + p.id + '">' + ic('cart', 18) + 'В корзину</button></div>' +
      '<a class="oneclick" href="' + link('checkout', { quick: p.id }) + '">Купить в 1 клик</a></div></div>';
  }
  function crumbs(items) {
    return '<div class="crumbs">' + items.map(function (it, i) { return (i ? ic('chev-right', 14) : '') + (it[1] ? '<a href="' + it[1] + '">' + esc(it[0]) + '</a>' : '<span style="color:var(--ink)">' + esc(it[0]) + '</span>'); }).join('') + '</div>';
  }
  function sideCats(active, brand) {
    return '<div class="sbox"><div class="stitle">Категории</div><div class="slist">' + D.cats.map(function (c) {
      var on = active === c.id;
      return '<a class="' + (on ? 'on' : '') + '" href="' + link('catalog', { cat: c.id }) + '">' + esc(c.name) + ic(on ? 'chev-down' : 'chev-right', 16) + '</a>' +
        (on && c.id === 'laser' ? '<div class="sub">' + D.laserBrands.map(function (b) { return '<a class="' + (brand === b ? 'on' : '') + '" href="' + link('catalog', { cat: 'laser', brand: b }) + '">' + esc(brandName(b)) + '</a>'; }).join('') + '</div>' : '');
    }).join('') + '</div></div>';
  }
  function sideInfo() {
    return '<div class="sbox"><div class="stitle">Информация</div><div class="slist">' + D.pages.filter(function (p) { return p.menu; }).map(function (p) { return '<a href="' + link('page', { id: p.id }) + '">' + esc(p.title) + '</a>'; }).join('') + '</div></div>' +
      '<div class="spromo"><b>Юрлицам и ИП</b><p>Счёт за несколько минут, закрывающие документы, доставка на адрес компании.</p><a class="btn btn-sm" href="' + link('page', { id: 'business' }) + '">Условия для бизнеса</a></div>';
  }
  function advantages() {
    var a = [['truck', 'Доставка по всей России', 'Курьером по Москве, СДЭК, Boxberry и Почтой по регионам', 'delivery'], ['card', 'Оплата онлайн и по счёту', 'Карта, СБП, счёт для юрлиц с закрывающими документами', 'payment'], ['shield', 'Гарантия ресурса', 'Заявленный ресурс печати, обмен при браке', 'warranty'], ['pin', 'Самовывоз в Москве', 'Со склада в день заказа, при наличии на складе', 'contacts']];
    return '<div class="adv">' + a.map(function (x) { return '<a class="advi" href="' + link('page', { id: x[3] }) + '"><div class="ico">' + ic(x[0], 22) + '</div><div><b>' + x[1] + '</b><span>' + x[2] + '</span></div></a>'; }).join('') + '</div>';
  }

  // ---------- pages
  function home() {
    var best = sortList(D.products, 'pop').slice(0, 8);
    var tags = ['HP LaserJet Pro M125', 'Kyocera M2135dn', 'Canon i-SENSYS MF3010', 'Brother HL-L2300', 'Samsung ML-2160', 'Xerox Phaser 3020', 'Pantum P2207', 'Ricoh SP 3400N', 'HP LaserJet 1018', 'Kyocera FS-1040', 'HP LJ Pro M104', 'Canon LBP6030', 'Brother DCP-L2500', 'Kyocera M2040dn', 'Xerox WorkCentre 3025', 'HP LJ Pro 400 M401', 'Epson L3150', 'Canon PIXMA G3411'];
    var tiles = D.cats.map(function (c, i) {
      return i < 3 ? '<a class="tile" href="' + link('catalog', { cat: c.id }) + '"><div class="tt"><h3>' + esc(c.name) + '</h3><p>' + esc(c.desc) + '</p><span class="cta">' + D.counts[c.id] + ' ' + plural(D.counts[c.id], 'товар', 'товара', 'товаров') + ' ' + ic('arrow-right', 16) + '</span></div><span class="ph"><img src="' + D.img[c.img] + '" alt=""></span></a>' : '';
    }).join('');
    var tilesS = D.cats.slice(3).map(function (c) { return '<a class="tile-s" href="' + link('catalog', { cat: c.id }) + '"><span><b>' + esc(c.name) + '</b><span>' + esc(c.desc) + '</span></span><span class="ph"><img src="' + D.img[c.img] + '" alt=""></span></a>'; }).join('');
    var strip = ['hp', 'canon', 'kyocera', 'brother', 'samsung', 'xerox', 'ricoh', 'epson', 'panasonic', 'lexmark'].map(function (b) { return '<a href="' + link('catalog', { cat: 'laser', brand: b }) + '" title="' + esc(brandName(b)) + '">' + brandLogo(b, 20, '') + '</a>'; }).join('');
    var finderForm = '<form class="finder" id="finder-form"><select class="fsel" name="brand"><option value="">Бренд принтера</option>' + D.laserBrands.map(function (b) { return '<option value="' + b + '">' + esc(brandName(b)) + '</option>'; }).join('') + '</select><div class="finp"><input type="text" name="q" placeholder="Модель, например M2135dn"></div><button class="btn btn-y" type="submit">Подобрать</button></form>';
    var slides = [
      '<div class="slide s1 on"><div class="wrap"><div class="stext"><img class="slogo" src="' + D.img.hb_logo + '" alt="Hi-Black"><div class="eyebrow"><i></i>Фирменный магазин Hi-Black</div><h1>Картридж для вашего принтера — <em>в наличии</em>, с гарантией ресурса</h1><p>Совместимые картриджи, тонеры и чернила Hi-Black для Brother, Canon, HP, Kyocera, Samsung, Xerox и ещё десяти брендов печатающей техники.</p>' + finderForm + '<div class="hnote">Не знаете модель? Она указана на наклейке спереди или сзади принтера. <a href="' + link('finder') + '">Как найти модель&nbsp;→</a></div></div><div></div></div></div>',
      '<div class="slide s2"><div class="wrap"><div class="stext"><img class="slogo" src="' + D.img.hb_logo + '" alt="Hi-Black"><div class="eyebrow"><i></i>Hi-Black® — совместимые расходные материалы</div><h2>Расходники для <em>16 брендов</em> принтеров и МФУ</h2><p>Лазерные и струйные картриджи, тонеры, чернила, фотобумага и запчасти — со склада в Москве, с доставкой по всей России.</p><div class="sfeat"><div>' + ic('shield', 18) + 'Гарантия ресурса 12 месяцев, обмен при браке</div><div>' + ic('check', 18) + 'Не нарушают патенты производителей принтеров</div><div>' + ic('refresh', 18) + 'Повторно заправляются и восстанавливаются</div><div>' + ic('truck', 18) + 'Отгрузка в день заказа при наличии на складе</div></div><div class="sbtns"><a class="btn btn-y btn-lg" href="' + link('catalog', { cat: 'laser' }) + '">В каталог</a><a class="btn btn-lg btn-w" href="' + link('page', { id: 'about' }) + '">О бренде</a></div></div><div class="svis"><img src="' + D.img.hero_box + '" alt="Картридж Hi-Black"></div></div></div>',
      '<div class="slide s3"><div class="wrap"><div class="stext"><img class="slogo" src="' + D.img.hb_logo + '" alt="Hi-Black"><div class="eyebrow"><i></i>Юрлицам и сервисным центрам</div><h2>Счёт за несколько минут, документы <em>с заказом</em></h2><p>Оплата по счёту с НДС, закрывающие документы по ЭДО, доставка на адрес компании и персональный менеджер для парка техники.</p><div class="sbtns"><a class="btn btn-y btn-lg" href="' + link('page', { id: 'business' }) + '">Условия для бизнеса</a><a class="btn btn-lg btn-w" href="' + link('page', { id: 'contacts' }) + '">Контакты</a></div></div><div class="svis"></div></div></div>'
    ];
    var ctrl = '<div class="sctrl"><div class="wrap"><div class="sdots">' + slides.map(function (_, i) { return '<button type="button" data-dot="' + i + '" class="' + (i === 0 ? 'on' : '') + '" aria-label="Слайд ' + (i + 1) + '"></button>'; }).join('') + '</div><div class="sarr"><button type="button" data-sl="-1" aria-label="Назад">' + ic('chev-left', 18) + '</button><button type="button" data-sl="1" aria-label="Вперёд">' + ic('chev-right', 18) + '</button></div></div></div>';
    return '<section class="hslider" id="slider">' + slides.join('') + ctrl + '</section><div class="wrap">' +
      '<div class="brandstrip"><span class="lbl">Подбор по бренду принтера</span><div class="logos">' + strip + '<a class="chip" href="' + link('catalog', { cat: 'laser' }) + '">Все 16 брендов →</a></div></div>' +
      '<div class="layout"><aside class="side">' + sideCats('') + sideInfo() + '</aside><div class="content">' +
      '<div class="tiles">' + tiles + '</div><div class="tiles-s">' + tilesS + '</div>' +
      '<div class="sec"><div class="sec-head"><h2>Лучшие предложения</h2><a class="more" href="' + link('catalog', { sort: 'pop' }) + '">Все товары ' + ic('arrow-right', 18) + '</a></div><div class="grid4">' + best.map(card).join('') + '</div></div>' +
      '<div class="sec">' + advantages() + '</div>' +
      '<div class="sec"><div class="sec-head"><h2>Популярные модели принтеров</h2><a class="more" href="' + link('page', { id: 'compat' }) + '">Таблицы совместимости ' + ic('arrow-right', 18) + '</a></div><div class="tags">' + tags.map(function (t) { var q = t.split(' ').slice(-1)[0]; return '<a class="chip" href="' + link('catalog', { q: q }) + '">' + esc(t) + '</a>'; }).join('') + '<a class="chip chip-y" href="' + link('finder') + '">Подбор по модели →</a></div></div>' +
      '<div class="sec"><div class="about"><div><h2>Hi-Black® — современные расходные материалы для офисной печатающей техники</h2><p>Hi-Black — один из крупнейших поставщиков совместимых картриджей, тонеров и чернил на рынке России. Продукция проходит контроль качества на каждом этапе производства, заправляется повторно и восстанавливается, не нарушает патенты производителей принтеров.</p><p>В фирменном магазине — полный ассортимент бренда с отгрузкой со склада в Москве, актуальные таблицы совместимости и подбор по модели принтера.</p><a class="btn btn-o" href="' + link('page', { id: 'about' }) + '">О бренде Hi-Black</a></div><div class="lines">' + D.lines.map(function (l) { return '<a class="line-c" href="' + link('page', { id: 'lines' }) + '"><b>' + esc(l[0]) + '</b><span>' + esc(l[1]) + '</span></a>'; }).join('') + '</div></div></div>' +
      '</div></div></div>';
  }

  function catalog(p) {
    var cat = p.cat || '', brand = p.brand || '';
    var all = applyFilters(p), sorted = sortList(all, p.sort);
    var pp = +(p.pp || 12), page = +(p.page || 1), acc = p.acc === '1';
    var start = acc ? 0 : (page - 1) * pp, end = page * pp, shown = sorted.slice(start, end);
    var pages = Math.max(1, Math.ceil(sorted.length / pp));
    var title = cat ? catName(cat) : (p.sale ? 'Акции и скидки' : (p.q ? 'Поиск: «' + p.q + '»' : 'Все товары'));
    if (brand) title += ' ' + brandName(brand);
    var cr = [['Главная', link('home')]]; if (cat) cr.push([catName(cat), brand ? link('catalog', { cat: cat }) : '']); if (brand) cr.push([brandName(brand), '']); if (!cat) cr.push([title, '']);
    // brand chips (laser)
    var chips = '';
    if (cat === 'laser' || (!cat && !p.q && !p.sale)) {
      chips = '<div class="brands"><a class="chip ' + (!brand ? 'chip-on' : '') + '" href="' + link('catalog', Object.assign({}, p, { brand: '', page: '' })) + '">Все бренды</a>' + D.laserBrands.map(function (b) { return '<a class="chip ' + (brand === b ? 'chip-on' : '') + '" href="' + link('catalog', Object.assign({}, p, { cat: 'laser', brand: b, page: '' })) + '">' + (D.brands[b].logo ? brandLogo(b, 16, '') : '') + esc(brandName(b)) + '</a>'; }).join('') + '</div>';
    }
    // facets
    function cnt(except, test) { return applyFilters(p, except).filter(test).length; }
    function chk(key, val, label, on, n, dot) {
      return '<label class="check' + (n === 0 && !on ? ' dis' : '') + '"><input type="checkbox" data-f="' + key + '" value="' + esc(val) + '"' + (on ? ' checked' : '') + '><i>' + (on ? ic('check', 14) : '') + '</i>' + (dot ? '<span class="dot" style="background:' + dot + '"></span>' : '') + esc(label) + '<span class="n">' + n + '</span></label>';
    }
    var resF = RES.map(function (r) { return chk('res', r.id, r.name, list(p.res).indexOf(r.id) >= 0, cnt('res', function (x) { return x.res != null && r.t(x.res); })); }).join('');
    var colorF = COLORS.map(function (c) { var n = cnt('color', function (x) { return x.color === c; }); return n || list(p.color).indexOf(c) >= 0 ? chk('color', c, c, list(p.color).indexOf(c) >= 0, n, COLOR_HEX[c]) : ''; }).join('');
    var chipF = chk('chip', '1', 'С чипом', list(p.chip).indexOf('1') >= 0, cnt('chip', function (x) { return x.chip === true; })) + chk('chip', '0', 'Без чипа', list(p.chip).indexOf('0') >= 0, cnt('chip', function (x) { return x.chip === false; }));
    var types = {}; applyFilters(p, 'type').forEach(function (x) { types[x.type] = (types[x.type] || 0) + 1; }); list(p.type).forEach(function (t) { types[t] = types[t] || 0; });
    var typeF = Object.keys(types).sort().map(function (t) { return chk('type', t, t, list(p.type).indexOf(t) >= 0, types[t]); }).join('');
    var prices = applyFilters(p, 'price').map(function (x) { return x.price; }); var pmin = prices.length ? Math.min.apply(null, prices) : 0, pmax = prices.length ? Math.max.apply(null, prices) : 0;
    var side = '<aside class="side' + (p.f === '1' ? ' open' : '') + '"><div class="side-head">Фильтры<button type="button" data-close-f>' + ic('close', 18) + '</button></div>' + sideCats(cat, brand) +
      '<div class="sbox fbox" style="padding:20px 20px 22px"><div class="filters">' +
      '<div class="fgroup"><div class="ft">Модель принтера</div><div class="field" style="height:44px;font-size:14px;gap:10px">' + ic('search', 16) + '<input type="text" data-f="q" value="' + esc(p.q || '') + '" placeholder="Например, M2135dn"></div></div>' +
      '<div class="fgroup"><div class="ft">Цена, ₽</div><div class="range"><div class="field"><span>от</span><input type="number" data-f="pmin" value="' + esc(p.pmin || '') + '" placeholder="' + pmin + '"></div><div class="field"><span>до</span><input type="number" data-f="pmax" value="' + esc(p.pmax || '') + '" placeholder="' + pmax + '"></div></div><div class="fhint">В выборке: ' + fmt(pmin) + ' – ' + fmt(pmax) + ' ₽</div></div>' +
      '<div class="fgroup"><div class="ft">Ресурс печати</div>' + resF + '</div>' +
      (colorF ? '<div class="fgroup"><div class="ft">Цвет</div>' + colorF + '</div>' : '') +
      (cat === 'laser' || !cat ? '<div class="fgroup"><div class="ft">Чип</div>' + chipF + '</div>' : '') +
      '<div class="fgroup"><div class="ft">Тип продукции</div>' + typeF + '</div>' +
      '<div class="fgroup" style="border:0;padding-bottom:6px"><label class="toggle">Только в наличии<input type="checkbox" data-f="stock" value="1"' + (p.stock ? ' checked' : '') + '><i></i></label></div>' +
      '<div class="fbtns"><button class="btn btn-y btn-full" type="button" data-close-f>Показать ' + sorted.length + ' ' + plural(sorted.length, 'товар', 'товара', 'товаров') + '</button><a class="btn btn-s btn-full btn-sm" href="' + link('catalog', { cat: cat, brand: brand }) + '">Сбросить фильтры</a></div>' +
      '</div></div>' + sideInfo() + '</aside>';
    // applied chips
    var applied = [];
    if (brand) applied.push(['Бренд: ' + brandName(brand), Object.assign({}, p, { brand: '' })]);
    if (p.q) applied.push(['Поиск: ' + p.q, Object.assign({}, p, { q: '' })]);
    if (p.pmin || p.pmax) applied.push(['Цена ' + (p.pmin ? 'от ' + p.pmin : '') + (p.pmax ? ' до ' + p.pmax : '') + ' ₽', Object.assign({}, p, { pmin: '', pmax: '' })]);
    list(p.res).forEach(function (id) { var r = RES.filter(function (k) { return k.id === id; })[0]; if (r) applied.push(['Ресурс ' + r.name, toggleIn(Object.assign({}, p), 'res', id)]); });
    list(p.color).forEach(function (c) { applied.push([c, toggleIn(Object.assign({}, p), 'color', c)]); });
    list(p.chip).forEach(function (c) { applied.push([c === '1' ? 'С чипом' : 'Без чипа', toggleIn(Object.assign({}, p), 'chip', c)]); });
    list(p.type).forEach(function (t) { applied.push([t, toggleIn(Object.assign({}, p), 'type', t)]); });
    if (p.stock) applied.push(['В наличии', Object.assign({}, p, { stock: '' })]);
    if (p.sale) applied.push(['Со скидкой', Object.assign({}, p, { sale: '' })]);
    var appliedHtml = applied.length ? '<div class="applied">' + applied.map(function (a) { a[1].page = ''; return '<a class="chip" href="' + link('catalog', a[1]) + '">' + esc(a[0]) + ' ' + ic('close', 14) + '</a>'; }).join('') + '<a class="clear" href="' + link('catalog', { cat: cat }) + '">Сбросить всё</a></div>' : '';
    var sortOpts = [['pop', 'По популярности'], ['price', 'Сначала дешевле'], ['-price', 'Сначала дороже'], ['rating', 'По рейтингу'], ['new', 'Новинки']];
    var toolbar = '<div class="toolbar"><div class="l"><button class="sel mfilterbtn" type="button" data-open-f>' + ic('sliders', 18) + 'Фильтры' + (applied.length ? ' <i class="fn">' + applied.length + '</i>' : '') + '</button><label class="sel sel-sort">' + ic('sort', 18) + '<select data-f="sort">' + sortOpts.map(function (o) { return '<option value="' + o[0] + '"' + ((p.sort || 'pop') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' + ic('chev-down', 14) + '</label><label class="sel sel-pp"><select data-f="pp">' + [12, 24, 48].map(function (n) { return '<option value="' + n + '"' + (pp === n ? ' selected' : '') + '>Показывать по ' + n + '</option>'; }).join('') + '</select>' + ic('chev-down', 14) + '</label></div><div class="r"><a class="muted small" href="' + link('compare') + '">Сравнить: ' + count(S.cmp) + '</a><div class="view"><span class="on">' + ic('grid', 18) + '</span><span>' + ic('list', 18) + '</span></div></div></div>';
    var grid = shown.length ? '<div class="grid3">' + shown.map(card).join('') + '</div>' : '<div class="empty"><h3>Ничего не нашлось</h3><p>Попробуйте изменить фильтры или ввести другую модель принтера. Например, «M2135dn» или «CF283A».</p><a class="btn btn-o" href="' + link('catalog', { cat: cat }) + '">Сбросить фильтры</a></div>';
    var pager = '';
    if (pages > 1) {
      var pl = []; for (var i = 1; i <= pages; i++) { if (pages > 7 && i > 3 && i < pages - 1 && Math.abs(i - page) > 1) { if (pl[pl.length - 1] !== '…') pl.push('…'); continue; } pl.push(i); }
      pager = '<div class="pager">' + (end < sorted.length ? '<a class="btn btn-o" href="' + link('catalog', Object.assign({}, p, { page: page + 1, acc: '1' })) + '">' + ic('refresh', 18) + 'Показать ещё ' + Math.min(pp, sorted.length - end) + '</a>' : '<span></span>') + '<div class="pages">' + (page > 1 ? '<a href="' + link('catalog', Object.assign({}, p, { page: page - 1, acc: '' })) + '">' + ic('chev-left', 16) + '</a>' : '') + pl.map(function (n) { return n === '…' ? '<span>…</span>' : '<a class="' + (n === page ? 'on' : '') + '" href="' + link('catalog', Object.assign({}, p, { page: n, acc: '' })) + '">' + n + '</a>'; }).join('') + (page < pages ? '<a href="' + link('catalog', Object.assign({}, p, { page: page + 1, acc: '' })) + '">' + ic('chev-right', 16) + '</a>' : '') + '</div></div>';
    }
    var seo = cat === 'laser' && brand === 'kyocera' ? '<div class="seo"><h3>Картриджи Hi-Black для принтеров и МФУ Kyocera</h3><p>Совместимые картриджи Hi-Black серии TK для лазерных принтеров и МФУ Kyocera ECOSYS, FS и TASKalfa: стандартный и увеличенный ресурс, версии с чипом и без чипа, чёрные и цветные комплекты для P5026cdn и M5526cdn. Каждый картридж проходит контроль качества печати и заявленного ресурса.</p><p>Чтобы не ошибиться с выбором, введите модель принтера в поле подбора или откройте таблицу совместимости — в ней указаны все модели Kyocera, для которых подходит каждый артикул.</p></div>' : (cat ? '<div class="seo"><h3>' + esc(catName(cat)) + ' Hi-Black</h3><p>' + esc(D.cats.filter(function (c) { return c.id === cat; })[0].seo) + '</p></div>' : '');
    return '<div class="wrap"><div class="ph1">' + crumbs(cr) + '<h1>' + esc(title) + ' <span>' + sorted.length + ' ' + plural(sorted.length, 'товар', 'товара', 'товаров') + '</span></h1>' + chips + '</div>' +
      '<div class="layout cat">' + side + '<div class="content">' + toolbar + appliedHtml + grid + pager + seo + '</div></div></div>';
  }

  function description(p) {
    var bn = brandName(p.brand), first = p.models[0] ? bn + ' ' + p.models[0] : bn;
    var kind = p.type === 'Тонер' ? 'Тонер' : (p.type === 'Чернила' ? 'Чернила' : (p.type === 'Запчасть' ? 'Запасная часть' : 'Совместимый ' + p.type.toLowerCase()));
    var out = '<h3>' + esc(kind + ' Hi-Black ' + p.code) + '</h3>';
    out += '<p>' + esc(kind) + ' Hi-Black ' + esc(p.code) + (p.compat ? ' для ' + esc(p.compat.replace(/^для\s+/, '')) : '') + '.' + (p.res ? ' Ресурс — ' + fmt(p.res) + ' страниц формата A4 при 5% заполнении, что соответствует оригинальному расходнику ' + esc(bn + ' ' + p.model) + '.' : '') + '</p>';
    if (p.chip === true) out += '<p>Встроенный чип корректно распознаётся принтером и ведёт учёт отпечатков — после установки не нужно сбрасывать счётчик или менять настройки. Тонер подобран под печку ' + esc(bn) + ': равномерная заливка, чёткий мелкий текст, без полос и осыпания.</p>';
    else if (p.chip === false) out += '<p>Версия без чипа: перед установкой переставьте чип со старого картриджа или используйте принтер с отключённым контролем расходников. Тонер подобран под печку ' + esc(bn) + ': равномерная заливка, чёткий мелкий текст, без полос.</p>';
    else if (p.type === 'Тонер') out += '<p>Тонер в банке для самостоятельной заправки картриджей. Подобран по составу и температуре плавления под печку ' + esc(bn) + ' — заправленный картридж печатает так же, как новый.</p>';
    else if (p.type === 'Чернила') out += '<p>Водорастворимые чернила для заправки картриджей и СНПЧ. Не засоряют дюзы печатающей головки, дают насыщенный цвет и совпадают по профилю с оригинальными.</p>';
    else out += '<p>Продукция Hi-Black проходит контроль качества на каждом этапе производства и не нарушает патенты производителя оборудования.</p>';
    out += '<ul>' + (p.res ? '<li>Заявленный ресурс подтверждён тестами по ISO/IEC 19752</li>' : '') + '<li>Не нарушает патенты производителя принтера</li><li>Гарантия 12 месяцев, обмен при браке</li></ul>';
    out += '<p>Если сомневаетесь в совместимости, введите модель принтера в поле подбора в шапке сайта — покажем все подходящие расходники.</p>';
    return out;
  }
  function specRows(p, short) {
    var rows = [];
    if (p.equip) rows.push(['Тип оборудования', p.equip]);
    rows.push(['Торговая марка', 'Hi-Black'], ['Код производителя', p.code]);
    if (p.model) rows.push(['Модель', p.model]);
    rows.push(['Тип продукции', p.type]);
    if (p.tech) rows.push(['Технология печати', p.tech]);
    if (p.print) rows.push(['Тип печати', p.print]);
    if (p.res) rows.push(['Ресурс', fmt(p.res) + ' страниц при 5% заполнении']);
    if (p.color) rows.push(['Цвет', p.color]);
    if (p.chip !== null && p.chip !== undefined) rows.push(['Чип', p.chip ? 'Есть' : 'Нет']);
    if (p.weight) rows.push(['Вес нетто', p.weight]);
    if (p.compat) rows.push(['Совместимость', p.compat.replace(/^для\s+/, '')]);
    rows.push(['Вендор оборудования', brandName(p.brand)]);
    if (p.model && p.type !== 'Тонер' && p.type !== 'Чернила') rows.push(['Оригинальный аналог', brandName(p.brand) + ' ' + p.model]);
    rows.push(['Гарантия', '12 месяцев'], ['Страна производства', 'Китай']);
    if (short) rows = rows.slice(0, 9);
    return rows.map(function (r) { return '<div class="sr"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>'; }).join('');
  }
  function product(pr) {
    var p = byId(pr.id) || D.products[0];
    var tab = pr.tab || 'desc';
    var related = sortList(D.products.filter(function (x) { return x.id !== p.id && x.brand === p.brand && x.cat === p.cat; }), 'pop').slice(0, 4);
    if (related.length < 4) related = related.concat(sortList(D.products.filter(function (x) { return x.id !== p.id && x.cat === p.cat && related.indexOf(x) < 0; }), 'pop').slice(0, 4 - related.length));
    var revs = reviewsFor(p), sum5 = Math.round(p.n * 0.75), sum4 = p.n - sum5;
    var src = D.img[p.img];
    var views = [{ t: 'img' }, { t: 'zoom', pos: '18% 50%' }, { t: 'zoom', pos: '82% 50%' }];
    if (p.models.length) views.push({ t: 'compat' });
    var thumbs = views.map(function (v, i) {
      var inner = v.t === 'img' ? '<img src="' + src + '" alt="">' : (v.t === 'zoom' ? '<span class="tz" style="background-image:url(' + src + ');background-position:' + v.pos + '"></span>' : brandLogo(p.brand, 14, '') + '<span class="tl">Совместимость</span>');
      return '<div class="thumb ' + (i === 0 ? 'on' : '') + (v.t === 'compat' ? ' tcompat' : '') + '" data-view="' + i + '" title="' + (v.t === 'img' ? 'Общий вид' : (v.t === 'zoom' ? 'Крупный план' : 'Совместимые модели')) + '">' + inner + '</div>';
    }).join('');
    var compatCard = '<div class="gcompat" data-gview="compat" hidden>' + brandLogo(p.brand, 34, '') + '<h3>Подходит для принтеров ' + esc(brandName(p.brand)) + '</h3><div class="tags">' + p.models.map(function (m) { return '<a class="chip" href="' + link('catalog', { q: m }) + '">' + esc(m) + '</a>'; }).join('') + '</div></div>';
    var key = [];
    if (p.res) key.push(['Ресурс', fmt(p.res) + ' страниц']); if (p.color) key.push(['Цвет', p.color]); if (p.chip !== null && p.chip !== undefined) key.push(['Чип', p.chip ? 'Есть' : 'Нет']); key.push(['Тип', p.type]); if (p.model && p.type !== 'Тонер') key.push(['Оригинальный аналог', brandName(p.brand) + ' ' + p.model]); if (p.weight) key.push(['Вес нетто', p.weight]); key.push(['Гарантия', '12 месяцев']);
    var compatChips = p.models.map(function (m) { return '<a class="chip" href="' + link('catalog', { q: m }) + '">' + esc(brandName(p.brand) + ' ' + m) + '</a>'; }).join('');
    var tabs = [['desc', 'Описание'], ['specs', 'Характеристики'], ['reviews', 'Отзывы <i>' + p.n + '</i>'], ['delivery', 'Доставка и оплата']];
    return '<div class="wrap"><div class="ph1 pph">' + crumbs([['Главная', link('home')], [catName(p.cat), link('catalog', { cat: p.cat })], [brandName(p.brand), link('catalog', { cat: p.cat, brand: p.brand })], [p.code, '']]) +
      '<h1>' + esc(p.name) + '</h1>' +
      '<div class="pmeta"><span class="rate">' + stars(p.rate, 16) + '<b>' + ratef(p.rate) + '</b><a href="#" data-tab-link="reviews">' + p.n + ' ' + plural(p.n, 'отзыв', 'отзыва', 'отзывов') + '</a></span><span>Артикул: <b>' + esc(p.code) + '</b></span><span>Код товара: <b>' + (100000 + hash(p.id) % 900000) + '</b></span>' + badge(p) + '</div></div>' +
      '<div class="pgrid"><div class="gallery"><div class="gmain" id="gmain" data-src="' + src + '"><img src="' + src + '" alt="' + esc(p.name) + '" data-gview="img"><div class="gzoom" data-gview="zoom" style="background-image:url(' + src + ')" hidden></div>' + compatCard + (badge(p) ? '<div class="cbadges">' + badge(p) + '</div>' : '') + '<span class="gbrand">Для принтеров ' + brandLogo(p.brand, 16, '') + '</span><span class="zoom">' + ic('zoom', 16) + 'Открыть фото</span></div><div class="thumbs">' + thumbs + '<div class="thumb video">' + ic('play', 20) + 'Видео</div></div></div>' +
      '<div class="pinfo"><div class="keyspecs"><h3>Коротко о товаре</h3>' + key.map(function (k) { return '<div class="krow"><span>' + esc(k[0]) + '</span><b>' + esc(k[1]) + '</b></div>'; }).join('') + '</div>' +
      (compatChips ? '<div class="compat"><h3>Подходит для принтеров ' + brandLogo(p.brand, 18, '') + '</h3><div class="tags">' + compatChips + '</div></div>' : '') +
      '<a class="allspecs" href="#" data-tab-link="specs">Все характеристики ' + ic('chev-down', 16) + '</a></div>' +
      '<div class="buy"><div class="prow"><div class="price">' + fmt(p.price) + ' ₽' + (p.old ? '<small>' + fmt(p.old) + ' ₽</small>' : '') + '</div><span class="per">за 1 шт.</span></div>' +
      (p.stock ? '<div class="avail"><i></i>В наличии на складе в Москве</div><div class="stock">Отгрузка сегодня при заказе до 16:00</div>' : '<div class="avail out"><i></i>Под заказ</div><div class="stock">Привезём со склада поставщика за 3–5 дней</div>') +
      '<div class="brow"><div class="qty"><button type="button" data-q="-1">' + ic('minus', 18) + '</button><span id="pq">1</span><button type="button" data-q="1">' + ic('plus', 18) + '</button></div><button class="btn btn-y btn-lg" type="button" data-add="' + p.id + '" data-useq="1">' + ic('cart', 20) + 'В корзину</button></div>' +
      '<a class="btn btn-o btn-full" href="' + link('checkout', { quick: p.id }) + '">Купить в 1 клик</a>' +
      '<div class="acts"><button type="button" class="' + (S.cmp[p.id] ? 'on' : '') + '" data-cmp="' + p.id + '">' + ic('compare', 16) + (S.cmp[p.id] ? 'В сравнении' : 'В сравнение') + '</button><button type="button" class="' + (S.fav[p.id] ? 'on' : '') + '" data-fav="' + p.id + '">' + ic('heart', 16) + (S.fav[p.id] ? 'В избранном' : 'В избранное') + '</button></div>' +
      '<div class="dlist"><div>' + ic('truck', 18) + '<div><b>Курьером по Москве — завтра</b><span>По России — СДЭК, Boxberry, Почта, 2–7 дней</span></div></div><div>' + ic('pin', 18) + '<div><b>Самовывоз — сегодня</b><span>Со склада в Москве, бесплатно</span></div></div><div>' + ic('card', 18) + '<div><b>Оплата картой, СБП или по счёту</b><span>Юрлицам — счёт и закрывающие документы</span></div></div><div>' + ic('shield', 18) + '<div><b>Гарантия ресурса 12 месяцев</b><span>Обмен или возврат при браке</span></div></div></div>' +
      '<a class="ask" href="' + link('page', { id: 'contacts' }) + '">' + ic('chat', 22) + '<div><b>Задать вопрос о товаре</b><span>Ответим в чате или по телефону</span></div></a></div></div>' +
      '<div class="tabs" id="ptabs">' + tabs.map(function (t) { return '<button type="button" class="' + (tab === t[0] ? 'on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div class="tabbody">' +
      '<div data-panel="desc"' + (tab !== 'desc' ? ' hidden' : '') + ' class="desc-grid"><div class="desc">' + description(p) + '</div><div class="spec-t"><div class="sh">Основные характеристики</div>' + specRows(p, true) + '</div></div>' +
      '<div data-panel="specs"' + (tab !== 'specs' ? ' hidden' : '') + '><div class="spec-t spec-full"><div class="sh">Характеристики</div>' + specRows(p) + '</div></div>' +
      '<div data-panel="reviews"' + (tab !== 'reviews' ? ' hidden' : '') + ' id="reviews"><div class="rev-grid"><div class="rev-sum"><div class="big"><b>' + ratef(p.rate) + '</b><span>из 5</span></div>' + stars(p.rate, 20) + '<div class="cnt">' + p.n + ' ' + plural(p.n, 'отзыв', 'отзыва', 'отзывов') + ' · ' + Math.round(80 + p.rate * 3) + '% рекомендуют</div><div class="bars"><div><span>5</span><i style="--w:' + Math.round(sum5 / p.n * 100) + '%"></i><span>' + sum5 + '</span></div><div><span>4</span><i style="--w:' + Math.round(sum4 / p.n * 100) + '%"></i><span>' + sum4 + '</span></div><div><span>3</span><i style="--w:0%"></i><span>0</span></div><div><span>2</span><i style="--w:0%"></i><span>0</span></div><div><span>1</span><i style="--w:0%"></i><span>0</span></div></div><button class="btn btn-k btn-full" type="button" data-scroll="#rev-form">Написать отзыв</button><div class="note">Отзывы и оценки в макете — примеры для демонстрации блока.</div></div>' +
      '<div class="rev-list">' + revs.map(function (r) { return '<article class="rev"><div class="rh"><div class="who"><span class="ava">' + esc(r.name[0]) + '</span><div><b>' + esc(r.name) + '</b><span>' + esc(r.city) + ' · <span class="ver">' + ic('check', 12) + 'Покупка подтверждена</span></span></div></div><span class="date">' + r.date + '</span></div><div class="rt">' + stars(r.rate) + '<span>Принтер: ' + esc(r.printer) + '</span></div><p>' + esc(r.text) + '</p><div class="pm"><div><b>Достоинства</b>' + esc(r.plus) + '</div><div><b>Недостатки</b>' + esc(r.minus) + '</div></div><div class="useful">Отзыв полезен?<button type="button" data-useful>' + ic('check', 14) + 'Да · ' + (2 + hash(r.name + p.id) % 9) + '</button><button type="button">Нет · 0</button></div></article>'; }).join('') +
      (p.n > revs.length ? '<a class="btn btn-o" href="#" data-more-rev>Показать ещё ' + (p.n - revs.length) + ' ' + plural(p.n - revs.length, 'отзыв', 'отзыва', 'отзывов') + '</a>' : '') +
      '<form class="rev-form" id="rev-form"><h3>Оставить отзыв</h3><p>Расскажите, как расходник работает на вашем принтере — это поможет другим покупателям.</p><div class="frate">Оценка ' + stars(5, 24) + '</div><div class="row"><div class="field"><input type="text" placeholder="Ваше имя" required></div><div class="field"><input type="text" placeholder="Модель принтера"></div></div><textarea placeholder="Достоинства, недостатки, впечатления от печати" required></textarea><div class="fbtn"><button class="btn btn-y" type="submit">Отправить отзыв</button><span>Отзыв появится после проверки модератором. Ваш email не публикуется.</span></div></form></div></div></div>' +
      '<div data-panel="delivery"' + (tab !== 'delivery' ? ' hidden' : '') + '><div class="desc" style="max-width:820px">' + D.pageText.delivery_short + '</div></div>' +
      '</div>' +
      '<div class="sec"><div class="sec-head"><h2>Похожие товары</h2><a class="more" href="' + link('catalog', { cat: p.cat, brand: p.brand }) + '">Все для ' + esc(brandName(p.brand)) + ' ' + ic('arrow-right', 18) + '</a></div><div class="grid4">' + related.map(card).join('') + '</div></div>' +
      '<div class="buybar" id="buybar"><div class="bp"><div class="price">' + fmt(p.price) + ' ₽' + (p.old ? '<small>' + fmt(p.old) + ' ₽</small>' : '') + '</div>' + (p.stock ? '<div class="avail"><i></i>В наличии, отгрузка сегодня</div>' : '<div class="avail out"><i></i>Под заказ, 3–5 дней</div>') + '</div><button class="btn btn-y" type="button" data-add="' + p.id + '" data-useq="1">' + ic('cart', 18) + 'В корзину</button></div></div>';
  }

  function cart() {
    var items = cartItems(), n = cartCount(), sum = cartSum(), promo = S.promo === 'HIBLACK5' ? Math.round(sum * 0.05) : 0;
    if (!items.length) return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Корзина', '']]) + '<h1>Корзина</h1></div><div class="empty big"><h3>В корзине пока пусто</h3><p>Подберите картридж по модели принтера или загляните в лучшие предложения.</p><div class="acts"><a class="btn btn-y" href="' + link('finder') + '">Подобрать по принтеру</a><a class="btn btn-o" href="' + link('catalog') + '">В каталог</a></div></div></div>';
    var addon = sortList(D.products.filter(function (x) { return !S.cart[x.id]; }), 'pop').slice(0, 3);
    var list = items.map(function (it) {
      var p = it.p;
      return '<div class="item"><a class="img" href="' + link('product', { id: p.id }) + '"><img src="' + D.img[p.img] + '" alt=""></a>' +
        '<div class="ibody"><a class="t" href="' + link('product', { id: p.id }) + '">' + esc(p.name) + '</a><div class="m"><span>Артикул ' + esc(p.code) + '</span>' + (p.res ? '<span>Ресурс ' + fmt(p.res) + ' стр.</span>' : '') + '<span>Для ' + brandLogo(p.brand, 12, '') + '</span>' + (p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Под заказ</span>') + '</div><div class="u">' + fmt(p.price) + ' ₽ за шт.</div></div>' +
        '<div class="ictl"><div class="qty"><button type="button" data-cq="' + p.id + '" data-d="-1" aria-label="Меньше">' + ic('minus', 18) + '</button><span>' + it.q + '</span><button type="button" data-cq="' + p.id + '" data-d="1" aria-label="Больше">' + ic('plus', 18) + '</button></div><div class="sum"><div class="price">' + fmt(p.price * it.q) + ' ₽</div><small>' + it.q + ' шт.</small></div></div>' +
        '<button class="rm" type="button" data-rm="' + p.id + '" title="Удалить" aria-label="Удалить из корзины">' + ic('trash', 18) + '</button></div>';
    }).join('');
    var promoHtml = '<form class="promo" id="promo-form"><div class="field"><input type="text" name="promo" placeholder="Промокод" value="' + esc(S.promo || '') + '" aria-label="Промокод"></div><button class="btn btn-o" type="submit">Применить</button>' + (promo ? '<span class="ok">' + ic('check', 16) + 'Скидка 5% применена</span>' : (S.promoErr ? '<span class="err">Промокод не найден</span>' : '<span class="muted xs">Для теста: HIBLACK5</span>')) + '</form>';
    var addonHtml = addon.map(function (p) { return '<div class="mini"><a class="img" href="' + link('product', { id: p.id }) + '"><img src="' + D.img[p.img] + '" alt=""></a><div class="mb"><a class="t" href="' + link('product', { id: p.id }) + '">' + esc(p.name) + '</a><div class="p"><div class="price">' + fmt(p.price) + ' ₽</div><button class="add" type="button" data-add="' + p.id + '" aria-label="В корзину">' + ic('plus', 18) + '</button></div></div></div>'; }).join('');
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Корзина', '']]) + '<h1>Корзина <span>' + n + ' ' + plural(n, 'товар', 'товара', 'товаров') + ' · ' + fmt(sum) + ' ₽</span></h1>' +
      '<div class="steps"><div class="step on"><i>1</i><span>Корзина</span></div><div class="step"><i>2</i><span>Доставка и оплата</span></div><div class="step"><i>3</i><span>Подтверждение</span></div></div></div>' +
      '<div class="cgrid">' +
      '<div class="clist"><div class="chead"><span>' + n + ' ' + plural(n, 'товар', 'товара', 'товаров') + '</span><div class="r"><a href="#" data-fav-all>' + ic('heart', 16) + 'Всё в избранное</a><a href="#" data-clear-cart>' + ic('trash', 16) + 'Очистить корзину</a></div></div>' + list +
      '<div class="cfootr">' + promoHtml + '<a class="back" href="' + link('catalog') + '">' + ic('chev-left', 16) + 'Продолжить покупки</a></div></div>' +
      '<div class="summary"><h3>Ваш заказ</h3><div class="srow"><span>Товары, ' + n + ' шт.</span><b>' + fmt(sum) + ' ₽</b></div><div class="srow"><span>Скидка</span><b>' + (promo ? '−' + fmt(promo) + ' ₽' : '0 ₽') + '</b></div><div class="srow"><span>Доставка</span><b class="soft">рассчитаем на следующем шаге</b></div><div class="srow total"><span>Итого</span><b>' + fmt(sum - promo) + ' ₽</b></div><a class="btn btn-y btn-lg btn-full" href="' + link('checkout') + '">Оформить заказ' + ic('arrow-right', 20) + '</a><div class="payrow"><span>МИР</span><span>VISA</span><span>MC</span><span>СБП</span><span>СЧЁТ ДЛЯ ЮРЛИЦ</span></div><div class="biz">' + ic('building', 20) + '<div><b>Заказ для компании?</b>На следующем шаге выберите «Юридическое лицо» — счёт придёт на почту, документы отдадим с заказом.</div></div><div class="note">Нажимая «Оформить заказ», вы соглашаетесь с условиями <a href="' + link('page', { id: 'offer' }) + '">оферты</a> и <a href="' + link('page', { id: 'privacy' }) + '">политикой обработки персональных данных</a>.</div></div>' +
      '<div class="sec addon-sec"><div class="sec-head"><h3>Добавить к заказу</h3><a class="more" href="' + link('catalog') + '">Ещё ' + ic('arrow-right', 18) + '</a></div><div class="addon">' + addonHtml + '</div></div>' +
      '</div>' +
      '<div class="sec">' + advantages() + '</div></div>';
  }

  function checkout(pr) {
    if (pr.quick && byId(pr.quick) && !S.cart[pr.quick]) { S.cart[pr.quick] = 1; save(); updateHeader(); }
    var items = cartItems(), sum = cartSum(), promo = S.promo === 'HIBLACK5' ? Math.round(sum * 0.05) : 0;
    if (!items.length) return cart();
    var d = S.co || {}; var deliv = d.deliv || 'courier', pay = d.pay || 'card', biz = d.biz === '1';
    var DEL = [['courier', 'Курьером по Москве', 'завтра, с 10:00 до 18:00', 350], ['pickup', 'Самовывоз в Москве', 'сегодня после 14:00', 0], ['cdek', 'СДЭК до пункта выдачи', '2–5 дней по России', 300], ['post', 'Почта России', '4–10 дней', 350]];
    var PAY = [['card', 'Картой онлайн', 'МИР, Visa, Mastercard'], ['sbp', 'СБП', 'По QR-коду в приложении банка'], ['cash', 'При получении', 'Наличными или картой курьеру'], ['invoice', 'По счёту для юрлиц', 'Счёт на email, закрывающие документы с заказом']];
    var dcost = DEL.filter(function (x) { return x[0] === deliv; })[0][3];
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Корзина', link('cart')], ['Оформление заказа', '']]) + '<h1>Оформление заказа</h1>' +
      '<div class="steps"><a class="step done" href="' + link('cart') + '"><i>' + ic('check', 14) + '</i><span>Корзина</span></a><div class="step on"><i>2</i><span>Доставка и оплата</span></div><div class="step"><i>3</i><span>Подтверждение</span></div></div></div>' +
      '<form class="cgrid" id="co-form"><div class="co">' +
      '<section class="cobox"><h3>1. Получатель</h3><div class="segs"><label class="seg' + (!biz ? ' on' : '') + '"><input type="radio" name="biz" value="0"' + (!biz ? ' checked' : '') + '>Физическое лицо</label><label class="seg' + (biz ? ' on' : '') + '"><input type="radio" name="biz" value="1"' + (biz ? ' checked' : '') + '>Юридическое лицо</label></div>' +
      '<div class="row2"><label class="fld"><span>Имя и фамилия</span><input type="text" name="name" required value="' + esc(d.name || '') + '" placeholder="Иван Петров"></label><label class="fld"><span>Телефон</span><input type="tel" name="phone" required value="' + esc(d.phone || '') + '" placeholder="+7 (___) ___-__-__"></label></div>' +
      '<div class="row2"><label class="fld"><span>Email</span><input type="email" name="email" value="' + esc(d.email || '') + '" placeholder="Для чека и статуса заказа"></label>' + (biz ? '<label class="fld"><span>ИНН компании</span><input type="text" name="inn" value="' + esc(d.inn || '') + '" placeholder="10 или 12 цифр"></label>' : '<span></span>') + '</div>' +
      (biz ? '<label class="fld"><span>Название организации</span><input type="text" name="company" value="' + esc(d.company || '') + '" placeholder="ООО «Компания»"></label>' : '') + '</section>' +
      '<section class="cobox"><h3>2. Доставка</h3><div class="opts">' + DEL.map(function (x) { return '<label class="opt' + (deliv === x[0] ? ' on' : '') + '"><input type="radio" name="deliv" value="' + x[0] + '"' + (deliv === x[0] ? ' checked' : '') + '><span class="rd"></span><span class="ot"><b>' + x[1] + '</b><span>' + x[2] + '</span></span><span class="oc">' + (x[3] ? fmt(x[3]) + ' ₽' : 'бесплатно') + '</span></label>'; }).join('') + '</div>' +
      (deliv === 'pickup' ? '<div class="pickup">' + ic('pin', 18) + '<div><b>Склад в Москве</b><span>[Адрес самовывоза] · Пн–Пт 9:00–18:00</span></div></div>' : '<label class="fld"><span>Адрес доставки</span><input type="text" name="address" value="' + esc(d.address || '') + '" placeholder="Город, улица, дом, квартира или офис"></label>') +
      '<label class="fld"><span>Комментарий к заказу</span><input type="text" name="comment" value="' + esc(d.comment || '') + '" placeholder="Код домофона, удобное время, пожелания"></label></section>' +
      '<section class="cobox"><h3>3. Оплата</h3><div class="opts">' + PAY.map(function (x) { if (x[0] === 'invoice' && !biz) return ''; return '<label class="opt' + (pay === x[0] ? ' on' : '') + '"><input type="radio" name="pay" value="' + x[0] + '"' + (pay === x[0] ? ' checked' : '') + '><span class="rd"></span><span class="ot"><b>' + x[1] + '</b><span>' + x[2] + '</span></span></label>'; }).join('') + '</div><div class="note">Стоимость доставки в макете — пример. Оплата не проводится: это демонстрация оформления.</div></section></div>' +
      '<div class="summary"><h3>Ваш заказ</h3><div class="colist">' + items.map(function (it) { return '<div class="coi"><img src="' + D.img[it.p.img] + '" alt=""><span>' + esc(it.p.name) + '</span><b>' + it.q + ' × ' + fmt(it.p.price) + ' ₽</b></div>'; }).join('') + '</div><div class="srow"><span>Товары</span><b>' + fmt(sum) + ' ₽</b></div>' + (promo ? '<div class="srow"><span>Скидка</span><b>−' + fmt(promo) + ' ₽</b></div>' : '') + '<div class="srow"><span>Доставка</span><b>' + (dcost ? fmt(dcost) + ' ₽' : 'бесплатно') + '</b></div><div class="srow total"><span>Итого</span><b>' + fmt(sum - promo + dcost) + ' ₽</b></div><button class="btn btn-y btn-lg btn-full" type="submit">Подтвердить заказ' + ic('arrow-right', 20) + '</button><div class="note">Нажимая «Подтвердить заказ», вы соглашаетесь с условиями <a href="' + link('page', { id: 'offer' }) + '">оферты</a> и <a href="' + link('page', { id: 'privacy' }) + '">политикой обработки персональных данных</a>.</div></div></form></div>';
  }
  function order(pr) {
    var o = S.lastOrder || {};
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Заказ оформлен', '']]) + '<div class="steps"><div class="step done"><i>' + ic('check', 14) + '</i><span>Корзина</span></div><div class="step done"><i>' + ic('check', 14) + '</i><span>Доставка и оплата</span></div><div class="step on"><i>3</i><span>Подтверждение</span></div></div></div>' +
      '<div class="empty big"><div class="okmark">' + ic('check', 34) + '</div><h1>Спасибо! Заказ №' + esc(pr.n || o.n || '—') + ' принят</h1><p>' + (o.name ? esc(o.name) + ', м' : 'М') + 'ы отправили подтверждение ' + (o.email ? 'на ' + esc(o.email) : 'в SMS') + '. Менеджер свяжется с вами в рабочее время, чтобы подтвердить ' + (o.deliv === 'pickup' ? 'время самовывоза' : 'доставку') + '.</p><p class="muted small">Это демонстрация: заказ никуда не отправлен, оплата не проводилась.</p><div class="acts"><a class="btn btn-y" href="' + link('home') + '">На главную</a><a class="btn btn-o" href="' + link('catalog') + '">Продолжить покупки</a></div></div></div>';
  }
  function favorites() {
    var items = D.products.filter(function (p) { return S.fav[p.id]; });
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Избранное', '']]) + '<h1>Избранное <span>' + items.length + ' ' + plural(items.length, 'товар', 'товара', 'товаров') + '</span></h1></div>' +
      (items.length ? '<div class="grid4" style="margin-top:28px">' + items.map(card).join('') + '</div>' : '<div class="empty big"><h3>В избранном пока ничего нет</h3><p>Нажмите на сердечко на карточке товара — он появится здесь.</p><a class="btn btn-o" href="' + link('catalog') + '">В каталог</a></div>') + '</div>';
  }
  function compare() {
    var items = D.products.filter(function (p) { return S.cmp[p.id]; });
    if (!items.length) return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Сравнение', '']]) + '<h1>Сравнение</h1></div><div class="empty big"><h3>Список сравнения пуст</h3><p>Добавьте два-три картриджа кнопкой «Сравнить» на карточке — покажем их характеристики рядом.</p><a class="btn btn-o" href="' + link('catalog') + '">В каталог</a></div></div>';
    var rows = [['Цена', function (p) { return '<b class="price" style="font-size:18px">' + fmt(p.price) + ' ₽</b>'; }], ['Бренд принтера', function (p) { return brandLogo(p.brand, 16, ''); }], ['Ресурс', function (p) { return p.res ? fmt(p.res) + ' стр.' : '—'; }], ['Цвет', function (p) { return p.color || '—'; }], ['Чип', function (p) { return p.chip === true ? 'Есть' : (p.chip === false ? 'Нет' : '—'); }], ['Тип', function (p) { return p.type; }], ['Совместимость', function (p) { return esc(p.compat.replace(/^для\s+/, '')) || '—'; }], ['Рейтинг', function (p) { return stars(p.rate) + ' ' + ratef(p.rate) + ' · ' + p.n; }], ['Наличие', function (p) { return p.stock ? '<span class="avail"><i></i>В наличии</span>' : '<span class="avail out"><i></i>Под заказ</span>'; }]];
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Сравнение', '']]) + '<h1>Сравнение <span>' + items.length + ' ' + plural(items.length, 'товар', 'товара', 'товаров') + '</span></h1></div>' +
      '<div class="cmp-wrap"><table class="cmp"><thead><tr><th></th>' + items.map(function (p) { return '<th><a href="' + link('product', { id: p.id }) + '"><img src="' + D.img[p.img] + '" alt=""><span>' + esc(p.name) + '</span></a><button class="btn btn-y btn-sm" type="button" data-add="' + p.id + '">В корзину</button><button class="rmc" type="button" data-cmp="' + p.id + '">' + ic('close', 14) + 'Убрать</button></th>'; }).join('') + '</tr></thead><tbody>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td>' + items.map(function (p) { return '<td>' + r[1](p) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div></div>';
  }
  function finder(pr) {
    var popular = ['M2135dn', 'M2040dn', 'FS-1040', 'M125', 'M401', 'M104', 'P1102', 'HL-L2300', 'DCP-L2500', 'MF3010', 'LBP6030', 'ML-2160', 'Phaser 3020', 'WorkCentre 3025', 'P2207', 'SP 3400N'];
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Подбор по принтеру', '']]) + '<h1>Подбор расходников по принтеру</h1></div>' +
      '<div class="finder-page"><div class="fp-box"><p>Введите модель принтера или МФУ — покажем все подходящие картриджи, тонеры и чернила Hi-Black.</p><form class="finder" id="finder-form"><select class="fsel" name="brand"><option value="">Бренд принтера</option>' + D.laserBrands.map(function (b) { return '<option value="' + b + '">' + esc(brandName(b)) + '</option>'; }).join('') + '</select><div class="finp"><input type="text" name="q" placeholder="Модель, например M2135dn" autofocus></div><button class="btn btn-y" type="submit">Подобрать</button></form>' +
      '<h3>Популярные модели</h3><div class="tags">' + popular.map(function (m) { return '<a class="chip" href="' + link('catalog', { q: m }) + '">' + esc(m) + '</a>'; }).join('') + '</div></div>' +
      '<div class="fp-side"><h3>Где найти модель принтера</h3><ol><li>На передней панели или крышке — крупная надпись, например <b>ECOSYS M2135dn</b>.</li><li>На наклейке сзади или снизу устройства — строка «Model».</li><li>В настройках печати на компьютере — название принтера в списке устройств.</li></ol><p>Не нашли — напишите нам модель в чат или позвоните: подберём вручную.</p><a class="btn btn-o" href="' + link('page', { id: 'contacts' }) + '">Контакты</a></div></div></div>';
  }
  function login() {
    return '<div class="wrap"><div class="ph1">' + crumbs([['Главная', link('home')], ['Вход', '']]) + '</div><div class="login"><h1>Вход в личный кабинет</h1><p class="muted">История заказов, повторный заказ в один клик, документы для юрлиц.</p><form id="login-form"><label class="fld"><span>Телефон или email</span><input type="text" required placeholder="+7 или name@company.ru"></label><label class="fld"><span>Пароль</span><input type="password" required placeholder="••••••••"></label><button class="btn btn-y btn-lg btn-full" type="submit">Войти</button><div class="lrow"><a href="#">Забыли пароль?</a><a href="#">Регистрация</a></div><p class="muted xs">В макете вход не выполняется — это демонстрация формы.</p></form></div></div>';
  }
  function page(pr) {
    var pg = D.pages.filter(function (x) { return x.id === pr.id; })[0];
    if (!pg) return '<div class="wrap"><div class="empty big"><h3>Страница не найдена</h3><a class="btn btn-o" href="' + link('home') + '">На главную</a></div></div>';
    var body = D.pageText[pg.id] || '';
    if (pg.id === 'lines') body += '<div class="lines">' + D.lines.map(function (l) { return '<div class="line-c"><b>' + esc(l[0]) + '</b><span>' + esc(l[1]) + '</span></div>'; }).join('') + '</div>';
    if (pg.id === 'compat') body += '<div class="cta"><a class="btn btn-y" href="' + link('finder') + '">Подобрать по модели принтера</a></div><div class="tags">' + D.laserBrands.map(function (b) { return '<a class="chip" href="' + link('catalog', { cat: 'laser', brand: b }) + '">' + esc(brandName(b)) + '</a>'; }).join('') + '</div>';
    return '<div class="wrap"><div class="layout" style="padding-top:24px"><aside class="side">' + sideCats('') + sideInfo() + '</aside><div class="content"><div class="ph1" style="padding-top:0">' + crumbs([['Главная', link('home')], [pg.title, '']]) + '<h1>' + esc(pg.title) + '</h1></div><div class="desc page-text">' + body + '</div></div></div></div>';
  }

  var routes = { home: home, catalog: catalog, product: product, cart: cart, checkout: checkout, order: order, favorites: favorites, compare: compare, page: page, finder: finder, login: login };

  // ---------- render & events
  var lastPath = null, lastKey = null;
  function render() {
    var r = parse(), fn = routes[r.path] || home;
    var key = r.path + ':' + (r.params.id || '');
    var keepScroll = (r.path === 'catalog' && lastPath === 'catalog') || (r.path === 'product' && key === lastKey) || (r.path === 'cart' && lastPath === 'cart') || (r.path === 'checkout' && lastPath === 'checkout');
    var y = window.scrollY;
    var sideEl = app.querySelector('.side.open'), sideY = sideEl ? sideEl.scrollTop : 0;
    app.innerHTML = fn(r.params);
    document.title = (r.path === 'home' ? 'Hi-Black — фирменный магазин' : (app.querySelector('h1') ? app.querySelector('h1').textContent.replace(/\s+/g, ' ').trim() + ' — Hi-Black' : 'Hi-Black'));
    document.body.className = 'pg-' + r.path + (r.path === 'catalog' && r.params.f === '1' ? ' noscroll' : '');
    var side2 = app.querySelector('.side.open'); if (side2) side2.scrollTop = sideY;
    document.querySelectorAll('.nav a').forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#catalog?cat=' + (r.params.cat || '')); });
    closeMenu(); closeMob();
    if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
    if (r.path === 'product' && r.params.tab) { var t = document.getElementById('ptabs'); if (t && key !== lastKey) setTimeout(function () { t.scrollIntoView({ block: 'start' }); }, 30); }
    lastPath = r.path; lastKey = key;
    updateHeader();
    initSlider();
    initBuybar();
  }
  window.addEventListener('hashchange', render);

  function showTab(name) { document.querySelectorAll('#ptabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); }); document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== name; }); }
  var toast = document.getElementById('toast'), tt;
  function showToast(html) { toast.innerHTML = html; toast.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { toast.classList.remove('show'); }, 2600); }
  function addToCart(id, q) { S.cart[id] = (S.cart[id] || 0) + (q || 1); save(); updateHeader(); var p = byId(id); showToast(ic('check', 18) + '<span>' + esc(p.name.slice(0, 48)) + '… — в корзине</span> <a href="' + link('cart') + '">Перейти в корзину</a>'); }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-add]');
    if (t) { var q = 1; if (t.dataset.useq) { var pq = document.getElementById('pq'); q = pq ? +pq.textContent || 1 : 1; } addToCart(t.dataset.add, q); var old = t.innerHTML; t.classList.add('added'); t.innerHTML = ic('check', 18) + 'Добавлено'; setTimeout(function () { t.innerHTML = old; t.classList.remove('added'); }, 1400); return; }
    t = e.target.closest('[data-fav]');
    if (t) { e.preventDefault(); var id = t.dataset.fav; S.fav[id] = !S.fav[id]; if (!S.fav[id]) delete S.fav[id]; save(); updateHeader(); document.querySelectorAll('[data-fav="' + id + '"]').forEach(function (b) { b.classList.toggle('on', !!S.fav[id]); if (b.closest('.acts')) b.innerHTML = ic('heart', 16) + (S.fav[id] ? 'В избранном' : 'В избранное'); }); showToast(ic('heart', 18) + (S.fav[id] ? 'Добавлено в избранное' : 'Убрано из избранного') + ' <a href="' + link('favorites') + '">Открыть</a>'); if (parse().path === 'favorites') render(); return; }
    t = e.target.closest('[data-cmp]');
    if (t) { e.preventDefault(); var id2 = t.dataset.cmp; S.cmp[id2] = !S.cmp[id2]; if (!S.cmp[id2]) delete S.cmp[id2]; if (count(S.cmp) > 4) { delete S.cmp[id2]; showToast('В сравнении может быть не больше 4 товаров'); return; } save(); updateHeader(); document.querySelectorAll('[data-cmp="' + id2 + '"]').forEach(function (b) { b.classList.toggle('on', !!S.cmp[id2]); if (b.closest('.acts')) b.innerHTML = ic('compare', 16) + (S.cmp[id2] ? 'В сравнении' : 'В сравнение'); }); showToast(ic('compare', 18) + (S.cmp[id2] ? 'Добавлено к сравнению' : 'Убрано из сравнения') + ' <a href="' + link('compare') + '">Сравнить (' + count(S.cmp) + ')</a>'); if (parse().path === 'compare') render(); return; }
    t = e.target.closest('[data-cq]');
    if (t) { var id3 = t.dataset.cq; S.cart[id3] = Math.max(0, (S.cart[id3] || 0) + (+t.dataset.d)); if (!S.cart[id3]) delete S.cart[id3]; save(); render(); return; }
    t = e.target.closest('[data-rm]');
    if (t) { delete S.cart[t.dataset.rm]; save(); render(); return; }
    t = e.target.closest('[data-clear-cart]');
    if (t) { e.preventDefault(); S.cart = {}; save(); render(); return; }
    t = e.target.closest('[data-fav-all]');
    if (t) { e.preventDefault(); Object.keys(S.cart).forEach(function (id) { S.fav[id] = true; }); save(); updateHeader(); showToast(ic('heart', 18) + 'Товары из корзины добавлены в избранное'); return; }
    t = e.target.closest('[data-q]');
    if (t) { var pq2 = document.getElementById('pq'); pq2.textContent = Math.max(1, (+pq2.textContent || 1) + (+t.dataset.q)); return; }
    t = e.target.closest('[data-tab]');
    if (t) { showTab(t.dataset.tab); return; }
    t = e.target.closest('[data-tab-link]');
    if (t) { e.preventDefault(); showTab(t.dataset.tabLink); document.getElementById('ptabs').scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    t = e.target.closest('[data-scroll]');
    if (t) { var el = document.querySelector(t.dataset.scroll); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    t = e.target.closest('[data-more-rev]');
    if (t) { e.preventDefault(); showToast('В макете показаны три примера отзывов'); return; }
    t = e.target.closest('[data-useful]');
    if (t) { t.classList.add('on'); t.innerHTML = ic('check', 14) + 'Спасибо!'; return; }
    t = e.target.closest('[data-open-f]');
    if (t) { var side = app.querySelector('.side'); if (side) side.classList.add('open'); document.body.classList.add('noscroll'); return; }
    t = e.target.closest('[data-close-f]');
    if (t) { var sideC = app.querySelector('.side'); if (sideC) sideC.classList.remove('open'); document.body.classList.remove('noscroll'); var rc = parse(); if (rc.params.f) { delete rc.params.f; go('catalog', rc.params); } return; }
    t = e.target.closest('.thumb[data-view]');
    if (t) { showView(+t.dataset.view); return; }
    t = e.target.closest('[data-sl]');
    if (t) { slideTo(slideIdx + (+t.dataset.sl)); restartSlider(); return; }
    t = e.target.closest('[data-dot]');
    if (t) { slideTo(+t.dataset.dot); restartSlider(); return; }
    if (e.target.closest('#gmain') && !e.target.closest('.gcompat')) { var g = document.getElementById('gmain'); lb.querySelector('img').src = g.dataset.src; lb.classList.add('open'); return; }
    if (e.target.closest('.thumb.video')) { showToast('Видеообзор — заглушка для макета'); return; }
  });
  // filters: change events
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('[data-f]')) {
      var r = parse(); if (r.path !== 'catalog') return; var p = r.params; var key = t.dataset.f;
      if (t.type === 'checkbox') { if (key === 'stock') { p.stock = t.checked ? '1' : ''; delete p.page; } else toggleIn(p, key, t.value); }
      else { p[key] = t.value; delete p.page; if (key === 'sort' || key === 'pp') delete p.acc; }
      if (app.querySelector('.side.open')) p.f = '1'; else delete p.f;
      go('catalog', p);
    }
    if (t.name === 'biz' || t.name === 'deliv' || t.name === 'pay') { var f = document.getElementById('co-form'); if (f) { S.co = Object.assign(S.co || {}, formData(f)); save(); render(); } }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMenu(); closeMob(); lb.classList.remove('open'); }
    if (e.key === 'Enter' && e.target.matches('[data-f]') && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  function formData(f) { var o = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) { if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; } else o[el.name] = el.value; } }); return o; }
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.id === 'finder-form') { e.preventDefault(); var d = formData(f); if (d.q) go('catalog', { q: d.q.trim(), brand: '' }); else if (d.brand) go('catalog', { cat: 'laser', brand: d.brand }); else go('finder'); return; }
    if (f.id === 'search-form') { e.preventDefault(); var q = f.querySelector('input').value.trim(); go('catalog', { q: q }); return; }
    if (f.id === 'promo-form') { e.preventDefault(); var code = f.promo.value.trim().toUpperCase(); if (code === 'HIBLACK5') { S.promo = code; S.promoErr = false; } else { S.promo = ''; S.promoErr = !!code; } save(); render(); return; }
    if (f.id === 'co-form') { e.preventDefault(); var d2 = formData(f); S.co = d2; var n = 10240 + (S.orders = (S.orders || 0) + 1); S.lastOrder = { n: n, name: d2.name, email: d2.email, deliv: d2.deliv }; S.cart = {}; S.promo = ''; save(); go('order', { n: n }); return; }
    if (f.id === 'rev-form') { e.preventDefault(); f.innerHTML = '<h3>Спасибо за отзыв!</h3><p>Он появится на странице после проверки модератором.</p>'; return; }
    if (f.id === 'login-form') { e.preventDefault(); showToast('В макете вход не выполняется'); return; }
  });
  // catalog menu
  var btn = document.getElementById('catbtn'), menu = document.getElementById('catmenu');
  function closeMenu() { if (menu) { menu.classList.remove('open'); btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } }
  btn.addEventListener('click', function (e) { e.stopPropagation(); var o = menu.classList.toggle('open'); btn.classList.toggle('open', o); btn.setAttribute('aria-expanded', o ? 'true' : 'false'); });
  document.addEventListener('click', function (e) { if (menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); });
  var lb = document.getElementById('lightbox');
  lb.addEventListener('click', function () { lb.classList.remove('open'); });
  function showView(i) {
    var g = document.getElementById('gmain'); if (!g) return;
    var thumbs = app.querySelectorAll('.thumb[data-view]'); var th = thumbs[i]; if (!th) return;
    thumbs.forEach(function (x) { x.classList.toggle('on', x === th); });
    var tz = th.querySelector('.tz'), img = g.querySelector('[data-gview="img"]'), zoom = g.querySelector('[data-gview="zoom"]'), comp = g.querySelector('[data-gview="compat"]');
    var kind = th.classList.contains('tcompat') ? 'compat' : (tz ? 'zoom' : 'img');
    img.hidden = kind !== 'img'; zoom.hidden = kind !== 'zoom'; if (comp) comp.hidden = kind !== 'compat';
    if (kind === 'zoom') zoom.style.backgroundPosition = tz.style.backgroundPosition;
    g.querySelector('.zoom').hidden = kind === 'compat';
  }
  /* slider */
  var slideIdx = 0, sliderTimer = null;
  function slideTo(i) {
    var sl = document.getElementById('slider'); if (!sl) return;
    var slides = sl.querySelectorAll('.slide'), n = slides.length; slideIdx = (i + n) % n;
    slides.forEach(function (x, k) { x.classList.toggle('on', k === slideIdx); });
    sl.querySelectorAll('[data-dot]').forEach(function (d, k) { d.classList.toggle('on', k === slideIdx); });
    var ctrl = sl.querySelector('.sctrl'); if (ctrl) ctrl.classList.toggle('dark', slideIdx !== 0);
  }
  function restartSlider() { clearInterval(sliderTimer); sliderTimer = null; if (document.getElementById('slider')) sliderTimer = setInterval(function () { if (document.hidden) return; slideTo(slideIdx + 1); }, 6500); }
  function initSlider() {
    var sl = document.getElementById('slider'); clearInterval(sliderTimer); sliderTimer = null; slideIdx = 0; if (!sl) return;
    restartSlider();
    sl.addEventListener('mouseenter', function () { clearInterval(sliderTimer); sliderTimer = null; });
    sl.addEventListener('mouseleave', restartSlider);
    var x0 = null;
    sl.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    sl.addEventListener('touchend', function (e) { if (x0 == null) return; var dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) { slideTo(slideIdx + (dx < 0 ? 1 : -1)); restartSlider(); } x0 = null; });
  }
  /* мобильное меню */
  var mob = document.getElementById('mobmenu'), mobbtn = document.getElementById('mobbtn');
  function openMob() { mob.classList.add('open'); mob.setAttribute('aria-hidden', 'false'); mobbtn.setAttribute('aria-expanded', 'true'); document.body.classList.add('noscroll'); }
  function closeMob() { if (!mob || !mob.classList.contains('open')) return; mob.classList.remove('open'); mob.setAttribute('aria-hidden', 'true'); mobbtn.setAttribute('aria-expanded', 'false'); document.body.classList.remove('noscroll'); }
  mobbtn.addEventListener('click', function () { if (mob.classList.contains('open')) closeMob(); else openMob(); });
  mob.addEventListener('click', function (e) { if (e.target.closest('a') || e.target.closest('[data-mm-close]')) closeMob(); });
  /* липкая панель «В корзину» на карточке товара (мобильные) */
  var bbObs = null;
  function initBuybar() {
    if (bbObs) { bbObs.disconnect(); bbObs = null; }
    var bar = document.getElementById('buybar'), buy = app.querySelector('.buy');
    if (!bar || !buy || !('IntersectionObserver' in window)) return;
    bbObs = new IntersectionObserver(function (en) { var x = en[0]; bar.classList.toggle('show', !x.isIntersecting && x.boundingClientRect.top < 0); }, { threshold: 0 });
    bbObs.observe(buy);
  }
  /* на телефонах длинная подсказка в поиске не помещается */
  var sInp = document.querySelector('#search-form input');
  if (sInp && window.matchMedia('(max-width:640px)').matches) sInp.placeholder = 'Модель принтера или артикул';
  render();
})();
