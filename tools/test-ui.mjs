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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SLUG = arg('slug', 'hb-tk-8115c-4100603161');
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
  await page.goto(`${BASE}/product/hb-tk-8115bk`, { waitUntil: 'networkidle' });
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
  await page.goto(`${BASE}/product/hb-tk-8115bk?tab=specs`, { waitUntil: 'networkidle' });
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

  /* Адрес удалённой повреждённой позиции не должен показывать чужой товар. */
  await page.goto(`${BASE}/product/hb-tk-8115c`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const gone = await page.locator('#app').innerText();
  check(`${device.name}: адрес удалённой упаковки не занят другим товаром`,
    /не найдена/i.test(gone), gone.split('\n')[0]);

  await page.goto(`${BASE}/product/${SLUG}?tab=reviews`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#ptabs');

  /* ---------- отзывы ---------- */
  const honest = await page.locator('[data-panel="reviews"]').innerText();
  check(`${device.name}: блок отзывов честно пуст`, honest.includes('Пока нет отзывов'));
  check(`${device.name}: нет выдуманных отзывов`, !/Покупка подтверждена/.test(honest));
  check(`${device.name}: нет пометки ДЕМО`, !/ДЕМО/.test(await page.locator('#app').innerText()));
  const headNone = await page.locator('.pmeta').innerText();
  check(`${device.name}: в шапке не стоит оценка 0,0`, !/0,0/.test(headNone), headNone.replace(/\n/g, ' '));

  /* Форма не пишет «Спасибо», не отправив ничего. */
  await page.locator('#rev-form button[type=submit]').click();
  let msg = (await page.locator('#rev-msg').innerText().catch(() => '')).trim();
  check(`${device.name}: пустая форма не принимается`, /имя/i.test(msg), msg);
  await page.fill('#rev-form input[name=name]', 'Проверка');
  await page.fill('#rev-form textarea', 'Коротко');
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

  await ctx.close();
}

await browser.close();
stop();

const failed = results.filter((r) => !r.ok);
console.log(`\nПроверок: ${results.length}, не прошло: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
