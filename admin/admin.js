/*
  Админка: модерация отзывов.

  Отдельный маленький скрипт, а не витрина: каталог на три с половиной
  тысячи позиций здесь незачем, а ломаться от правок дизайна магазина
  админка не должна.

  Все изменяющие запросы несут CSRF-токен сессии. Токен приходит при
  входе и живёт только в памяти вкладки: в localStorage его класть
  нельзя — оттуда его достанет любой скрипт, попавший на страницу.
*/
(function () {
  'use strict';

  var csrf = null;
  var status = 'pending';
  var busy = false;

  var msg = document.getElementById('msg');
  var loginView = document.getElementById('login-view');
  var listView = document.getElementById('list-view');
  var listEl = document.getElementById('list');
  var logoutBtn = document.getElementById('logout');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function say(text, kind) {
    if (!text) { msg.hidden = true; return; }
    msg.textContent = text;
    msg.className = 'msg ' + (kind || 'ok');
    msg.hidden = false;
  }

  /* Ответ сервера всегда JSON; сетевую ошибку и HTML от прокси тоже надо
     показать человеком, а не «[object Object]». */
  function api(path, options) {
    var opts = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    return fetch('/api/admin/' + path, {
      method: opts.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.text().then(function (raw) {
        var data;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!data) throw new Error('Сервер ответил не по формату (' + r.status + ')');
        if (!r.ok || data.ok === false) throw new Error(data.error || 'Ошибка ' + r.status);
        return data;
      });
    });
  }

  function show(view) {
    loginView.hidden = view !== 'login';
    listView.hidden = view !== 'list';
    logoutBtn.hidden = view !== 'list';
  }

  function stars(n) {
    var out = '';
    for (var i = 1; i <= 5; i++) out += i <= n ? '★' : '☆';
    return out;
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return String(d.getDate()).padStart(2, '0') + '.' +
      String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear() + ', ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  var LABEL = { pending: 'На модерации', approved: 'Опубликован', rejected: 'Отклонён' };
  var PILL = { approved: 'ok', rejected: 'no', pending: '' };

  function card(rv) {
    var acts = [];
    if (rv.status !== 'approved') acts.push('<button class="btn btn-ok" data-do="approve">Опубликовать</button>');
    if (rv.status !== 'rejected') acts.push('<button class="btn btn-no" data-do="reject">Отклонить</button>');
    if (rv.status !== 'pending') acts.push('<button class="btn" data-do="pending">Вернуть на модерацию</button>');
    acts.push('<button class="btn" data-do="verify">' +
      (rv.verified ? 'Снять «покупка подтверждена»' : 'Покупка подтверждена') + '</button>');
    acts.push('<button class="btn" data-do="reply">' + (rv.reply ? 'Изменить ответ' : 'Ответить') + '</button>');

    return '<article class="card" data-file="' + esc(rv.file) + '">' +
      '<div class="rv-head">' +
        '<b>' + esc(rv.name || 'Покупатель') + '</b>' +
        '<span class="stars" aria-label="Оценка ' + rv.rate + ' из 5">' + stars(rv.rate) + '</span>' +
        '<span class="pill ' + (PILL[rv.status] || '') + '">' + esc(LABEL[rv.status] || rv.status) + '</span>' +
        (rv.verified ? '<span class="pill ok">Покупка подтверждена</span>' : '') +
      '</div>' +
      '<div class="meta">' +
        '<span>' + esc(when(rv.createdAt)) + '</span>' +
        '<span>Товар: <code>' + esc(rv.product) + '</code></span>' +
        (rv.email ? '<span>Почта: <a href="mailto:' + esc(rv.email) + '">' + esc(rv.email) + '</a></span>' : '') +
        (rv.printer ? '<span>Принтер: ' + esc(rv.printer) + '</span>' : '') +
      '</div>' +
      '<p class="text">' + esc(rv.text) + '</p>' +
      (rv.reply ? '<div class="reply"><b>Ответ магазина</b>' + esc(rv.reply) + '</div>' : '') +
      (rv.moderatorNote ? '<p class="note">Причина: ' + esc(rv.moderatorNote) + '</p>' : '') +
      '<div class="acts">' + acts.join('') + '</div>' +
      '<a class="note" style="display:block;margin-top:10px" href="/product/' + esc(rv.product) +
        '" target="_blank" rel="noopener">Открыть товар на сайте</a>' +
    '</article>';
  }

  function load() {
    listEl.innerHTML = '<div class="empty">Загружаем…</div>';
    return api('reviews?status=' + encodeURIComponent(status)).then(function (data) {
      var c = data.counts || {};
      ['pending', 'approved', 'rejected'].forEach(function (k) {
        var el = document.querySelector('[data-n="' + k + '"]');
        if (el) el.textContent = c[k] ? ' ' + c[k] : '';
      });
      if (!data.reviews.length) {
        listEl.innerHTML = '<div class="empty">' +
          (status === 'pending' ? 'Непрочитанных отзывов нет.' : 'Здесь пока пусто.') + '</div>';
        return;
      }
      listEl.innerHTML = data.reviews.map(card).join('');
    }).catch(function (e) {
      if (/вход/i.test(e.message)) { csrf = null; show('login'); return; }
      listEl.innerHTML = '';
      say(e.message, 'err');
    });
  }

  /* Одно решение за раз: два одновременных запроса переписали бы
     live/reviews.json с разной картиной очереди. */
  function act(file, action, extra) {
    if (busy) return;
    busy = true;
    say('');
    api('review', { method: 'POST', body: Object.assign({ file: file, action: action }, extra || {}) })
      .then(function (r) {
        say(action === 'approve' ? 'Опубликован. На сайте уже виден — всего отзывов: ' + r.published + '.'
          : action === 'reject' ? 'Отклонён. На сайте его нет.'
          : 'Сохранено.', 'ok');
        return load();
      })
      .catch(function (e) {
        if (/вход|сесси/i.test(e.message)) { csrf = null; show('login'); }
        say(e.message, 'err');
      })
      .then(function () { busy = false; });
  }

  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('pw');
    var btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    say('');
    api('login', { method: 'POST', body: { password: input.value } })
      .then(function (r) {
        csrf = r.csrf;
        input.value = '';
        show('list');
        return load();
      })
      .catch(function (err) { say(err.message, 'err'); })
      .then(function () { btn.disabled = false; });
  });

  logoutBtn.addEventListener('click', function () {
    api('logout', { method: 'POST' }).catch(function () { /* всё равно выходим */ })
      .then(function () { csrf = null; say(''); show('login'); });
  });

  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-status]');
    if (!b) return;
    status = b.dataset.status;
    [].forEach.call(this.querySelectorAll('button'), function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    load();
  });

  listEl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-do]');
    if (!b) return;
    var art = b.closest('[data-file]');
    if (!art) return;
    var file = art.dataset.file;
    var action = b.dataset.do;
    if (action === 'reject') {
      var note = prompt('Причина отклонения (необязательно, видна только вам):', '');
      if (note === null) return;
      return act(file, 'reject', { note: note });
    }
    if (action === 'reply') {
      var current = (art.querySelector('.reply') || {}).textContent || '';
      var text = prompt('Ответ магазина (пусто — убрать ответ):',
        current.replace(/^Ответ магазина/, '').trim());
      if (text === null) return;
      return act(file, 'reply', { text: text });
    }
    if (action === 'verify') {
      return act(file, 'verify', { value: !/Снять/.test(b.textContent) });
    }
    act(file, action);
  });

  /* Сессия могла остаться с прошлого захода: cookie живёт 12 часов. */
  api('session').then(function (r) {
    if (r.ok && r.csrf) { csrf = r.csrf; show('list'); return load(); }
    show('login');
  }).catch(function () { show('login'); });
})();
