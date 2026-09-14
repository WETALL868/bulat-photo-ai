#!/usr/bin/env node
/*
  Проверка карточки товара в настоящем браузере.

  Зачем отдельно от юнит-тестов. Три дефекта из этой правки — выбор цвета,
  переключение вкладки и форма отзыва — живут ровно там, где юнит-тест
  ничего не видит: в отрисованной странице и в обработчиках нажатий.
  «Все характеристики» вызывала showTab('desc') и формально работала;
  сломанной она была только для человека, который нажал и остался на
  описании. Такое ловится кликом, а не проверкой строки.

  Проверяется на настоящем адресе, поднятом тем же dev-сервером, который
  повторяет правила боевого .htaccess, — и на десктопе, и на телефоне.

  Запуск: node tools/test-ui.mjs [--slug=hb-tk-8115c] [--port=8098]
*/
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
/*
  Адреса товаров берутся из реестра, а не пишутся в тесте руками.

  У товара есть идентификатор (hb-tk-8115bk) и выданный ему ЧПУ
  (toner-kartridzh-hi-black-hb-tk-8115bk-kyocera). Витрина понимает оба,
  а предрендер и sitemap знают только второй. Тест обязан ходить туда же,
  куда пойдёт поисковик и покупатель по ссылке, поэтому идентификатор
  здесь разворачивается в действующий адрес.
*/
const slugRegistry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/product-slugs.json'), 'utf8')).items;
const prod = (id) => (slugRegistry[id] ? slugRegistry[id].slug : id);
const SLUG = prod(arg('slug', 'hb-tk-8115c-4100603161'));
const PORT = Number(arg('port', 8098));
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${note ? ' — ' + note : ''}`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { /* уже закрыт */ } };
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch();

/* Одна и та же проверка прогоняется на двух ширинах: липкая шапка и
   складывающаяся сетка на телефоне — как раз то место, где «работает на
   десктопе» ничего не означает. */
for (const device of [
  { name: 'десктоп', viewport: { width: 1440, height: 900 } },
  { name: 'телефон', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  const ctx = await browser.newContext({ viewport: device.viewport, hasTouch: device.hasTouch });
  const page = await ctx.newPage();
  const url = `${BASE}/product/${SLUG}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#ptabs', { timeout: 15000 });

  /* ---------- «Все характеристики» ---------- */
  const panelOpen = () => page.evaluate(() => {
    const on = document.querySelector('#ptabs button.on');
    const vis = [...document.querySelectorAll('[data-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.panel);
    return { tab: on && on.dataset.tab, visible: vis };
  });
  check(`${device.name}: по умолчанию открыто описание`, (await panelOpen()).tab === 'desc');
  await page.locator('.allspecs').click();
  let st = await panelOpen();
  check(`${device.name}: «Все характеристики» открывает вкладку характеристик`,
    st.tab === 'specs' && st.visible.length === 1 && st.visible[0] === 'specs', JSON.stringify(st));
  check(`${device.name}: адрес запомнил вкладку`, page.url().includes('tab=specs'), page.url());
  /* Прокрутка плавная и потому асинхронная: сразу после нажатия
     window.scrollY ещё нулевой. Ждём, пока она доедет. */
  const scrolled = await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 5000 })
    .then(() => true).catch(() => false);
  check(`${device.name}: страница прокручена к характеристикам`, scrolled);
  const rows = await page.locator('[data-panel="specs"] .sr').count();
  check(`${device.name}: характеристики не пустые`, rows > 3, `строк ${rows}`);

  /* Обновление страницы — вкладка та же. */
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#ptabs');
  st = await panelOpen();
  check(`${device.name}: после обновления открыта та же вкладка`, st.tab === 'specs', JSON.stringify(st));

  /* С клавиатуры: фокус на ссылке и Enter. */
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.allspecs');
  await page.locator('.allspecs').focus();
  check(`${device.name}: ссылка получает фокус с клавиатуры`,
    await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('allspecs')));
  await page.keyboard.press('Enter');
  st = await panelOpen();
  check(`${device.name}: Enter на ссылке открывает характеристики`, st.tab === 'specs', JSON.stringify(st));

  /* Кнопка вкладки продолжает работать и тоже пишет адрес. */
  await page.locator('#ptabs button[data-tab="reviews"]').click();
  st = await panelOpen();
  check(`${device.name}: кнопка вкладки «Отзывы» работает`, st.tab === 'reviews');
  check(`${device.name}: вкладка отзывов попала в адрес`, page.url().includes('tab=reviews'));

  /* ---------- строка поиска и возврат домой ---------- */
  /*
    Найденный дефект: набрал «300972», открыл выдачу, нажал логотип —
    главная открылась, а в поле поиска по-прежнему стоит «300972».
    Дальше человек уходит в каталог с этим текстом в поле и не понимает,
    почему поиск «не сработал».
  */
  const boxValue = () => page.evaluate(() => {
    const el = document.querySelector('#search-form input[name=q]');
    return el ? el.value : null;
  });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.fill('#search-form input[name=q]', '300972');
  await page.press('#search-form input[name=q]', 'Enter');
  await page.waitForURL('**/search?q=300972', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(900);
  check(`${device.name}: поиск открыл выдачу`, page.url().includes('q=300972'), page.url());
  check(`${device.name}: в выдаче поле показывает запрос`, (await boxValue()) === '300972', String(await boxValue()));

  await page.locator('.logo, a.logo, .hdr a[href="/"]').first().click();
  await page.waitForTimeout(900);
  check(`${device.name}: логотип открывает главную`, new URL(page.url()).pathname === '/', page.url());
  check(`${device.name}: строка поиска очистилась`, (await boxValue()) === '', `осталось «${await boxValue()}»`);

  /* Назад — снова выдача, и запрос снова в поле. */
  await page.goBack({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check(`${device.name}: «назад» вернуло запрос в поле`, (await boxValue()) === '300972', String(await boxValue()));
  await page.goForward({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check(`${device.name}: «вперёд» снова очистило поле`, (await boxValue()) === '', String(await boxValue()));

  /* Переход в раздел каталога устаревший запрос тоже не оставляет. */
  await page.goto(`${BASE}/search?q=300972`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.goto(`${BASE}/catalog/laser`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check(`${device.name}: в разделе каталога поле пустое`, (await boxValue()) === '', String(await boxValue()));

  /* Служебной отметки об обновлении цен на витрине больше нет. */
  for (const where of ['/', '/search?q=300972', '/catalog/laser']) {
    await page.goto(`${BASE}${where}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const txt = await page.locator('#app').innerText();
    check(`${device.name}: нет отметки об обновлении цен (${where})`, !/Цены и наличие обновлены/i.test(txt));
  }

  /* ---------- цвета серии: один блок, свои кнопки ---------- */
  await page.goto(`${BASE}/product/${prod('hb-tk-8115bk')}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.vars');
  const vars = await page.evaluate(() => ({
    top: document.querySelectorAll('.cpick').length,
    blocks: document.querySelectorAll('.vars').length,
    tiles: document.querySelectorAll('.var').length,
    buttons: document.querySelectorAll('.var [data-add]').length,
    current: document.querySelectorAll('.var.on').length,
    text: document.querySelector('.vars').innerText,
  }));
  check(`${device.name}: верхнего дубликата цветов нет`, vars.top === 0, `найдено ${vars.top}`);
  check(`${device.name}: блок цветов ровно один`, vars.blocks === 1, `найдено ${vars.blocks}`);
  check(`${device.name}: четыре плитки цветов`, vars.tiles === 4, `найдено ${vars.tiles}`);
  check(`${device.name}: у каждой плитки своя кнопка в корзину`, vars.buttons === 4, `найдено ${vars.buttons}`);
  check(`${device.name}: текущий цвет отмечен`, vars.current === 1);
  check(`${device.name}: остатков в штуках в плитках нет`, !/\d+\s*шт\.?(?!\/)/.test(vars.text));

  /* Кнопка плитки кладёт в корзину именно свой цвет. */
  const cartN = () => page.evaluate(() => Number(document.getElementById('cart-n').textContent) || 0);
  const before = await cartN();
  const tileBtn = page.locator('.var:not(.on) [data-add]').first();
  const tileId = await tileBtn.getAttribute('data-add');
  await tileBtn.click();
  await page.waitForTimeout(400);
  check(`${device.name}: кнопка плитки добавила товар`, (await cartN()) === before + 1, `было ${before}, стало ${await cartN()}`);
  const inCart = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('hb-shop')).cart; } catch (e) { return {}; } });
  check(`${device.name}: в корзину попал именно этот цвет`, !!inCart[tileId], `${tileId} → ${JSON.stringify(inCart)}`);

  /* Основная кнопка и липкая панель продолжают работать. */
  const mainBefore = await cartN();
  await page.locator('.buy [data-add]').first().click();
  await page.waitForTimeout(400);
  check(`${device.name}: основная кнопка «В корзину» работает`, (await cartN()) > mainBefore);
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(700);
  const barOn = await page.evaluate(() => {
    const b = document.getElementById('buybar');
    return !!b && getComputedStyle(b).visibility !== 'hidden';
  });
  check(`${device.name}: липкая панель покупки появляется`, barOn);

  /* ---------- характеристики без складских количеств ---------- */
  await page.goto(`${BASE}/product/${prod('hb-tk-8115bk')}?tab=specs`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="specs"]');
  const specText = await page.locator('[data-panel="specs"]').innerText();
  check(`${device.name}: в характеристиках нет остатков со склада`,
    !/на складе, шт|в пути, шт|центральном складе/i.test(specText));
  check(`${device.name}: полезные характеристики на месте`,
    /Вес одной штуки/.test(specText) && /Вес упаковки/.test(specText) && /Ресурс/.test(specText));

  /* Все три вкладки переключаются и открывают именно себя. */
  for (const [tab, marker] of [['desc', 'desc'], ['specs', 'specs'], ['reviews', 'reviews']]) {
    await page.locator(`#ptabs button[data-tab="${tab}"]`).click();
    await page.waitForTimeout(250);
    const open = await page.evaluate(() => [...document.querySelectorAll('[data-panel]')]
      .filter((el) => !el.hidden).map((el) => el.dataset.panel));
    check(`${device.name}: вкладка ${tab} открывает свою панель`, open.length === 1 && open[0] === marker, JSON.stringify(open));
  }

  /* ---------- код товара и поиск по нему ---------- */
  /*
    Код товара покупатель запоминает и называет по телефону. Он не имеет
    права меняться от того, что с витрины убрали другие позиции: в
    прошлой публикации HB-TK-8115C уехал с 670235 на 686396, и поиск по
    известному номеру перестал что-либо находить.
  */
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pmeta');
  const meta = await page.locator('.pmeta').innerText();
  check(`${device.name}: код товара на карточке — 670235`, /670235/.test(meta), meta.replace(/\n/g, ' '));

  await page.goto(`${BASE}/search?q=670235`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const found = await page.locator('.card a.cname, .card .cname, .card h3').allInnerTexts().catch(() => []);
  const foundText = await page.locator('#app').innerText();
  check(`${device.name}: поиск по 670235 находит товар`,
    /HB-TK-8115C/i.test(foundText), (found[0] || foundText.split('\n').slice(0, 3).join(' | ')).slice(0, 80));

  /* Адрес удалённой повреждённой позиции не должен показывать чужой
     товар. Адрес здесь записан буквально: он никому не выдан, и в
     реестре его нет — подставлять его через prod() значило бы открыть
     живую карточку и проверить не то. */
  await page.goto(`${BASE}/product/hb-tk-8115c`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const gone = await page.locator('#app').innerText();
  check(`${device.name}: адрес удалённой упаковки не занят другим товаром`,
    /не найдена/i.test(gone), gone.split('\n')[0]);

  await page.goto(`${BASE}/product/${SLUG}?tab=reviews`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#ptabs');

  /* ---------- отзывы ---------- */
  const honest = await page.locator('[data-panel="reviews"]').innerText();
  /* Настоящих отзывов у товара нет, и вкладка обязана это сказать —
     либо пустым состоянием, либо пометкой над лентой примеров. */
  check(`${device.name}: вкладка не выдаёт примеры за отзывы покупателей`,
    /Отзывов пока нет/.test(honest) || /вымышленных примеров, не отзывов покупателей/.test(honest),
    honest.split('\n')[0]);
  check(`${device.name}: нет выдуманных отзывов`, !/Покупка подтверждена/.test(honest));
  const headNone = await page.locator('.pmeta').innerText();
  check(`${device.name}: в шапке не стоит оценка 0,0`, !/0,0/.test(headNone), headNone.replace(/\n/g, ' '));

  /*
    Поле e-mail. Под формой стояло «Ваш email не публикуется», а самого
    поля не было — обещание относилось к тому, чего форма не спрашивала.
  */
  const fields = await page.evaluate(() => ({
    email: !!document.querySelector('#rev-form input[name=email][type=email]'),
    labels: [...document.querySelectorAll('#rev-form .flabel')].map((e) => e.textContent.trim()),
    note: (document.querySelector('#rev-email-note') || {}).textContent || '',
    overlap: (() => {
      const r = [...document.querySelectorAll('#rev-form .rfield')].map((e) => e.getBoundingClientRect());
      let bad = 0;
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
        if (r[i].left < r[j].right - 1 && r[j].left < r[i].right - 1
          && r[i].top < r[j].bottom - 1 && r[j].top < r[i].bottom - 1) bad += 1;
      }
      return bad;
    })(),
  }));
  check(`${device.name}: в форме есть поле e-mail`, fields.email);
  check(`${device.name}: у полей формы есть постоянные подписи`, fields.labels.length >= 4, fields.labels.join(' | '));
  check(`${device.name}: поля формы не накладываются`, fields.overlap === 0, `перекрытий ${fields.overlap}`);
  check(`${device.name}: подпись под формой говорит про e-mail честно`,
    /не публикуется/.test(fields.note) && /модератор/i.test(fields.note), fields.note.slice(0, 80));

  /*
    Оценка не выбрана заранее: отправить отзыв, не поставив её, нельзя, а
    пятёрка «по умолчанию» превращала нетронутый переключатель в мнение.
  */
  const preselected = await page.locator('#rev-form input[name=rate]:checked').count();
  check(`${device.name}: оценка заранее не выбрана`, preselected === 0, `отмечено ${preselected}`);

  /* Форма не пишет «Спасибо», не отправив ничего. */
  await page.locator('#rev-form button[type=submit]').click();
  let msg = (await page.locator('#rev-msg').innerText().catch(() => '')).trim();
  check(`${device.name}: без оценки отзыв не принимается`, /оценку от 1 до 5/i.test(msg), msg);
  const marked = await page.locator('#rev-rate.bad').count();
  check(`${device.name}: пропущенная оценка подсвечена на самом поле`, marked === 1);

  await page.locator('#rev-form input[name=rate][value="4"]').click();
  const picked = await page.locator('#rev-form input[name=rate]:checked').getAttribute('value');
  check(`${device.name}: оценка выбирается нажатием`, picked === '4', `выбрано ${picked}`);
  /* Исправленное поле не должно продолжать выглядеть сломанным. */
  const stillBad = await page.locator('#rev-rate.bad').count();
  const msgGone = await page.locator('#rev-msg').isHidden();
  check(`${device.name}: после выбора оценки подсветка ошибки уходит`, stillBad === 0 && msgGone,
    `подсвечено ${stillBad}, сообщение скрыто ${msgGone}`);

  await page.locator('#rev-form button[type=submit]').click();
  msg = (await page.locator('#rev-msg').innerText()).trim();
  check(`${device.name}: пустая форма не принимается`, /имя/i.test(msg), msg);
  await page.fill('#rev-form input[name=name]', 'Проверка');
  await page.fill('#rev-form textarea', 'Коротко');
  await page.locator('#rev-form button[type=submit]').click();
  msg = (await page.locator('#rev-msg').innerText()).trim();
  check(`${device.name}: без e-mail отзыв не принимается`, /e-?mail/i.test(msg), msg);
  await page.fill('#rev-form input[name=email]', 'не-почта');
  await page.locator('#rev-form button[type=submit]').click();
  msg = (await page.locator('#rev-msg').innerText()).trim();
  check(`${device.name}: неверный e-mail не принимается`, /e-?mail/i.test(msg), msg);
  await page.fill('#rev-form input[name=email]', 'buyer@example.ru');
  await page.locator('#rev-form button[type=submit]').click();
  msg = (await page.locator('#rev-msg').innerText()).trim();
  check(`${device.name}: слишком короткий текст не принимается`, /пару предложений/i.test(msg), msg);
  await page.fill('#rev-form textarea', 'Проверочная отправка формы отзыва из автотеста, текст достаточной длины.');
  await page.locator('#rev-form button[type=submit]').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('rev-msg');
    return el && !el.hidden && /проверку|не удалось|превью/i.test(el.textContent);
  }, null, { timeout: 10000 });
  msg = (await page.locator('#rev-msg').innerText()).trim();
  check(`${device.name}: форма сообщает результат отправки, а не «Спасибо»`, !/^Спасибо/.test(msg), msg);
  /* После удачной отправки форма снова пустая — в том числе оценка. */
  const afterSend = await page.locator('#rev-form input[name=rate]:checked').count();
  check(`${device.name}: после отправки оценка снова не выбрана`, afterSend === 0, `отмечено ${afterSend}`);

  /*
    Серверная проверка оценки — отдельно от формы: клиентскую обходит
    кто угодно, а отзыв без оценки в очереди модерации не отличить от
    того, у которого её потеряли по дороге.
  */
  const srv = await page.evaluate(async () => {
    const post = (body) => fetch('/api/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.status);
    const base = { product: 'hb-tk-8115bk', name: 'Проверка', email: 'buyer@example.ru',
      text: 'Обход клиентской проверки: запрос отправлен напрямую, минуя форму отзыва.' };
    return {
      none: await post(base),
      zero: await post({ ...base, rate: 0, text: base.text + ' Без оценки.' }),
      over: await post({ ...base, rate: 9, text: base.text + ' Оценка вне диапазона.' }),
      good: await post({ ...base, rate: 4, text: base.text + ' С оценкой.' }),
    };
  });
  check(`${device.name}: сервер не принимает отзыв без оценки`, srv.none === 422, `код ${srv.none}`);
  check(`${device.name}: сервер не принимает оценку 0`, srv.zero === 422, `код ${srv.zero}`);
  check(`${device.name}: сервер не принимает оценку вне 1–5`, srv.over === 422, `код ${srv.over}`);
  check(`${device.name}: сервер принимает отзыв с оценкой`, srv.good === 200, `код ${srv.good}`);

  await ctx.close();
}

/*
  «Все характеристики»: один клик — одна реакция.

  Дефект был в двойной обработке. Ссылка вкладки — обычный <a> на
  ?tab=specs, и её ловили два слушателя: маршрутизатор ссылок (объявлен
  раньше) начинал переход с перерисовкой #app, а обработчик вкладок
  переключал вкладку и запускал плавную прокрутку. Кто победит, решала
  гонка: успеет перерисовка до конца прокрутки — человек останется у
  характеристик, не успеет — страницу вернёт к началу. Второе нажатие
  «работало» только потому, что адрес уже совпадал с текущим и переход
  не начинался.

  Поэтому проверяем не «докрутилось ли», а причину: на первом клике не
  должно быть ни pushState, ни перерисовки #app, а вкладки обязаны
  оказаться вверху экрана.
*/
for (const [dev, vp] of [['десктоп', { width: 1440, height: 900 }], ['телефон', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  for (const slug of ['hb-tk-5230bk', 'hb-tk-8115c-4100603161'].map(prod)) {
    /* Заходим с каталога: тогда «назад» ведёт на осмысленную страницу. */
    await page.goto(`${BASE}/catalog/laser`, { waitUntil: 'networkidle' });
    await page.goto(`${BASE}/product/${slug}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.allspecs', { timeout: 15000 });

    await page.evaluate(() => {
      window.__nav = { push: 0, render: 0 };
      const ps = history.pushState.bind(history);
      history.pushState = (...a) => { window.__nav.push += 1; return ps(...a); };
      new MutationObserver(() => { window.__nav.render += 1; })
        .observe(document.getElementById('app'), { childList: true });
    });

    await page.locator('.allspecs').click();
    await page.waitForTimeout(1500);
    const one = await page.evaluate(() => {
      const t = document.getElementById('ptabs');
      return { ...window.__nav, y: Math.round(window.scrollY),
        tabsTop: t ? Math.round(t.getBoundingClientRect().top) : null,
        tab: document.querySelector('#ptabs button.on')?.dataset.tab,
        panel: [...document.querySelectorAll('[data-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.panel).join(','),
        url: location.pathname + location.search };
    });
    check(`${dev} ${slug}: первый клик открывает характеристики`,
      one.tab === 'specs' && one.panel === 'specs', `вкладка ${one.tab}, панель ${one.panel}`);
    check(`${dev} ${slug}: первый клик не затевает переход и перерисовку`,
      one.push === 0 && one.render === 0, `pushState ${one.push}, перерисовок ${one.render}`);
    /* Вкладки у верхней кромки: небольшой допуск на липкую шапку. */
    check(`${dev} ${slug}: прокрутка осталась у характеристик`,
      one.y > 0 && one.tabsTop !== null && Math.abs(one.tabsTop) <= 120,
      `scrollY ${one.y}, вкладки в ${one.tabsTop} px от верха`);
    check(`${dev} ${slug}: адрес содержит ?tab=specs`, /\?tab=specs$/.test(one.url), one.url);

    /* Повторное нажатие ничего не ломает и никуда не уводит. */
    await page.locator('.allspecs').click();
    await page.waitForTimeout(1200);
    const two = await page.evaluate(() => {
      const t = document.getElementById('ptabs');
      return { ...window.__nav, tabsTop: t ? Math.round(t.getBoundingClientRect().top) : null,
        tab: document.querySelector('#ptabs button.on')?.dataset.tab,
        url: location.pathname + location.search };
    });
    check(`${dev} ${slug}: повторный клик ведёт себя так же`,
      two.tab === 'specs' && two.push === 0 && two.render === 0 && Math.abs(two.tabsTop) <= 120,
      `pushState ${two.push}, перерисовок ${two.render}, вкладки в ${two.tabsTop} px`);

    /* «Назад» уводит на предыдущую страницу, а не на переключение вкладки:
       showTab правит адрес через replaceState и историю не засоряет. */
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const back = await page.evaluate(() => location.pathname + location.search);
    check(`${dev} ${slug}: «назад» возвращает на каталог`, /\/catalog\/laser$/.test(back), back);
  }
  await ctx.close();
}

/*
  Основное фото карточки: источник, увеличение и доступность.

  Проверка появилась после того, как снимок 300972 оказался заметно
  мыльным: ячейка атласа 240 пикселей растягивалась правилом CSS на 520,
  то есть в 2,2 раза. Ни «шарпом», ни апскейлом подробностей в источнике
  не прибавится, поэтому проверяем ровно две вещи: снимок не растянут
  сверх исходника и увеличение открывается — мышью и с клавиатуры.
*/
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  for (const slug of ['hb-tk-8115bk', 'hb-paper-mat2s-a4-160g-m-100l', 'hb-tk-1150', 'hb-servm-isopr-hl-spr-250ml'].map(prod)) {
    await page.goto(`${BASE}/product/${slug}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#gmain', { timeout: 15000 });
    const info = await page.evaluate(() => {
      const g = document.getElementById('gmain');
      const cell = g.querySelector('.atimg'), img = g.querySelector('img');
      const box = (cell || img)?.getBoundingClientRect();
      return {
        atlas: !!cell, hasImg: !!img, src: img?.getAttribute('src') || '',
        w: box ? Math.round(box.width) : 0,
        natural: img ? img.naturalWidth : 0,
        role: g.getAttribute('role'), tab: g.getAttribute('tabindex'), label: g.getAttribute('aria-label') || '',
      };
    });
    /* Ячейка атласа — ровно 240 пикселей; шире её не растягиваем. */
    if (info.atlas) {
      check(`${slug}: снимок из атласа не растянут сверх 240 px`, info.w <= 240, `ширина ${info.w} px`);
    } else {
      check(`${slug}: снимок из файла не растянут сверх исходника`,
        !info.natural || info.w <= info.natural + 1, `ширина ${info.w} px при исходнике ${info.natural} px`);
    }
    check(`${slug}: фото доступно с клавиатуры`, info.role === 'button' && info.tab === '0' && /Открыть фото/.test(info.label),
      `role=${info.role} tabindex=${info.tab}`);

    /* Открытие нажатием и закрытие по Esc с возвратом фокуса. */
    await page.locator('#gmain').click();
    await page.waitForTimeout(300);
    let open = await page.evaluate(() => document.getElementById('lightbox').classList.contains('open'));
    check(`${slug}: увеличение открывается нажатием`, open);
    const shown = await page.evaluate(() => {
      const lb = document.getElementById('lightbox');
      const at = lb.querySelector('.lb-atlas'), im = lb.querySelector('img'), note = lb.querySelector('.lb-note');
      return { atlas: !at.hidden, img: !im.hidden, note: note.hidden ? '' : note.textContent };
    });
    check(`${slug}: в увеличении показан снимок`, shown.atlas || shown.img,
      shown.atlas ? 'из атласа, с оговоркой: ' + shown.note.slice(0, 48) : 'из файла');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    open = await page.evaluate(() => document.getElementById('lightbox').classList.contains('open'));
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id === 'gmain');
    check(`${slug}: Esc закрывает и возвращает фокус`, !open && focused, `открыт=${open}, фокус на фото=${focused}`);

    /* Клавиатура: Enter на площадке открывает то же окно. */
    await page.evaluate(() => document.getElementById('gmain').focus());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    open = await page.evaluate(() => document.getElementById('lightbox').classList.contains('open'));
    check(`${slug}: Enter с клавиатуры открывает увеличение`, open);
    await page.keyboard.press('Escape');
  }

  /* Колонка «Коротко о товаре» не должна быть из трёх строк при живых
     полях выгрузки — и не должна показывать остатки склада. */
  await page.goto(`${BASE}/product/${prod('hb-tk-8115bk')}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.keyspecs', { timeout: 15000 });
  const keys = await page.evaluate(() => [...document.querySelectorAll('.keyspecs .krow')].map((r) => ({
    k: r.querySelector('span')?.textContent?.trim() || '', v: r.querySelector('b')?.textContent?.trim() || '',
  })));
  check('300972: в «Коротко о товаре» больше трёх строк', keys.length > 3,
    `строк ${keys.length}: ` + keys.map((x) => x.k).join(', '));
  const names = keys.map((x) => x.k);
  check('300972: подтверждённые поля B2B на месте',
    names.includes('Артикул') && names.includes('Особенности') && names.includes('В упаковке'),
    names.join(', '));
  check('300972: строки не повторяются', new Set(names).size === names.length);
  check('300972: остатков склада в блоке нет',
    !keys.some((x) => /остат|склад|шт\. в наличии/i.test(x.k + ' ' + x.v)));

  await ctx.close();
}

/*
  Картинки главной: плитки разделов, «Лучшие предложения» и карточки.

  Проверка появилась после того, как четыре плитки («Матричные»,
  «Бумага и плёнки», «Обслуживание и инструмент», «Печатающая техника»)
  оказались с заглушками при живых фотографиях в этих разделах. Причин
  было две, и обе тихие: у одних разделов первым шёл товар, у которого
  картинка — сама заглушка, у других — товар VTT с адресом на сервере
  поставщика, который в превью не грузится.

  Поэтому проверяем не «есть ли src», а результат: в categories.json нет
  внешних адресов, а на отрисованной странице каждая картинка либо
  реально загрузилась, либо честно относится к разделу без единой
  фотографии.
*/
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();

  const cats = await page.evaluate(async (base) => (await (await fetch(base + '/data/catalog/categories.json')).json()), BASE)
    .catch(() => null) || await (await fetch(`${BASE}/data/catalog/categories.json`)).json();
  const external = cats.filter((c) => /^https?:/i.test(String(c.img || '')));
  check('в разделах нет горячих ссылок на сервер поставщика', external.length === 0,
    external.map((c) => `${c.id} → ${c.img}`).join(', '));
  const noPic = cats.filter((c) => c.count > 0 && !c.imgId && (!c.img || /no-photo/.test(c.img)));
  check('заглушка осталась только там, где фотографий нет вовсе',
    noPic.every((c) => c.count <= 1), noPic.map((c) => `${c.id} (${c.count} товаров)`).join(', ') || 'таких разделов нет');

  for (const [name, width] of [['десктоп', 1440], ['телефон', 390]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.tiles .tile', { timeout: 15000 });
    /* Ленивые картинки за экраном не грузятся — доскроллим до низа. */
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(900);

    const shot = await page.evaluate(() => {
      const box = (sel) => [...document.querySelectorAll(sel)];
      const stat = (sel) => {
        const out = { total: 0, broken: [], placeholder: 0, atlas: 0 };
        for (const el of box(sel)) {
          const img = el.querySelector('img'), at = el.querySelector('.atimg');
          out.total += 1;
          if (at) { out.atlas += 1; continue; }
          if (!img) { out.broken.push('нет картинки вовсе'); continue; }
          if (/no-photo/.test(img.getAttribute('src') || '')) { out.placeholder += 1; continue; }
          if (!img.complete || img.naturalWidth === 0) out.broken.push(img.getAttribute('src') || '(пусто)');
        }
        return out;
      };
      return { tiles: stat('.tiles .tile .ph'), tilesS: stat('.tiles-s .tile-s .ph'), cards: stat('.grid4 .card .cmedia') };
    });
    for (const [label, st] of [['плитки разделов', shot.tiles], ['мелкие плитки', shot.tilesS], ['лучшие предложения', shot.cards]]) {
      check(`${name}: ${label} — картинки загрузились`, st.broken.length === 0,
        st.broken.length ? 'битые: ' + st.broken.slice(0, 3).join(', ')
          : `всего ${st.total}, из атласа ${st.atlas}, заглушек ${st.placeholder}`);
    }
    check(`${name}: заглушек в плитках не больше одной`,
      shot.tiles.placeholder + shot.tilesS.placeholder <= 1,
      `заглушек ${shot.tiles.placeholder + shot.tilesS.placeholder}`);
  }

  /* Выборка карточек каталога: те же картинки, но на странице списка. */
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/catalog/paper`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 15000 });
  await page.waitForTimeout(700);
  const list = await page.evaluate(() => {
    const out = { total: 0, broken: [], atlas: 0, placeholder: 0 };
    for (const el of [...document.querySelectorAll('.card .cmedia')].slice(0, 24)) {
      out.total += 1;
      const at = el.querySelector('.atimg'), img = el.querySelector('img');
      if (at) { out.atlas += 1; continue; }
      if (!img) { out.broken.push('нет картинки'); continue; }
      if (/no-photo/.test(img.getAttribute('src') || '')) { out.placeholder += 1; continue; }
      if (!img.complete || img.naturalWidth === 0) out.broken.push(img.getAttribute('src') || '(пусто)');
    }
    return out;
  });
  check('карточки раздела «Бумага» — картинки загрузились', list.broken.length === 0,
    list.broken.length ? 'битые: ' + list.broken.slice(0, 3).join(', ') : `всего ${list.total}, из атласа ${list.atlas}, заглушек ${list.placeholder}`);

  await ctx.close();
}

/*
  Демо-отзывы — сплошная проверка по всему каталогу.

  Открывать тысячи страниц бессмысленно: генератор чистый и вынесен на
  window, поэтому гоняем его прямо в браузере по всем карточкам разом.
  Проверяем то, за что отвечает код: примеры есть у каждого товара,
  количество на артикул лежит в 1..DEMO_MAX и реально разбросано, оценки
  только 3–5, внутри карточки тексты не повторяются, а в рейтинг,
  счётчик отзывов и микроразметку ни одна запись не попадает.

  Про сами записи. На боевом сайте у примера есть вымышленные имя и
  дата, и признака «демо» на карточке записи нет. Значит, единственное,
  что отделяет ленту от настоящих отзывов, — пометка над ней. Её и
  проверяем дословно: пропадёт строка — посетитель примет примеры за
  отзывы покупателей, и тест обязан на это упасть.
*/
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/product/${SLUG}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#ptabs', { timeout: 15000 });

  const stat = await page.evaluate(async () => {
    const C = window.HBCatalog;
    const countOne = window.HB_DEMO_COUNT_ONE || window.HB_DEMO_COUNT;
    const gen = window.HB_DEMO_REVIEWS_FOR;
    const items = C.all();
    const out = {
      total: items.length, without: [], dup: [], badRate: [], empty: [],
      totals: [], hist: { one: 0, small: 0, mid: 0, big: 0 }, byType: {},
    };
    for (const p of items) {
      const n = countOne(p);
      out.totals.push(n);
      if (!n) { if (out.without.length < 5) out.without.push(p.id); continue; }
      out.hist[n === 1 ? 'one' : n < 10 ? 'small' : n < 50 ? 'mid' : 'big'] += 1;
      const d = await C.detail(p.id);
      const got = gen(p, d, 0, 12);
      const texts = got.map((r) => r.text);
      if (!texts.length || texts.some((t) => !t || t.length < 20)) { if (out.empty.length < 5) out.empty.push(p.id); }
      if (new Set(texts).size !== texts.length && out.dup.length < 5) out.dup.push(p.id);
      for (const r of got) if (![3, 4, 5].includes(r.rate) && out.badRate.length < 5) out.badRate.push(p.id + ': ' + r.rate);
      out.byType[p.type || '—'] = (out.byType[p.type || '—'] || 0) + 1;
    }
    const live = out.totals.filter(Boolean);
    out.min = Math.min(...live); out.top = Math.max(...live);
    out.sum = live.reduce((a, b) => a + b, 0);
    return out;
  });

  /* Потолок читаем из самого кода витрины, а не держим второй копией в
     тесте: разойдутся — и тест начнёт проверять несуществующее число. */
  const appSrc = fs.readFileSync(path.join(process.cwd(), 'assets/js/app.js'), 'utf8');
  const DEMO_MAX = Number((appSrc.match(/var DEMO_MAX = (\d+);/) || [])[1]);

  check(`демо-отзывы есть у каждого из ${stat.total} товаров каталога`, stat.without.length === 0,
    stat.without.length ? 'без отзывов: ' + stat.without.join(', ') : `типов товара: ${Object.keys(stat.byType).length}`);
  check(`количество на артикул в диапазоне 1–${DEMO_MAX}`, stat.min >= 1 && stat.top <= DEMO_MAX,
    `от ${stat.min} до ${stat.top}, всего ${stat.sum}`);
  /* Разброс, а не одно число на весь каталог. */
  const h = stat.hist;
  check('разброс количества реально используется', h.one > 0 && h.small > 0 && h.mid > 0 && h.big > 0,
    `1 → ${h.one}, 2–9 → ${h.small}, 10–49 → ${h.mid}, 50+ → ${h.big}`);
  check('оценки только 3–5', stat.badRate.length === 0, stat.badRate.join(', '));
  check('внутри карточки тексты не повторяются', stat.dup.length === 0, stat.dup.join(', '));
  check('пустых и обрубленных текстов нет', stat.empty.length === 0, stat.empty.join(', '));

  /* Разметка блока в собранном виде: пометка над лентой и порционная загрузка. */
  await page.goto(`${BASE}/product/${prod('hb-tk-8115bk')}?tab=reviews`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.demo-block', { timeout: 15000 }).catch(() => {});
  const block = await page.locator('.demo-block').count();
  check('лента примеров отрисовалась', block === 1, `найдено ${block}`);
  if (block) {
    const head = await page.locator('.demo-head').innerText();
    check('над лентой сказано, что это вымышленные примеры',
      /вымышленных примеров, не отзывов покупателей/.test(head), head.replace(/\n/g, ' ').slice(0, 120));
    check('сказано, что имена, даты и оценки вымышлены', /Имена, даты и оценки вымышлены/.test(head));
    check('сказано, что записи не идут в рейтинг и счётчик',
      /в рейтинг товара и число отзывов они не входят/.test(head));
    check('нумерации «Демонстрационный пример №» больше нет',
      !/Демонстрационный пример №/.test(await page.locator('.demo-block').innerText()));
    const shown = await page.locator('.demo-block .rev-demo').count();
    const rated = await page.locator('.demo-block .demo-rate').count();
    check('у каждой записи есть помеченная оценка', shown > 0 && rated === shown,
      `записей ${shown}, оценок ${rated}`);

    const total = Number(await page.locator('.demo-block').getAttribute('data-total'));
    const before = await page.locator('.demo-block .rev-demo').count();
    if (total > before) {
      await page.locator('[data-demo-more]').click();
      await page.waitForFunction((n) => document.querySelectorAll('.demo-block .rev-demo').length > n, before, { timeout: 8000 })
        .catch(() => {});
      const after = await page.locator('.demo-block .rev-demo').count();
      check('«Показать ещё» догружает следующую порцию', after > before, `${before} → ${after} из ${total}`);
      const foot = await page.locator('.demo-more').innerText();
      check('счётчик показанного обновился', new RegExp(String(after)).test(foot.replace(/\u00a0/g, ' ')), foot.replace(/\n/g, ' '));
    } else {
      check('«Показать ещё» не нужна: записи уместились целиком', true, `всего ${total}`);
    }
  }

  /*
    Ни одна вымышленная запись не считается отзывом.

    Шапка и сводка берут число из настоящих отзывов, а их нет, — значит
    ни счётчика, ни звёзд, ни средней оценки на странице быть не должно,
    сколько бы примеров ни стояло ниже.
  */
  const headDemo = await page.locator('.pmeta').innerText();
  check('в шапке нет счётчика отзывов и оценки', !/\d+\s+отзыв/.test(headDemo) && !/\d,\d/.test(headDemo),
    headDemo.replace(/\n/g, ' ').slice(0, 90));
  const tabLabel = await page.locator('#tab-reviews').innerText();
  check('на вкладке «Отзывы» нет числа примеров', !/\d/.test(tabLabel), tabLabel.replace(/\n/g, ' '));
  const micro = await page.evaluate(() => document.documentElement.innerHTML.includes('aggregateRating'));
  check('микроразметки с рейтингом нет', micro === false);

  /* Форма настоящего отзыва на месте и не тронута. */
  check('форма настоящего отзыва осталась', (await page.locator('#rev-form input[name=email]').count()) === 1);
  check('оценка в форме по-прежнему не выбрана заранее',
    (await page.locator('#rev-form input[name=rate]:checked').count()) === 0);

  await ctx.close();
}

/*
  Проверка на СОБРАННОМ превью, а не только на сайте.

  Здесь ловится целый класс расхождений: сборка артефакта переписывает
  адреса ресурсов в относительные, потому что корневые пути («/assets/…»)
  артефакт не отдаёт. Код, проверявший путь как «^/assets/img/», на
  dev-сервере работал, а в опубликованном превью молча выбирал ячейку
  атласа вместо полноразмерного файла — и на витрине это выглядело как
  «фото не обновилось».

  Поэтому поднимаем dist/artifact как статику, ходим по hash-маршрутам и
  смотрим на то, что реально попадёт к людям.
*/
if (fs.existsSync(path.join(ROOT, 'dist/artifact/index.html'))) {
  const DIST = path.join(ROOT, 'dist/artifact');
  const TYPES2 = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const art = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const abs = path.join(DIST, p);
    if (!abs.startsWith(DIST) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': TYPES2[path.extname(abs)] || 'application/octet-stream' });
    res.end(fs.readFileSync(abs));
  });
  await new Promise((r) => art.listen(0, r));
  const ART = `http://127.0.0.1:${art.address().port}`;

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${ART}/index.html#/product/${prod('hb-tk-8115bk')}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((slug) => { location.hash = '#/product/' + slug; }, prod('hb-tk-8115bk'));
  await page.waitForSelector('#gmain', { timeout: 15000 });
  await page.waitForTimeout(900);

  const seen = await page.evaluate(() => {
    const g = document.getElementById('gmain');
    const img = g.querySelector('img'), cell = g.querySelector('.atimg');
    return { src: img ? img.getAttribute('src') : null, atlas: !!cell, natural: img ? img.naturalWidth : 0 };
  });
  check('превью: основное фото 300972 — полноразмерный файл, не атлас',
    !seen.atlas && /4100603160\.jpg$/.test(String(seen.src)), `src=${seen.src}, атлас=${seen.atlas}`);
  check('превью: файл действительно загрузился', seen.natural >= 600, `исходник ${seen.natural} px`);

  await page.locator('#gmain').click();
  await page.waitForTimeout(500);
  const zoom = await page.evaluate(() => {
    const lb = document.getElementById('lightbox');
    const at = lb.querySelector('.lb-atlas'), im = lb.querySelector('img'), note = lb.querySelector('.lb-note');
    return { open: lb.classList.contains('open'), atlas: !at.hidden, src: im.hidden ? null : im.getAttribute('src'),
      note: note.hidden ? '' : note.textContent };
  });
  check('превью: увеличение 300972 показывает тот же файл',
    zoom.open && !zoom.atlas && /4100603160\.jpg$/.test(String(zoom.src)), `src=${zoom.src}, атлас=${zoom.atlas}`);
  check('превью: фразы про 240 пикселей у 300972 нет', !/240/.test(zoom.note), zoom.note.slice(0, 60) || 'оговорки нет');

  /*
    Товар, чей полноразмерный файл в артефакт не поместился.

    На сайте снимок есть у 3 339 товаров, а в превью помещается два
    десятка файлов: остальные обязаны честно откатываться на ячейку
    атласа, а не показывать пустую рамку. Товар выбираем по факту —
    берём тот, чьего файла в собранном артефакте нет.
  */
  await page.keyboard.press('Escape');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
  const iImg = idx.fields.indexOf('img'), iSlug = idx.fields.indexOf('slug');
  const missing = idx.rows.find((r) => {
    const img = String(r[iImg] || '');
    return /^\/assets\/img\/vtt(-full)?\//.test(img) &&
      !fs.existsSync(path.join(DIST, img.slice(1)));
  });
  if (missing) {
    const slug = typeof missing[iSlug] === 'string' ? missing[iSlug] : missing[0];
    await page.goto(`${ART}/index.html#/product/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((s2) => { location.hash = '#/product/' + s2; }, slug);
    await page.waitForSelector('#gmain', { timeout: 15000 });
    await page.waitForTimeout(700);
    const other = await page.evaluate(() => ({
      atlas: !!document.querySelector('#gmain .atimg'),
      broken: [...document.querySelectorAll('#gmain img')].some((i) => i.complete && i.naturalWidth === 0),
    }));
    check('превью: не поместившийся снимок откатился на ячейку атласа', other.atlas && !other.broken,
      `${slug}: атлас=${other.atlas}, битых img=${other.broken}`);
  } else {
    check('превью: все полноразмерные снимки поместились в артефакт', true);
  }

  await ctx.close();
  art.close();
}

await browser.close();
stop();

const failed = results.filter((r) => !r.ok);
console.log(`\nПроверок: ${results.length}, не прошло: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
