import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import path from 'node:path';
const OUT='/tmp/claude-0/-home-user-bulat-photo-ai/9ff3e5c2-9507-51d3-ac94-aea4d49525ee/scratchpad';
const PORT=8092;
const srv = spawn(process.execPath, [path.resolve('tools/serve.mjs'), String(PORT)], { stdio:'ignore' });
await new Promise(r=>setTimeout(r,900));
const b = await chromium.launch();
for (const [name, vp, mobile] of [['desktop',{width:1440,height:1100},false],['mobile',{width:390,height:880},true]]) {
  const ctx = await b.newContext({ viewport: vp, hasTouch: mobile, deviceScaleFactor: mobile?2:1 });
  const pg = await ctx.newPage();
  await pg.goto(`http://127.0.0.1:${PORT}/product/hb-tk-8115bk`, { waitUntil:'networkidle' });
  await pg.waitForSelector('#ptabs');
  await pg.evaluate(()=>{const c=document.querySelector('.cookie'); if(c) c.remove();});
  await pg.waitForTimeout(500);
  const info = await pg.evaluate(()=>({
    верхнихСелекторов: document.querySelectorAll('.cpick').length,
    блоковЦветов: document.querySelectorAll('.vars').length,
    плиток: document.querySelectorAll('.var').length,
    кнопокВКорзину: document.querySelectorAll('.var [data-add]').length,
    выбран: (document.querySelector('.var.on .var-c b')||{}).textContent,
    остаткиВПлитках: /\d{2,}\s*шт/.test(document.querySelector('.vars')?.innerText||''),
    заголовок: (document.querySelector('.vars-h p')||{}).innerText,
    код: (document.querySelector('.pmeta')||{}).innerText,
  }));
  console.log(name, JSON.stringify(info, null, 1));
  const vars = await pg.locator('.vars');
  await vars.scrollIntoViewIfNeeded();
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(OUT, `v47-${name}-vars.png`) });
  await ctx.close();
}
await b.close(); srv.kill();
