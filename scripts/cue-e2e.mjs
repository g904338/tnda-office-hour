// End-to-end walk through Cue in a real browser, against the production
// build in demo mode (the same scheduler engine as the cloud, simulated).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/cue-e2e.mjs http://localhost:4173/cue/
//
// Exits non-zero on the first failed step, on any page error, or when a
// screen scrolls sideways on a phone.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173/cue/';
const problems = [];
let step = '';
let current = null;

function check(cond, msg) {
  if (!cond) throw new Error(`${step}: ${msg}`);
}

async function run(name, fn) {
  step = name;
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    if (current) await current.screenshot({ path: 'e2e-failure.png', fullPage: true }).catch(() => {});
    throw e;
  }
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}

const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : process.env.CI ? {} : { channel: 'chrome' };
const browser = await chromium.launch(launch);
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function session(viewport, opts = {}) {
  const ctx = await browser.newContext({
    viewport,
    isMobile: Boolean(opts.mobile),
    hasTouch: Boolean(opts.mobile),
    deviceScaleFactor: 1,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    colorScheme: opts.scheme ?? 'light',
  });
  const page = await ctx.newPage();
  current = page;
  page.on('pageerror', (e) => problems.push(`[${step}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) problems.push(`[${step}] console: ${m.text()}`);
  });
  return { ctx, page };
}

async function noSideScroll(page, where) {
  const over = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  check(over <= 1, `${where} scrolls sideways by ${over}px`);
}

async function axe(page, name) {
  // let fade-ins finish: half-transparent text would be reported as low contrast
  await page.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
      new Promise((r) => setTimeout(r, 1500)),
    ]),
  );
  await page.evaluate(axeSource);
  const r = await page.evaluate(async () =>
    // @ts-ignore
    window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }),
  );
  const bad = r.violations.filter((v) => ['serious', 'critical', 'moderate'].includes(v.impact));
  for (const v of bad) {
    problems.push(`[a11y ${name}] ${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }
}

const toast = (page, text) => page.locator('.toasts').getByText(text).first().waitFor({ timeout: 8000 });
const dialog = (page) => page.getByRole('dialog').last();

// a date a few days ahead, written the way people write it
function ahead(days) {
  const d = new Date(Date.now() + days * 86400000 + 8 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

try {
  console.log('desktop');
  const { ctx, page } = await session({ width: 1440, height: 900 });

  await run('landing page and live try-it', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: /準時登場/ }).waitFor();
    await page.getByRole('group', { name: '範例' }).getByRole('button', { name: '考試' }).click();
    await page.locator('.tryit .found').getByText('考試').waitFor();
    await page.getByLabel('試著貼上一段公告').fill(`【專題發表】\n${ahead(9)} 下午 2:10 在設計學院 B1 創意基地`);
    await page.locator('.tryit .dc-title').getByText('專題發表').waitFor();
    await page.locator('.tryit .found').getByText('設計學院 B1 創意基地').waitFor();
    await axe(page, 'landing');
  });

  await run('connect form validates before talking to GitHub', async () => {
    await page.getByRole('link', { name: '連接 GitHub 正式使用' }).click();
    await page.getByRole('heading', { name: '連接你的 GitHub' }).waitFor();
    await page.getByLabel('Repository').fill('not a repo');
    await page.getByText('格式是 帳號/名稱').waitFor();
    check(await page.getByRole('button', { name: '連接', exact: true }).isDisabled(), 'connect should wait for a repo and token');
    await axe(page, 'connect');
    await page.getByRole('button', { name: '先用示範' }).click();
  });

  await run('demo opens on the overview', async () => {
    await page.getByRole('heading', { name: /今天要發什麼/ }).waitFor();
    await page.getByText('下一則公告').waitFor();
    check((await page.locator('.stat').count()) === 4, 'four counters');
    await axe(page, 'overview');
  });

  await run('paste on the overview, schedule a reminder series', async () => {
    await page.getByLabel('有新公告？直接貼上').fill(`作業四：使用者測試報告\n繳交期限：${ahead(6)} 23:59\n上傳到 Moodle 作業區\n遲交一天扣 10 分`);
    await page.getByRole('button', { name: '整理' }).click();
    await page.getByRole('heading', { name: '貼上，就整理好' }).waitFor();
    check((await page.getByLabel('標題').inputValue()) === '作業四：使用者測試報告', 'title from the first line');
    await page.locator('.compose-preview .dc-title').getByText('作業四：使用者測試報告').waitFor();
    await page.locator('.compose-preview .dc-fname').getByText('截止時間').first().waitFor();
    // the homework defaults: now + evening before + 3 hours before
    const submit = page.getByRole('button', { name: /^排程 \d+ 則$/ });
    const label = await submit.textContent();
    check(/排程 [23] 則/.test(label ?? ''), `expected a reminder series, got ${label}`);
    await axe(page, 'compose');
    await submit.click();
    await page.getByRole('heading', { name: '發文紀錄' }).waitFor();
    check((await page.locator('.post-row', { hasText: '作業四：使用者測試報告' }).count()) >= 1, 'new posts listed');
  });

  await run('send right away and see it delivered', async () => {
    await page.keyboard.press('n');
    await page.getByRole('heading', { name: '貼上，就整理好' }).waitFor();
    await page.getByLabel('原文').fill('【E2E 臨時通知】\n今天下午的課照常上課，記得帶筆電');
    // everything about "today" is already due: it goes out now
    await page.getByRole('button', { name: '立即發送' }).click();
    await page.getByRole('heading', { name: '發文紀錄' }).waitFor();
    await page.goto(base + '#/posts/sent', { waitUntil: 'domcontentloaded' });
    await page.locator('.post-row', { hasText: 'E2E 臨時通知' }).first().waitFor({ timeout: 10000 });
  });

  await run('open a sent post and retract it', async () => {
    await page.locator('.post-row.st-sent', { hasText: 'E2E 臨時通知' }).first().click();
    await dialog(page).getByText('學生在 Discord 看到的').waitFor();
    await axe(page, 'post detail');
    await dialog(page).getByRole('button', { name: '從 Discord 撤回' }).click();
    await page.getByRole('dialog', { name: '從 Discord 撤回這則訊息？' }).getByRole('button', { name: '撤回', exact: true }).click();
    await dialog(page).locator('.chip.st-retracted').waitFor({ timeout: 10000 });
    await page.keyboard.press('Escape');
  });

  await run('a broken webhook fails until it is replaced', async () => {
    await page.goto(base + '#/posts/attention', { waitUntil: 'domcontentloaded' });
    await page.locator('.post-row', { hasText: 'Office Hour 時段調整' }).click();
    await dialog(page).getByText('Discord 10015').first().waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('complementary', { name: '主選單' }).getByRole('link', { name: '頻道' }).click();
    await page.locator('.ch-card', { hasText: 'office-hour' }).getByText('上次測試失敗').waitFor();
    await axe(page, 'channels');
    await page.getByRole('button', { name: '#office-hour 的更多動作' }).click();
    await page.getByRole('menuitem', { name: '編輯' }).click();
    await page.getByLabel('Webhook 網址').fill('https://discord.com/channels/123456789012345678/123456789012345678');
    await page.getByText('這是頻道連結，不是 Webhook 網址').waitFor();
    await page.getByLabel('Webhook 網址').fill('https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc');
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await toast(page, '頻道已更新');
    await page.locator('.ch-card', { hasText: 'office-hour' }).getByRole('button', { name: '傳送測試' }).click();
    await toast(page, '收到測試訊息了');
    await page.goto(base + '#/posts/attention', { waitUntil: 'domcontentloaded' });
    await page.locator('.post-row', { hasText: 'Office Hour 時段調整' }).click();
    await dialog(page).getByRole('button', { name: '重送失敗的頻道' }).click();
    await page.goto(base + '#/posts/sent', { waitUntil: 'domcontentloaded' });
    await page.locator('.post-row', { hasText: 'Office Hour 時段調整' }).waitFor({ timeout: 10000 });
  });

  await run('add a channel', async () => {
    await page.goto(base + '#/channels', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '新增頻道' }).first().click();
    await page.getByLabel('頻道名稱').fill('E2E 測試');
    await page.getByLabel('Webhook 網址').fill('https://example.com/not-a-webhook');
    await page.getByText('看起來不是 Discord Webhook 網址').waitFor();
    await page.getByLabel('Webhook 網址').fill('https://discord.com/api/webhooks/223456789012345678/ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210-_xyz');
    await page.getByRole('dialog').getByRole('button', { name: '新增頻道' }).click();
    await page.locator('.ch-card', { hasText: 'E2E 測試' }).waitFor();
  });

  await run('calendar: months, a day, drag to reschedule', async () => {
    await page.getByRole('complementary', { name: '主選單' }).getByRole('link', { name: '行事曆' }).click();
    await page.getByRole('grid').waitFor();
    await axe(page, 'calendar');
    const title = await page.locator('.cal-bar h2').textContent();
    const heading = () => page.locator('.cal-bar h2').textContent();
    await page.getByRole('link', { name: '下個月' }).click();
    await page.waitForFunction((t) => document.querySelector('.cal-bar h2')?.textContent !== t, title);
    await page.getByRole('link', { name: '上個月' }).click();
    await page.waitForFunction((t) => document.querySelector('.cal-bar h2')?.textContent === t, title);
    check((await heading()) === title, 'back to this month');
    const movable = page.locator('.cal-day:not(.past) .cal-item[draggable="true"]').first();
    if (await movable.count()) {
      const target = page.locator('.cal-day:not(.past):not(.out)').last();
      await movable.dragTo(target);
      await toast(page, '已改到');
    }
  });

  await run('settings: course details reach scheduled posts', async () => {
    await page.getByRole('complementary', { name: '主選單' }).getByRole('link', { name: '設定' }).click();
    await page.getByLabel('卡片底部文字').fill('E2E 課程 · 底部文字');
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await toast(page, '課程設定已更新');
    await axe(page, 'settings');
    await page.goto(base + '#/posts/scheduled', { waitUntil: 'domcontentloaded' });
    await page.locator('.post-row').first().click();
    await dialog(page).locator('.dc-footer', { hasText: 'E2E 課程 · 底部文字' }).waitFor();
    await page.keyboard.press('Escape');
  });

  await run('filters and search', async () => {
    await page.goto(base + '#/posts', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('搜尋').fill('期中筆試');
    const rows = page.locator('.post-row');
    await rows.first().waitFor();
    for (const t of await rows.allTextContents()) check(t.includes('期中筆試'), `search kept ${t}`);
    await page.getByLabel('搜尋').fill('zzzz 不存在');
    await page.getByText('沒有符合的貼文').waitFor();
  });
  await ctx.close();

  for (const scheme of ['light', 'dark']) {
    console.log(`phone (${scheme})`);
    const m = await session({ width: 390, height: 844 }, { mobile: true, scheme });
    await run(`phone ${scheme}: every screen fits`, async () => {
      await m.page.goto(base + '#/demo', { waitUntil: 'networkidle' });
      await m.page.getByRole('heading', { name: /今天要發什麼/ }).waitFor();
      for (const r of ['', 'compose', 'posts', 'calendar', 'channels', 'settings']) {
        await m.page.goto(base + '#/' + r, { waitUntil: 'domcontentloaded' });
        await m.page.waitForTimeout(350);
        await noSideScroll(m.page, `#/${r}`);
      }
      await axe(m.page, `phone ${scheme} settings`);
    });
    await run(`phone ${scheme}: compose from the tab bar`, async () => {
      await m.page.goto(base + '#/', { waitUntil: 'domcontentloaded' });
      await m.page.getByRole('navigation', { name: '主選單' }).getByRole('link', { name: '撰寫' }).click();
      await m.page.getByLabel('原文').fill(`${ahead(3)} 早上 9 點期中考，地點：設計學院 301`);
      await m.page.getByRole('button', { name: /^排程 \d+ 則$/ }).click();
      await m.page.getByRole('heading', { name: '發文紀錄' }).waitFor();
      await axe(m.page, `phone ${scheme} posts`);
    });
    await m.ctx.close();
  }
} finally {
  await browser.close();
}

if (problems.length) {
  console.error('\nProblems:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nCue end-to-end: all good');
