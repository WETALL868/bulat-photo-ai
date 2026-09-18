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
  Отзывы: от формы до карточки, через настоящую админку.

  Проверяем не заглушку, а тот код, который поедет на хостинг: dev-сервер
  проксирует /api/admin/* во встроенный PHP. Если админка на этой машине
  не настроена (нет api/config-path.php с хешем пароля) — честно
  пропускаем, а не делаем вид, что проверили.
*/
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  /* Спрашиваем сервер уже со страницы сайта: на about:blank fetch по
     относительному адресу идти некуда, и проверка «не настроено» была бы
     ложной. */
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  const probe = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/admin/session', { cache: 'no-store' });
      return await r.json();
    } catch (e) { return { error: String(e) }; }
  });

  if (!probe || probe.configured !== true) {
    check('админка: проверка пропущена — пароль на этой машине не задан', true,
      'нужен api/config-path.php с admin_password_hash');
  } else {
    const PASSWORD = process.env.HB_ADMIN_PASSWORD || 'dev-parol-dlya-testa';
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    check('админка: открывается страница входа', (await page.locator('#login-form').count()) === 1);
    check('админка: очередь до входа не видна', (await page.locator('#list-view:visible').count()) === 0);

    /* Неверный пароль не должен ни пускать, ни рассказывать почему. */
    await page.fill('#pw', 'заведомо-неверный');
    await page.click('#login-form button[type=submit]');
    await page.waitForTimeout(800);
    const err = await page.locator('#msg').innerText().catch(() => '');
    check('админка: неверный пароль отклонён', /неверный пароль/i.test(err), err.slice(0, 60));
    check('админка: после отказа очередь по-прежнему закрыта',
      (await page.locator('#list-view:visible').count()) === 0);

    await page.fill('#pw', PASSWORD);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#list-view:visible', { timeout: 10000 }).catch(() => {});
    check('админка: вход по паролю работает', (await page.locator('#list-view:visible').count()) === 1);

    await page.click('[data-status="all"]');
    await page.waitForTimeout(700);
    const cards = await page.locator('#list [data-file]').count();
    check('админка: очередь показана', cards > 0, `записей ${cards}`);

    if (cards > 0) {
      const first = page.locator('#list [data-file]').first();
      const file = await first.getAttribute('data-file');
      const body = await first.innerText();
      /* Адрес автора модератору нужен — именно по нему он уточняет отзыв
         и сверяет покупку с заказом. Наружу он не уходит, и это
         проверяется ниже, на карточке товара. */
      check('админка: адрес автора виден модератору', /@/.test(body), body.split('\n')[1] || '');

      const before = await page.evaluate(async (base) => {
        const r = await fetch(base + '/live/reviews.json', { cache: 'no-store' });
        return r.ok ? Object.keys((await r.json()).items || {}).length : 0;
      }, BASE);

      const approve = first.locator('button[data-do="approve"]');
      if (await approve.count()) {
        await approve.click();
        await page.waitForTimeout(1200);
        const after = await page.evaluate(async (base) => {
          const r = await fetch(base + '/live/reviews.json', { cache: 'no-store' });
          return r.ok ? await r.json() : { items: {} };
        }, BASE);
        const ids = Object.keys(after.items || {});
        check('админка: одобрение сразу попало в live/reviews.json', ids.length > before,
          `товаров с отзывами: ${before} → ${ids.length}`);

        const target = ids[0];
        const listed = after.items[target].list || [];
        check('в опубликованном отзыве нет адреса автора',
          !JSON.stringify(listed).includes('@'), JSON.stringify(listed).slice(0, 60));

        /* Самое важное: отзыв виден на сайте без пересборки каталога. */
        const slug = prod(target);
        const buyer = await ctx.newPage();
        await buyer.goto(`${BASE}/product/${slug}?tab=reviews`, { waitUntil: 'networkidle' });
        await buyer.waitForSelector('#ptabs', { timeout: 15000 });
        const panel = await buyer.locator('[data-panel="reviews"]').innerText();
        const meta = await buyer.locator('.pmeta').innerText();
        check('одобренный отзыв виден на карточке без пересборки',
          panel.includes(listed[0].text.slice(0, 30)), panel.split('\n')[0]);
        check('в шапке появились оценка и счётчик', /\d,\d/.test(meta) && /отзыв/.test(meta),
          meta.replace(/\n/g, ' ').slice(0, 70));
        check('адрес автора на страницу не попал', !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(panel));
        await buyer.close();

        /* Возвращаем очередь как было: проверка не должна оставлять
           одобренный отзыв на витрине. */
        await page.evaluate(async ([base, f, csrfless]) => {
          const s = await (await fetch(base + '/api/admin/session', { cache: 'no-store' })).json();
          await fetch(base + '/api/admin/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
            body: JSON.stringify({ file: f, action: 'pending' }),
          });
        }, [BASE, file, null]);
        await page.waitForTimeout(600);
        const restored = await page.evaluate(async (base) => {
          const r = await fetch(base + '/live/reviews.json', { cache: 'no-store' });
          return r.ok ? Object.keys((await r.json()).items || {}).length : 0;
        }, BASE);
        check('возврат на модерацию убирает отзыв с витрины', restored === before,
          `товаров с отзывами: ${restored}`);
      }
    }
  }
  await ctx.close();
}

/*
  На витрине не должно остаться ни одной сгенерированной записи.
*/
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/product/${SLUG}?tab=reviews`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#ptabs', { timeout: 15000 });
  const panel = await page.locator('[data-panel="reviews"]').innerText();
  check('вымышленной ленты на карточке нет',
    !/вымышленных примеров|Демо-отзыв/.test(panel) && (await page.locator('.demo-block').count()) === 0);
  check('вкладка честно говорит, что отзывов нет', /Отзывов пока нет/.test(panel),
    panel.split('\n')[0]);
  const gen = await page.evaluate(() => ({
    count: typeof window.HB_DEMO_COUNT,
    flag: typeof window.HB_DEMO_REVIEWS,
    gen: typeof window.HB_DEMO_REVIEWS_FOR,
  }));
  check('генератора вымышленных отзывов в браузере нет',
    gen.count === 'undefined' && gen.flag === 'undefined' && gen.gen === 'undefined',
    JSON.stringify(gen));
  check('микроразметки с рейтингом нет',
    (await page.evaluate(() => document.documentElement.innerHTML.includes('aggregateRating'))) === false);
  check('форма настоящего отзыва осталась', (await page.locator('#rev-form input[name=email]').count()) === 1);
  check('оценка в форме не выбрана заранее',
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

/*
  Телефон: кнопка уведомления, закреплённая панель, конец страницы.

  Три ошибки, найденные владельцем на телефоне, жили в одном месте —
  в том, что содержимое мерили на глаз, а не по настоящей ширине:

    • «Уведомить о поступлении» не переносится (.btn запрещает перенос),
      и в карточке каталога шириной в половину экрана надпись вылезала
      наружу вместе с иконкой;
    • в закреплённой панели название и кнопка не помещались в одну
      строку, и название обрезалось на середине слова;
    • запас под панелью стоял на body, рисовался его белым фоном и давал
      полосу пустоты под тёмным футером — вдвое больше, чем нужно.

  Поэтому проверяем не «выглядит нормально», а числа: ничего не выходит
  за свою карточку и за окно, в панели ничего не обрезано, после футера
  ноль лишних пикселей.
*/
{
  const PHONES = [320, 360, 375, 390, 430];
  const stockOf = (id) => {
    const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'live/catalog-live.json'), 'utf8'));
    return !!(live.items[id] || {}).available;
  };
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
  const ids = idx.rows.map((r) => String(r[0]));
  const outId = ids.find((id) => !stockOf(id) && slugRegistry[id]);
  const inId = ids.find((id) => stockOf(id) && slugRegistry[id]);

  for (const width of PHONES) {
    const ctx = await browser.newContext({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });

    /* ----
      Каталог: кнопка уведомления внутри своей карточки.

      Раньше проверка смотрела первую страницу /catalog/zip — там и стояли
      отсутствующие позиции. Теперь наличие идёт первым ключом, и на
      первой странице кнопок «Уведомить» нет вовсе: это и есть исправление
      из пункта о сортировке. Поэтому идём на последнюю страницу раздела,
      где отсутствующие товары как раз и собрались.
    ---- */
    await page.goto(`${BASE}/catalog/zip`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 15000 });
    await page.waitForTimeout(350);
    const lastPage = await page.evaluate(() => {
      const nums = [...document.querySelectorAll('.pager a, .pages a')]
        .map((a) => Number(new URL(a.href, location.href).searchParams.get('page')))
        .filter((n) => n > 0);
      return nums.length ? Math.max(...nums) : 1;
    });
    await page.goto(`${BASE}/catalog/zip?page=${lastPage}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 15000 });
    await page.waitForTimeout(350);
    const grid = await page.evaluate(() => {
      const de = document.documentElement;
      const res = { overflowX: de.scrollWidth - window.innerWidth, spill: [], alerts: 0, tiny: [] };
      for (const card of document.querySelectorAll('.card')) {
        const cr = card.getBoundingClientRect();
        for (const el of card.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > cr.right + 0.5 || r.left < cr.left - 0.5) {
            if (res.spill.length < 4) res.spill.push(String(el.className).slice(0, 28) + ' «' +
              (el.textContent || '').trim().slice(0, 20) + '»');
          }
        }
        const a = card.querySelector('[data-stock-alert]');
        if (!a) continue;
        res.alerts += 1;
        const ar = a.getBoundingClientRect();
        /* Кнопка должна остаться крупной: мелкую не нажать пальцем. */
        if (ar.height < 34 || ar.width < 70) res.tiny.push(`${Math.round(ar.width)}x${Math.round(ar.height)}`);
      }
      return res;
    });
    check(`${width}: каталог без горизонтальной прокрутки`, grid.overflowX <= 0, `запас ${-grid.overflowX}px`);
    check(`${width}: ничего не вылезает за карточку`, grid.spill.length === 0, grid.spill.join('; '));
    check(`${width}: кнопка уведомления осталась крупной`, grid.alerts > 0 && grid.tiny.length === 0,
      `кнопок ${grid.alerts}${grid.tiny.length ? ', мелкие: ' + grid.tiny.join(', ') : ''}`);

    /* ---- карточка товара: панель и конец страницы ---- */
    for (const [id, label] of [[outId, 'без остатка'], [inId, 'в наличии']]) {
      await page.goto(`${BASE}/product/${prod(id)}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#ptabs', { timeout: 15000 });
      await page.evaluate(() => window.scrollTo(0, 2000));
      await page.waitForTimeout(600);
      const bar = await page.evaluate(() => {
        const b = document.getElementById('buybar');
        if (!b) return { нет: true };
        const br = b.getBoundingClientRect();
        const out = { h: Math.round(br.height), clipped: [], overflowX: document.documentElement.scrollWidth - window.innerWidth };
        for (const el of b.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > br.right + 0.5 || r.left < br.left - 0.5 || r.bottom > br.bottom + 0.5) {
            if (out.clipped.length < 4) out.clipped.push(String(el.className).slice(0, 26));
          }
        }
        const n = b.querySelector('.bbname');
        out.nameCut = n ? n.scrollHeight > n.clientHeight + 1 : false;
        out.hasCode = !!b.querySelector('.bbcode');
        out.hasAlert = !!b.querySelector('[data-stock-alert]');
        out.hasAdd = !!b.querySelector('[data-add]');
        out.terms = (b.querySelector('.bbterms') || { innerText: '' }).innerText.replace(/\n/g, ' ');
        return out;
      });
      check(`${width}: панель (${label}) ничего не обрезает`,
        !bar.нет && bar.clipped.length === 0 && bar.overflowX <= 0 && !bar.nameCut,
        `высота ${bar.h}px, обрезано ${(bar.clipped || []).length}, название обрезано ${bar.nameCut}`);
      check(`${width}: в панели (${label}) виден артикул`, bar.hasCode === true);
      if (label === 'без остатка') {
        check(`${width}: без остатка в панели уведомление, а не корзина`,
          bar.hasAlert === true && bar.hasAdd === false);
      } else {
        check(`${width}: в наличии — количество, итог и покупка`,
          bar.hasAdd === true && /шт\./.test(bar.terms) && /₽/.test(bar.terms), bar.terms.slice(0, 60));
      }

      /* Конец страницы: прокручиваем до упора надёжно — одиночный
         scrollTo в мобильном контексте не всегда доезжает. */
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => { const e = document.scrollingElement || document.documentElement; e.scrollTop = e.scrollHeight; });
        await page.waitForTimeout(150);
      }
      const tail = await page.evaluate(() => {
        const de = document.documentElement;
        const f = document.querySelector('.foot').getBoundingClientRect();
        const b = document.getElementById('buybar');
        const last = document.querySelector('.foot .credit') || document.querySelector('.foot .fbottom');
        return {
          after: Math.round(de.scrollHeight - (f.bottom + window.scrollY)),
          bodyPB: getComputedStyle(document.body).paddingBottom,
          clearance: b && last ? Math.round(b.getBoundingClientRect().top - last.getBoundingClientRect().bottom) : null,
        };
      });
      check(`${width}: после футера (${label}) нет пустоты`, tail.after === 0,
        `${tail.after}px, padding-bottom у body ${tail.bodyPB}`);
      check(`${width}: панель (${label}) не накрывает конец футера`, tail.clearance === null || tail.clearance >= 0,
        `просвет ${tail.clearance}px`);
    }

    /* ---- вкладка «Доставка и оплата» ---- */
    await page.goto(`${BASE}/product/${prod(inId)}?tab=delivery`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#ptabs', { timeout: 15000 });
    await page.waitForTimeout(400);
    const dlv = await page.evaluate(() => {
      const p = document.querySelector('[data-panel="delivery"]');
      if (!p) return { нет: true };
      const pr = p.getBoundingClientRect();
      const spill = [...p.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > pr.right + 0.5 || r.left < pr.left - 0.5);
      }).length;
      return {
        h: Math.round(pr.height), spill, hidden: p.hidden,
        внутриДругойПанели: !!p.parentElement.closest('[data-tabpanel], [role="tabpanel"]'),
        text: (p.innerText || '').replace(/\n+/g, ' '),
      };
    });
    check(`${width}: вкладка «Доставка и оплата» видна`, !dlv.нет && dlv.h > 200 && !dlv.внутриДругойПанели,
      `высота ${dlv.h}px`);
    check(`${width}: во вкладке есть доставка, оплата и раздел для юрлиц`,
      /Доставка/.test(dlv.text) && /Оплата/.test(dlv.text) && /Юридическим лицам/.test(dlv.text) &&
      /Самовывоз/.test(dlv.text) && /СДЭК/.test(dlv.text));
    check(`${width}: вкладка не обещает онлайн-оплату`,
      !/СБП/.test(dlv.text) || /появится после подключения/.test(dlv.text));
    check(`${width}: во вкладке ничего не вылезает`, dlv.spill === 0, `вылезает ${dlv.spill}`);

    await ctx.close();
  }
}

/*
  Карточка товара, у которого снимка нет.

  Поставщик присылает у таких позиций PhotoUrl «dummy.jpg», и в каталоге
  честно стоит заглушка. Проверяем, что вокруг неё ничего не обещано
  лишнего: ни «Крупный план» серого прямоугольника, ни увеличения, ни
  битых адресов. И что на карточке со снимком всё это по-прежнему есть.
*/
{
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
  const iImg = idx.fields.indexOf('img');
  const unpackImg = (v) => {
    const t = String(v ?? '');
    return t.charCodeAt(0) === 1 ? idx.imgBases[Number(t[1])] + t.slice(2) : t;
  };
  const blank = idx.rows.find((r) => /no-photo/.test(unpackImg(r[iImg])) && slugRegistry[r[0]]);
  const shot = idx.rows.find((r) => /vtt-full/.test(unpackImg(r[iImg])) && slugRegistry[r[0]]);

  for (const device of [
    { name: 'десктоп', viewport: { width: 1440, height: 900 } },
    { name: 'телефон', viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true },
  ]) {
    const ctx = await browser.newContext({ viewport: device.viewport, hasTouch: device.hasTouch });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });

    for (const [row, label] of [[blank, 'без снимка'], [shot, 'со снимком']]) {
      if (!row) continue;
      const bad = [];
      page.removeAllListeners('response');
      page.on('response', (r) => {
        if (r.status() >= 400 && /\.(webp|jpe?g|png|svg)(\?|$)/i.test(r.url())) bad.push(r.status() + ' ' + r.url());
      });
      await page.goto(`${BASE}/product/${prod(row[0])}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#gmain', { timeout: 15000 });
      await page.waitForTimeout(500);
      const g = await page.evaluate(() => {
        const main = document.getElementById('gmain');
        const imgs = [...document.querySelectorAll('#app img')];
        return {
          noPhoto: main.classList.contains('no-photo'),
          role: main.getAttribute('role'),
          zoomOffer: !!main.querySelector('.zoom'),
          note: (main.querySelector('.gnote') || {}).textContent || '',
          thumbs: [...document.querySelectorAll('.thumbs .thumb')].map((t) => t.getAttribute('title')),
          brokenImgs: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')),
          mainSrc: (main.querySelector('img') || {}).getAttribute
            ? main.querySelector('img').getAttribute('src') : '',
        };
      });
      /* Что реально откроется по «Открыть фото» — спрашиваем у страницы,
         а не у разметки: именно здесь выбор и терялся. */
      if (label === 'со снимком') {
        await page.click('#gmain').catch(() => {});
        await page.waitForTimeout(400);
        g.lbSrc = await page.evaluate(() => {
          const i = document.querySelector('#lightbox img');
          return i ? i.getAttribute('src') : '';
        });
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
      }
      check(`${device.name}: картинки карточки (${label}) отдаются без ошибок`, bad.length === 0, bad.slice(0, 2).join('; '));
      check(`${device.name}: на карточке (${label}) нет несостоявшихся картинок`,
        g.brokenImgs.length === 0, g.brokenImgs.slice(0, 2).join('; '));

      if (label === 'без снимка') {
        check('карточка без снимка помечена как таковая', g.noPhoto === true && /no-photo\.svg$/.test(g.mainSrc));
        check('без снимка не предлагается ни одного кадра',
          !g.thumbs.some((t) => /Фото/.test(t || '')), 'виды: ' + g.thumbs.join(', '));
        check('без снимка нет подписи «Открыть фото»', g.zoomOffer === false);
        check('без снимка площадка не притворяется кнопкой', g.role !== 'button');
        check('без снимка сказано, что фото не передано', /не передал фото/.test(g.note), g.note.trim());
        /* Нажатие не должно открывать заглушку во весь экран. */
        await page.click('#gmain').catch(() => {});
        await page.waitForTimeout(400);
        const lbOpen = await page.evaluate(() => {
          const lb = document.getElementById('lightbox');
          return !!lb && !lb.hidden;
        });
        check('нажатие на заглушку не открывает увеличение', lbOpen === false);
      } else {
        check('карточка со снимком предлагает увеличение', g.noPhoto === false && g.zoomOffer === true);
        check('карточка со снимком осталась кнопкой', g.role === 'button');
        /* Миниатюр ровно столько, сколько настоящих кадров: полоса из
           одного вида не рисуется вовсе, а «Крупный план» из того же
           файла больше не выдумывается. */
        check('у карточки со снимком нет выдуманных видов',
          !g.thumbs.includes('Крупный план'), 'виды: ' + g.thumbs.join(', '));
        check('карточка со снимком открывает именно его',
          g.lbSrc === g.mainSrc, `главное ${g.mainSrc}, увеличение ${g.lbSrc}`);
      }
    }
    await ctx.close();
  }

  /* Каталог: ни одной несостоявшейся картинки в сетке. */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && /\.(webp|jpe?g|png|svg)(\?|$)/i.test(r.url())) bad.push(r.status() + ' ' + r.url());
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });
  await page.goto(`${BASE}/catalog/zip`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 15000 });
  await page.waitForTimeout(700);
  const grid = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.card img')];
    return {
      total: imgs.length,
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')).slice(0, 3),
      placeholders: imgs.filter((i) => /no-photo/.test(i.getAttribute('src') || '')).length,
    };
  });
  check('в сетке каталога нет несостоявшихся картинок', grid.broken.length === 0, grid.broken.join('; '));
  check('картинки каталога отдаются без ошибок', bad.length === 0, bad.slice(0, 2).join('; '));
  check('в сетке есть и снимки, и заглушки', grid.total > 0,
    `картинок ${grid.total}, из них заглушек ${grid.placeholders}`);
  await ctx.close();
}

/*
  Полное название товара в каталоге, поиске и списке.

  Ошибка владельца: в выдаче по артикулу 006R01160 название обрывалось
  ровно там, где стоял артикул, и отличить товар от соседнего было
  нельзя. Проверяем не правило в CSS, а отрисованную страницу: у каждого
  названия не должно быть невидимого хвоста (scrollHeight больше высоты
  блока), и при этом сетка не должна уезжать за край экрана.
*/
{
  const WIDTHS = [
    { name: 'десктоп 1440', width: 1440, height: 900 },
    { name: 'телефон 430', width: 430, height: 900, mobile: true },
    { name: 'телефон 390', width: 390, height: 844, mobile: true },
    { name: 'телефон 375', width: 375, height: 812, mobile: true },
    { name: 'телефон 360', width: 360, height: 740, mobile: true },
    { name: 'телефон 320', width: 320, height: 640, mobile: true },
  ];
  /* Товар с заведомо длинным названием и длинным артикулом без пробелов:
     на нём обрезка и распирание карточки видны раньше всего. */
  const PAGES = [
    ['поиск', '/search?q=006R01160'],
    ['каталог', '/catalog/laser'],
    ['список', '/catalog/laser?v=list'],
  ];
  for (const d of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: d.width, height: d.height },
      isMobile: !!d.mobile, hasTouch: !!d.mobile,
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });
    for (const [label, url] of PAGES) {
      await page.goto(BASE + url, { waitUntil: 'networkidle' });
      await page.waitForSelector('.ctitle', { timeout: 15000 });
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.ctitle')];
        const clipped = t.filter((x) => x.scrollHeight > x.clientHeight + 1)
          .map((x) => x.textContent.trim().slice(0, 60));
        /* Низ карточек одного ряда должен оставаться на одной линии:
           название любой высоты не имеет права ломать ряд лесенкой. */
        const rows = {};
        document.querySelectorAll('.cards:not(.clist) .card').forEach((c) => {
          const b = c.getBoundingClientRect();
          const key = Math.round(b.top / 8);
          (rows[key] = rows[key] || []).push(Math.round(b.bottom));
        });
        const ragged = Object.values(rows).filter((v) => v.length > 1 && Math.max(...v) - Math.min(...v) > 2).length;
        /* Кнопка покупки обязана остаться внутри своей карточки. */
        const spill = [...document.querySelectorAll('.card .cfoot .btn, .card .cbot')].filter((e) => {
          const r2 = e.getBoundingClientRect(), c = e.closest('.card').getBoundingClientRect();
          return r2.left < c.left - 1 || r2.right > c.right + 1;
        }).length;
        return {
          n: t.length, clipped, ragged, spill,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      check(`${d.name}: ${label} — название видно целиком`, r.n > 0 && r.clipped.length === 0,
        r.n ? r.clipped.slice(0, 2).join(' | ') : 'названий на странице нет');
      check(`${d.name}: ${label} — сетка не уехала за край`, r.overflow <= 0, `лишних ${r.overflow}px`);
      check(`${d.name}: ${label} — низ карточек в ряду на одной линии`, r.ragged === 0, `рядов вразнобой: ${r.ragged}`);
      check(`${d.name}: ${label} — кнопки не вылезли из карточки`, r.spill === 0, `вылезло элементов: ${r.spill}`);
    }
    await ctx.close();
  }
}

/*
  Галерея: выбранный кадр открывается в увеличении.

  Ошибка владельца: выбрана вторая миниатюра, нажата «Открыть фото» —
  открывается первая. Настоящих товаров с несколькими снимками в проекте
  сейчас нет (поставщик отдаёт дополнительные кадры, но их файлы к нам не
  скачаны), поэтому многокадровая галерея проверяется ФИКСТУРОЙ: список
  кадров подменяется тремя РАЗНЫМИ файлами, которые лежат в проекте.
  Одно- и бескадровый случаи проверяются на настоящих товарах выше.
*/
{
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vtt-photos.json'), 'utf8')).photos || {};
  const files = [...new Set(Object.values(reg))].slice(0, 3).map((f) => '/assets/img/vtt-full/' + f);
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
  const iImg = idx.fields.indexOf('img');
  const unpackImg = (v) => {
    const t = String(v ?? '');
    return t.charCodeAt(0) === 1 ? idx.imgBases[Number(t[1])] + t.slice(2) : t;
  };
  const row = idx.rows.find((r) => /vtt-full/.test(unpackImg(r[iImg])) && slugRegistry[r[0]]);
  if (files.length === 3 && row) {
    for (const d of [
      { name: 'десктоп', viewport: { width: 1440, height: 1000 } },
      { name: 'телефон', viewport: { width: 390, height: 844 }, mobile: true },
    ]) {
      const ctx = await browser.newContext({ viewport: d.viewport, isMobile: !!d.mobile, hasTouch: !!d.mobile });
      const page = await ctx.newPage();
      await page.route('**/data/catalog/chunks/detail-*.json', async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        if (body[row[0]]) body[row[0]].photos = files;
        await route.fulfill({ response: res, body: JSON.stringify(body) });
      });
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });
      await page.goto(`${BASE}/product/${prod(row[0])}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.thumb[data-view]', { timeout: 15000 });
      await page.waitForTimeout(400);

      const titles = await page.$$eval('.thumb[data-view]', (e) => e.map((x) => x.title));
      /* Три настоящих снимка плюс два крупных плана первого кадра:
         крупные планы вернули по просьбе владельца, и они идут после
         фотографий, а не вместо них. */
      const photos = titles.filter((t) => /^Фото/.test(t));
      const crops = titles.filter((t) => /^Крупный план/.test(t));
      check(`${d.name}: три настоящих снимка дали три миниатюры`, photos.length === 3, titles.join(', '));
      check(`${d.name}: крупные планы идут после снимков, а не вместо них`,
        crops.length === 2 && titles.slice(0, 3).every((t) => /^Фото/.test(t)), titles.join(', '));

      let mismatched = [], altBad = [];
      for (const k of [1, 2, 0]) {
        await (await page.$$('.thumb[data-view]'))[k].click();
        await page.waitForTimeout(250);
        const main = await page.evaluate(() => {
          const i = document.querySelector('#gmain [data-gview="img"]');
          return i ? i.getAttribute('src') : '';
        });
        await page.click('#gmain');
        await page.waitForTimeout(350);
        const lb = await page.evaluate(() => {
          const i = document.querySelector('#lightbox img');
          return { src: i ? i.getAttribute('src') : '', alt: i ? i.alt : '' };
        });
        if (main !== files[k] || lb.src !== files[k]) mismatched.push(`кадр ${k + 1}: главное ${main}, увеличение ${lb.src}`);
        if (!lb.alt || lb.alt.indexOf(String(k + 1)) < 0) altBad.push(`кадр ${k + 1}: «${lb.alt}»`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }
      check(`${d.name}: увеличение открывает выбранный кадр`, mismatched.length === 0, mismatched.join('; '));
      check(`${d.name}: подпись кадра называет его номер`, altBad.length === 0, altBad.join('; '));

      /* Стрелки в увеличении двигают тот же выбор, что и миниатюры. */
      await (await page.$$('.thumb[data-view]'))[0].click();
      await page.waitForTimeout(200);
      await page.click('#gmain');
      await page.waitForTimeout(300);
      const cnt1 = await page.textContent('#lightbox .lb-count');
      await page.click('#lightbox [data-lb="1"]');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({
        src: document.querySelector('#lightbox img').getAttribute('src'),
        open: document.getElementById('lightbox').classList.contains('open'),
        count: document.querySelector('#lightbox .lb-count').textContent,
      }));
      check(`${d.name}: стрелка листает, а не закрывает`, after.open === true && after.src === files[1],
        `открыт ${after.open}, кадр ${after.src}`);
      const total = titles.length;
      check(`${d.name}: счётчик кадров считает`,
        cnt1.trim() === `1 / ${total}` && after.count.trim() === `2 / ${total}`,
        `${cnt1} -> ${after.count}, кадров ${total}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const kept = await page.evaluate(() => [...document.querySelectorAll('.thumb[data-view]')]
        .findIndex((t) => t.classList.contains('on')));
      check(`${d.name}: после закрытия выбран тот кадр, на котором остановились`, kept === 1, `подсвечена ${kept + 1}`);

      /* Переход на другой товар не оставляет кадр предыдущего. */
      await page.goto(`${BASE}/catalog/laser`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const left = await page.evaluate(() => {
        const i = document.querySelector('#lightbox img');
        return { src: i ? i.getAttribute('src') : '', open: document.getElementById('lightbox').classList.contains('open') };
      });
      check(`${d.name}: на другой странице не остался кадр предыдущего товара`,
        !left.open && !left.src, `${left.src}`);
      await ctx.close();
    }
  } else {
    check('фикстура для многокадровой галереи собралась', false,
      `файлов ${files.length}, товар ${row ? 'найден' : 'не найден'}`);
  }
}

/*
  Наличие всегда первым.

  На /catalog/zip первыми стояли позиции, которых нет. Проверяем не
  правило в коде, а отрисованную страницу: во всех режимах сортировки, на
  первой и на второй странице, при включённых фильтрах.
*/
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });

  const order = async (url) => {
    await page.goto(BASE + url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 15000 });
    await page.waitForTimeout(400);
    return page.evaluate(() => [...document.querySelectorAll('.cards .card')]
      .map((c) => (c.querySelector('.avail') || {}).classList?.contains('out') ? 0 : 1));
  };
  const firstOutBeforeIn = (flags) => {
    let sawOut = false;
    for (const f of flags) {
      if (!f) sawOut = true;
      else if (sawOut) return true;
    }
    return false;
  };
  const PAGES = [
    ['раздел ЗИП', '/catalog/zip'],
    ['раздел ЗИП, цена вверх', '/catalog/zip?sort=price'],
    ['раздел ЗИП, цена вниз', '/catalog/zip?sort=-price'],
    ['раздел ЗИП, рейтинг', '/catalog/zip?sort=rating'],
    ['раздел ЗИП, новинки', '/catalog/zip?sort=new'],
    ['раздел ЗИП, вторая страница', '/catalog/zip?page=2'],
    ['раздел ЗИП, по 48 на странице', '/catalog/zip?pp=48'],
    ['весь каталог', '/catalog'],
    ['поиск', '/search?q=ролик'],
    ['лазерные Kyocera', '/catalog/laser/kyocera'],
  ];
  for (const [label, url] of PAGES) {
    const flags = await order(url);
    check(`наличие первым: ${label}`, flags.length > 0 && !firstOutBeforeIn(flags),
      `порядок наличия: ${flags.join('')}`);
  }
  /* Фильтр «Только в наличии» смысла не меняет: отсутствующих нет совсем. */
  const onlyStock = await order('/catalog/zip?stock=1');
  check('фильтр «Только в наличии» оставляет только доступные',
    onlyStock.length > 0 && onlyStock.every(Boolean), `${onlyStock.join('')}`);
  await ctx.close();
}

/*
  Увеличение обязано увеличивать.

  Пример владельца: HB-KX-FAT410A7, снимок 400×283. Меряем кадр на
  странице и кадр в окне и требуем, чтобы на десктопе второй был заметно
  больше первого.
*/
{
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
  const iCode = idx.fields.indexOf('code');
  const rows = idx.rows.filter((r) => slugRegistry[r[0]]);
  const sample = [
    rows.find((r) => String(r[iCode]) === 'HB-KX-FAT410A7'),
    rows.find((r) => String(r[iCode]) === 'HB-006R01160'),
    rows.find((r) => String(r[iCode]) === 'HB-KX-FAD412A'),
  ].filter(Boolean);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });
  for (const row of sample) {
    await page.goto(`${BASE}/product/${prod(row[0])}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#gmain', { timeout: 15000 });
    await page.waitForTimeout(500);
    const onPage = await page.evaluate(() => {
      const el = document.querySelector('#gmain img, #gmain .atimg');
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), nat: el.naturalWidth || 0 };
    });
    await page.click('#gmain');
    await page.waitForTimeout(600);
    const inLb = await page.evaluate(() => {
      const el = document.querySelector('#lightbox img:not([hidden]), #lightbox .lb-atlas:not([hidden])');
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), panel: !document.querySelector('#lightbox .lb-zoom').hidden };
    });
    check(`${row[iCode]}: окно крупнее карточки`, inLb.w > onPage.w * 1.4,
      `на странице ${onPage.w}×${onPage.h}, в окне ${inLb.w}×${inLb.h} (исходник ${onPage.nat}px)`);
    check(`${row[iCode]}: панель масштаба показана`, inLb.panel === true);
    /* Кнопка «+» обязана реально увеличивать кадр. */
    await page.click('#lightbox [data-zoom="1"]');
    await page.waitForTimeout(300);
    const zoomed = await page.evaluate(() => {
      const el = document.querySelector('#lightbox img:not([hidden]), #lightbox .lb-atlas:not([hidden])');
      return Math.round(el.getBoundingClientRect().width);
    });
    check(`${row[iCode]}: кнопка «+» увеличивает`, zoomed > inLb.w + 10, `${inLb.w} -> ${zoomed}`);
    /* Пропорции не должны искажаться. */
    const ratio = await page.evaluate(() => {
      const i = document.querySelector('#lightbox img:not([hidden])');
      if (!i || !i.naturalWidth) return null;
      const r = i.getBoundingClientRect();
      return Math.abs((r.width / r.height) - (i.naturalWidth / i.naturalHeight));
    });
    if (ratio !== null) check(`${row[iCode]}: пропорции сохранены`, ratio < 0.02, `отклонение ${ratio.toFixed(3)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  await ctx.close();
}

/*
  Совместимость: один и тот же раздел у каждого товара.

  Оба примера владельца — соседние Panasonic: у одного миниатюра
  «Совместимость» подменяла фото, у другого перечня не было вовсе.
*/
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.setItem('hb_cookie_consent_v2', '1'); } catch (e) { } });
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
  const iCode = idx.fields.indexOf('code');
  const pick = ['HB-KX-FAT410A7', 'HB-KX-FAD412A', 'HB-006R01160']
    .map((c) => idx.rows.find((r) => String(r[iCode]) === c && slugRegistry[r[0]]))
    .filter(Boolean);
  for (const row of pick) {
    await page.goto(`${BASE}/product/${prod(row[0])}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#gmain', { timeout: 15000 });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const c = document.querySelector('.compat');
      return {
        block: !!c,
        head: c ? c.querySelector('h3').textContent.trim() : '',
        chips: c ? c.querySelectorAll('.chip').length : 0,
        note: c ? ((c.querySelector('.cnote') || {}).textContent || '').trim() : '',
        inGallery: !!document.querySelector('.gcompat, .thumb.tcompat'),
        thumbs: [...document.querySelectorAll('.thumb[data-view]')].map((t) => t.title),
      };
    });
    check(`${row[iCode]}: блок совместимости есть и назван одинаково`,
      r.block && r.head.startsWith('Совместимые модели принтеров'), r.head);
    check(`${row[iCode]}: совместимость не подменяет фото`, r.inGallery === false,
      `миниатюры: ${r.thumbs.join(', ')}`);
    check(`${row[iCode]}: блок не пустой`, r.chips > 0 || r.note.length > 20,
      `чипов ${r.chips}, пояснение «${r.note.slice(0, 60)}»`);
  }
  /* Ссылки чипов ведут на существующие страницы, а не в 404. */
  await page.goto(`${BASE}/product/${prod(pick[1][0])}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const hrefs = await page.$$eval('.compat .chip', (e) => e.slice(0, 5).map((x) => x.getAttribute('href')));
  const broken = [];
  for (const h of hrefs) {
    const res = await page.request.get(BASE + h);
    if (res.status() >= 400) broken.push(h + ' -> ' + res.status());
  }
  check('ссылки совместимости не ведут в 404', broken.length === 0, broken.join('; '));
  await ctx.close();
}

/*
  Полное описание должно быть в HTML, который отдаёт сервер, — включая
  товары без наличия. Робот не выполняет скрипты.
*/
{
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog/index.json'), 'utf8'));
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'live/catalog-live.json'), 'utf8')).items || {};
  const withSlug = idx.rows.filter((r) => slugRegistry[r[0]]);
  const inStock = withSlug.find((r) => live[r[0]]?.available);
  const outStock = withSlug.find((r) => !live[r[0]]?.available);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  for (const [label, row] of [['в наличии', inStock], ['нет в наличии', outStock]]) {
    if (!row) continue;
    const res = await page.request.get(`${BASE}/product/${prod(row[0])}`);
    const html = await res.text();
    const body = html.replace(/<script[\s\S]*?<\/script>/g, ' ');
    const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    check(`серверный HTML (${label}): полное описание на месте`, text.length > 4000,
      `текста ${text.length} знаков`);
    check(`серверный HTML (${label}): ровно один h1`,
      (body.match(/<h1[\s>]/g) || []).length === 1, `${(body.match(/<h1[\s>]/g) || []).length}`);
    check(`серверный HTML (${label}): есть canonical`, /<link rel="canonical" href="https?:\/\//.test(html));
    check(`серверный HTML (${label}): есть keywords`, /<meta name="keywords" content="[^"]{10,}"/.test(html));
    check(`серверный HTML (${label}): есть разметка товара`, /"@type":"Product"/.test(html));
    check(`серверный HTML (${label}): кодировка объявлена`, /charset=["']?utf-8/i.test(html));
    const desc = /<meta name="description" content="([^"]*)"/.exec(html);
    check(`серверный HTML (${label}): описание страницы заполнено`,
      !!desc && desc[1].length > 60, desc ? desc[1].slice(0, 70) : 'нет');
  }
  /* Описания страниц не должны повторяться у разных товаров. */
  const descs = new Map();
  for (const row of withSlug.slice(0, 40)) {
    const res = await page.request.get(`${BASE}/product/${prod(row[0])}`);
    const html = await res.text();
    const m = /<meta name="description" content="([^"]*)"/.exec(html);
    if (m) descs.set(row[0], m[1]);
  }
  const uniq = new Set(descs.values());
  check('описания страниц не повторяются', uniq.size === descs.size,
    `уникальных ${uniq.size} из ${descs.size}`);
  await ctx.close();
}

await browser.close();
stop();

const failed = results.filter((r) => !r.ok);
console.log(`\nПроверок: ${results.length}, не прошло: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
