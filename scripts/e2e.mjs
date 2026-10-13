// End-to-end walk through every role, in a real browser, against the
// production build running in demo mode (the full SQL backend on PGlite).
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/e2e.mjs http://localhost:4173/
//
// Exits non-zero on the first failed step or on any page error.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173/';
const problems = [];
let step = '';

function check(cond, msg) {
  if (!cond) throw new Error(`${step}: ${msg}`);
}

async function run(name, fn) {
  step = name;
  const t0 = Date.now();
  await fn();
  console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
}

const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });

async function session(viewport, isMobile = false) {
  const ctx = await browser.newContext({
    viewport,
    isMobile,
    hasTouch: isMobile,
    deviceScaleFactor: 1,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${step}] page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) problems.push(`[${step}] console: ${m.text()}`);
  });
  page.on('dialog', (d) => d.dismiss());
  return { ctx, page };
}

const role = async (page, name) => {
  await page.locator('.demobar').getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(500);
};

try {
  console.log('desktop');
  const { ctx, page } = await session({ width: 1440, height: 900 });

  await run('welcome screen', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '輸入邀請代碼' }).waitFor();
    check(await page.getByRole('button', { name: /試玩示範/ }).isVisible(), 'demo button missing');
  });

  await run('demo boots in the browser', async () => {
    await page.getByRole('button', { name: /試玩示範/ }).click();
    await page.locator('.demobar').waitFor({ timeout: 60000 });
    await page.getByText('下一次 Office Hour').waitFor();
  });

  await run('student books a week', async () => {
    // the first week that still says 可預約
    const open = page.locator('.weeks .wk', { hasText: '可預約' }).first();
    await open.click();
    await page.getByRole('button', { name: '開始預約' }).click();
    await page.getByRole('heading', { name: /勾選可以的時段/ }).waitFor();
    const cells = page.locator('button.cell[aria-pressed="false"]');
    check((await cells.count()) >= 3, 'not enough open cells');
    await cells.nth(0).click();
    await cells.nth(3).click(); // nth re-evaluates; picks another free cell
    check((await page.locator('button.cell[aria-pressed="true"]').count()) === 2, 'two cells should be picked');
    // validation: empty topic
    await page.getByRole('button', { name: '送出預約需求' }).click();
    await page.getByText('請寫下想討論的題目').waitFor();
    await page.getByLabel('想討論的題目').fill('E2E：互動裝置的動線');
    await page.getByLabel('目前進度').fill('E2E 測試進度');
    await page.getByLabel('雲端資料夾連結').fill('not a url');
    await page.getByRole('button', { name: '送出預約需求' }).click();
    await page.getByText('請貼完整網址').waitFor();
    await page.getByLabel('雲端資料夾連結').fill('https://drive.google.com/drive/folders/e2e');
    await page.getByRole('button', { name: '送出預約需求' }).click();
    await page.getByText('E2E：互動裝置的動線').waitFor();
    await page.getByText('等待排程').first().waitFor();
  });

  await run('student edits and sees the change', async () => {
    await page.getByRole('button', { name: '修改需求' }).click();
    await page.getByLabel('想討論的題目').fill('E2E：改過的題目');
    await page.getByRole('button', { name: '更新需求' }).click();
    await page.getByText('E2E：改過的題目').waitFor();
  });

  await run('admin auto-schedules and publishes', async () => {
    await role(page, '助教');
    await page.getByRole('heading', { name: /需求/ }).first().waitFor();
    const auto = page.getByRole('button', { name: '智慧排程' });
    await auto.waitFor();
    check(await auto.isEnabled(), 'auto-schedule should be enabled with pending requests');
    await auto.click();
    await page.getByRole('dialog', { name: '智慧排程結果' }).waitFor();
    const drafts = await page.getByRole('dialog').locator('.li').count();
    check(drafts > 0, 'auto-schedule produced no drafts');
    await page.getByRole('button', { name: '直接發布' }).click();
    await page.getByRole('dialog', { name: /已發布/ }).waitFor();
    check((await page.getByRole('dialog').locator('pre').count()) > 0, 'no notice messages');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.waitForTimeout(400);
    check(!(await page.getByRole('button', { name: /發布 \d+ 筆/ }).count()), 'drafts should be gone after publish');
  });

  await run('admin assigns a slot by hand and removes it', async () => {
    const lane = page.locator('button.lane:not(.filled):not(:disabled)').first();
    await lane.click();
    const dlg = page.getByRole('dialog', { name: '安排小組' });
    await dlg.waitFor();
    const first = dlg.getByRole('button', { name: '安排' }).first();
    if (await first.count()) {
      await first.click();
    } else {
      await dlg.locator('summary').click();
      await dlg.locator('details button').first().click();
    }
    // rule breaking asks for confirmation
    const confirmBreak = page.getByRole('button', { name: '仍要安排' });
    if (await confirmBreak.isVisible().catch(() => false)) await confirmBreak.click();
    await page.locator('.lane.filled.draft').first().waitFor();
    await page.locator('.lane.filled.draft').first().click();
    await page.getByRole('button', { name: '移除草稿' }).click();
    await page.waitForTimeout(400);
  });

  await run('admin pages render', async () => {
    for (const [label, heading] of [
      ['總覽與紀錄', '本學期的 Office Hour'],
      ['小組與邀請', /個小組/],
      ['老師', '叁式 PM'],
      ['時段與週次', '什麼時候可以約'],
      ['設定', '課程與規則'],
    ]) {
      await page.getByRole('link', { name: label }).click();
      await page.getByRole('heading', { name: heading }).first().waitFor();
    }
  });

  await run('admin changes a setting', async () => {
    await page.getByLabel('給學生的公告').fill('E2E 公告：下週改到 Discord 大廳');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await page.getByText('設定已儲存').waitFor();
  });

  await run('admin adds availability and a holiday', async () => {
    await page.getByRole('link', { name: '時段與週次' }).click();
    await page.getByRole('button', { name: '新增時段' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('星期').selectOption('6');
    await d.getByLabel('開始').selectOption('13:00');
    await d.getByLabel('結束').selectOption('14:00');
    await d.getByRole('button', { name: '儲存' }).click();
    await page.getByText('已儲存時段').waitFor();
    await page.getByText('週六').waitFor();
    await page.getByRole('button', { name: '新增休息日' }).click();
    await page.getByRole('dialog').getByLabel('說明').fill('E2E 休息');
    await page.getByRole('dialog').getByRole('button', { name: '儲存' }).click();
    await page.getByText('E2E 休息').waitFor();
  });

  await run('admin opens the QR wall', async () => {
    await page.getByRole('link', { name: '小組與邀請' }).click();
    await page.getByRole('button', { name: '投影邀請 QR' }).click();
    await page.getByRole('dialog').locator('.qr svg').first().waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '關閉' }).click();
  });

  await run('student sees the notice and the published session', async () => {
    await role(page, '學生');
    await page.getByText('E2E 公告').waitFor();
    check(await page.locator('.hero').isVisible(), 'hero missing');
  });

  await run('teacher sees sessions', async () => {
    await role(page, '老師');
    await page.getByRole('heading', { name: '我的場次' }).waitFor();
    await page.getByText('這兩週全部場次').waitFor();
  });

  await ctx.close();

  console.log('mobile');
  const m = await session({ width: 390, height: 844 }, true);
  await run('mobile demo + booking grid', async () => {
    await m.page.goto(base + '#/demo', { waitUntil: 'domcontentloaded' });
    await m.page.locator('.demobar').waitFor({ timeout: 60000 });
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    await m.page.locator('.weeks .wk', { hasText: '可預約' }).first().click();
    await m.page.getByRole('button', { name: '開始預約' }).click();
    await m.page.locator('button.cell').first().tap();
    check((await m.page.locator('button.cell[aria-pressed="true"]').count()) === 1, 'tap should pick a cell');
    const overflow2 = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow2 <= 0, `booking page scrolls sideways by ${overflow2}px`);
  });
  await run('mobile admin shows one day at a time', async () => {
    await role(m.page, '助教');
    await m.page.locator('.matrix').waitFor();
    const cols = await m.page.locator('.matrix .mh').count();
    check(cols === 1, `expected 1 day column, got ${cols}`);
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `admin page scrolls sideways by ${overflow}px`);
  });
  await m.ctx.close();
} catch (e) {
  problems.push(String(e?.stack ?? e));
} finally {
  await browser.close();
}

if (problems.length) {
  console.error('\nE2E FAILED');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nE2E passed');
