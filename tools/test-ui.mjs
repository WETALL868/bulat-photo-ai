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
const SLUG = arg('slug', 'hb-tk-8115c');
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

  /* ---------- выбор цвета ---------- */
  const variants = page.locator('.cpick-i');
  const n = await variants.count();
  check(`${device.name}: переключатель цвета показывает 4 варианта`, n === 4, `найдено ${n}`);
  if (n) {
    const current = page.locator('.cpick-i.on');
    check(`${device.name}: выбранный цвет выделен`, await current.count() === 1);
    check(`${device.name}: у выбранного проставлен aria-current`,
      await current.first().getAttribute('aria-current') === 'page');
    const hrefs = await variants.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    check(`${device.name}: у каждого цвета свой адрес`, new Set(hrefs).size === n);
    const prices = await page.locator('.cpick-p').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    check(`${device.name}: у каждого цвета своя цена`, prices.every((t) => /\d/.test(t)), prices.join(' | '));
    const imgs = await variants.evaluateAll((els) => els.map((e) => !!e.querySelector('img, .atimg')));
    check(`${device.name}: у каждого цвета своё фото`, imgs.every(Boolean));
    /* Переход на другой цвет открывает его карточку. */
    const other = variants.filter({ hasNot: page.locator('.cpick-i.on') }).first();
    const otherHref = await other.getAttribute('href');
    await other.click();
    await page.waitForURL('**' + otherHref, { timeout: 10000 }).catch(() => {});
    check(`${device.name}: нажатие на цвет открывает его карточку`, page.url().endsWith(otherHref));
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForSelector('#ptabs');
  }

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
