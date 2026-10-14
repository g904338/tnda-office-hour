// Cue for real, minus the network: the production build in a browser,
// talking to an in-memory GitHub (requests to api.github.com are answered by
// scripts/cue/fake-github.mjs), and the real cloud scheduler run in Node
// whenever the app dispatches the workflow, posting to a fake Discord.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/cue-e2e-github.mjs http://localhost:4173/cue/
import sodium from 'libsodium-wrappers';
import { chromium } from 'playwright';
import { fakeDiscord, fakeFetch, fakeGitHub } from './cue/fake-github.mjs';
import { run as runScheduler } from './cue/scheduler.mjs';

const base = process.argv[2] ?? 'http://localhost:4173/cue/';
const TOKEN = 'github_pat_11AAAAAAA0good';
const HOOK = { id: '1234567890123456789', token: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOp' };
const HOOK_URL = `https://discord.com/api/webhooks/${HOOK.id}/${HOOK.token}`;
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
async function until(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`${step}: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

await sodium.ready;
const keys = sodium.crypto_box_keypair();
const B64 = sodium.base64_variants.ORIGINAL;
const gh = fakeGitHub({
  token: TOKEN,
  publicKey: sodium.to_base64(keys.publicKey, B64),
  openSecret: (v) => sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(v, B64), keys.publicKey, keys.privateKey)),
});
const discord = fakeDiscord(new Set([`${HOOK.id}/${HOOK.token}`]));
const quiet = { log: () => {}, error: (...a) => problems.push(`[scheduler] ${a.join(' ')}`) };
gh.state.onDispatch = (d) =>
  runScheduler({
    env: {
      GITHUB_TOKEN: TOKEN,
      GITHUB_REPOSITORY: 'g904338/tnda-office-hour',
      GITHUB_RUN_ID: String(gh.state.runs.length),
      CUE_SECRETS: JSON.stringify({ github_token: 'x', ...gh.state.secrets }),
      CUE_TEST: d.inputs?.test ?? '',
      CUE_LOOKAHEAD_MINUTES: '0',
    },
    fetch: fakeFetch(gh, discord),
    out: quiet,
  });

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
  'access-control-expose-headers': 'ETag',
};

const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : process.env.CI ? {} : { channel: 'chrome' };
const browser = await chromium.launch(launch);

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const r = await gh.handle(req.method(), req.url(), req.headers(), req.postData() ?? '');
    return route.fulfill({ status: r.status, headers: { ...r.headers, ...cors }, body: r.body });
  });
  // nothing else may leave the page (Discord is only ever called by the scheduler)
  await ctx.route(/discord\.com\/api/, (route) => {
    problems.push(`[${step}] the browser called Discord directly: ${route.request().url()}`);
    return route.abort();
  });
  const page = await ctx.newPage();
  current = page;
  page.on('pageerror', (e) => problems.push(`[${step}] page error: ${e.message}`));
  page.on('console', (m) => {
    // 404 (no data branch yet), 409 (a write raced the scheduler and was re-applied) and 401 are expected answers
    if (m.type() === 'error' && !/favicon|fonts\.g|status of (401|404|409)/.test(m.text())) problems.push(`[${step}] console: ${m.text()}`);
  });
  return { ctx, page };
}

const toast = (page, text, timeout = 20000) => page.locator('.toasts').getByText(text).first().waitFor({ timeout });
const files = () => gh.state.dataBranch?.files ?? {};
const posts = () => JSON.parse(files()['posts.json'].text).posts;
const config = () => JSON.parse(files()['config.json'].text);

try {
  const { page } = await device();

  await run('a bad token is refused with a clear message', async () => {
    await page.goto(base + '#/connect', { waitUntil: 'networkidle' });
    check((await page.getByLabel('Repository').inputValue()) === 'g904338/tnda-office-hour', 'repository prefilled');
    await page.getByLabel('存取權杖').fill('github_pat_wrong');
    await page.getByRole('button', { name: '連接', exact: true }).click();
    await page.getByText('存取權杖無效或已過期').waitFor();
  });

  await run('connect and create the data branch', async () => {
    await page.getByLabel('存取權杖').fill(TOKEN);
    await page.getByRole('button', { name: '連接', exact: true }).click();
    await page.getByRole('heading', { name: '建立 Cue 的資料分支' }).waitFor();
    await page.getByRole('button', { name: '建立資料分支' }).click();
    await page.getByRole('heading', { name: '頻道', exact: true }).waitFor();
    check(Object.keys(files()).sort().join() === 'README.md,config.json,posts.json', 'branch holds the three files');
    check(posts().length === 0, 'no posts yet');
  });

  await run('a webhook goes into an encrypted secret, never into the data', async () => {
    await page.getByRole('button', { name: '新增頻道' }).first().click();
    await page.getByLabel('頻道名稱').fill('作業繳交');
    await page.getByLabel('Webhook 網址').fill(HOOK_URL);
    await page.getByRole('dialog').getByRole('button', { name: '新增頻道' }).click();
    await page.locator('.ch-card', { hasText: '作業繳交' }).waitFor();
    const ch = config().channels[0];
    check(ch && ch.name === '作業繳交', 'channel saved in config.json');
    check(gh.state.secrets[ch.secret] === HOOK_URL, 'secret opens to the webhook URL');
    check(!JSON.stringify(gh.state.dataBranch).includes(HOOK.token), 'the webhook token must not be in the data branch');
  });

  await run('test message goes through the scheduler and comes back', async () => {
    await page.locator('.ch-card', { hasText: '作業繳交' }).getByRole('button', { name: '傳送測試' }).click();
    await toast(page, '收到測試訊息了');
    const sent = discord.calls.find((c) => c.method === 'POST' && c.body?.embeds?.[0]?.title?.includes('已經連上 Cue'));
    check(sent, 'Discord got the test message');
    check(gh.state.dispatches[0].inputs.test.startsWith(config().channels[0].id + ':'), 'dispatched with the channel');
    await page.locator('.ch-card', { hasText: '作業繳交' }).getByText('已連線').waitFor();
    // the overview's checklist now has one step left
    await page.getByRole('complementary', { name: '主選單' }).getByRole('link', { name: '總覽' }).click();
    await page.getByRole('heading', { name: '開始使用 · 3/4' }).waitFor();
  });

  await run('send a post now', async () => {
    await page.getByRole('complementary', { name: '主選單' }).getByRole('link', { name: '撰寫公告' }).click();
    await page.getByLabel('原文').fill('【E2E 雲端公告】\n今天的課照常上課，記得帶筆電');
    await page.getByRole('button', { name: '立即發送' }).click();
    await until(() => posts().some((p) => p.content.title === 'E2E 雲端公告' && p.status === 'sent'), 'the scheduler to send it');
    const msg = discord.calls.find((c) => c.method === 'POST' && c.body?.embeds?.[0]?.title === 'E2E 雲端公告');
    check(msg, 'Discord got the post');
    check(msg.body.allowed_mentions && Array.isArray(msg.body.allowed_mentions.parse), 'mentions are explicit');
    await page.goto(base + '#/posts/sent', { waitUntil: 'domcontentloaded' });
    await page.locator('.post-row', { hasText: 'E2E 雲端公告' }).waitFor({ timeout: 25000 });
  });

  await run('schedule a reminder series for later', async () => {
    await page.goto(base + '#/compose', { waitUntil: 'domcontentloaded' });
    const d = new Date(Date.now() + 5 * 86400000 + 8 * 3600000);
    await page.getByLabel('原文').fill(`作業五：期末提案\n繳交期限：${d.getUTCMonth() + 1}/${d.getUTCDate()} 23:59\n上傳到 Moodle`);
    await page.getByRole('button', { name: /^排程 \d+ 則$/ }).click();
    await page.getByRole('heading', { name: '發文紀錄' }).waitFor();
    await until(() => posts().filter((p) => p.content.title === '作業五：期末提案').length >= 2, 'the series to be saved');
    const series = posts().filter((p) => p.content.title === '作業五：期末提案');
    check(new Set(series.map((p) => p.series?.id)).size === 1, 'one series');
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(series[0].at), `times are written in Taipei time: ${series[0].at}`);
  });

  await run('retract the sent post from Discord', async () => {
    await page.goto(base + '#/posts/sent', { waitUntil: 'domcontentloaded' });
    await page.locator('.post-row', { hasText: 'E2E 雲端公告' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '從 Discord 撤回' }).click();
    await page.getByRole('dialog', { name: '從 Discord 撤回這則訊息？' }).getByRole('button', { name: '撤回', exact: true }).click();
    await until(() => posts().some((p) => p.content.title === 'E2E 雲端公告' && p.status === 'retracted'), 'the retraction');
    check(discord.calls.some((c) => c.method === 'DELETE'), 'Discord got a DELETE');
    await page.getByRole('dialog').locator('.chip.st-retracted').waitFor({ timeout: 25000 });
  });

  await run('another device joins with the device link', async () => {
    const payload = Buffer.from(JSON.stringify({ o: 'g904338', r: 'tnda-office-hour', b: 'cue-data', t: TOKEN })).toString('base64url');
    const second = await device();
    await second.page.goto(base + '#/link/' + payload, { waitUntil: 'networkidle' });
    await second.page.getByRole('heading', { name: /今天要發什麼/ }).waitFor();
    check(!second.page.url().includes(payload), 'the token is removed from the address bar');
    await second.page.goto(base + '#/posts', { waitUntil: 'domcontentloaded' });
    await second.page.locator('.post-row', { hasText: '作業五：期末提案' }).first().waitFor();
    current = page;
    await second.ctx.close();
  });

  await run('a scheduler that is not installed yet says so', async () => {
    gh.state.workflow = null;
    await page.goto(base + '#/settings', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('雲端排程器還沒安裝').first().waitFor();
    gh.state.workflow = 'active';
  });

  await run('every save is a readable commit', async () => {
    check(/^Cue：/.test(files()['posts.json'].message ?? ''), `commit message: ${files()['posts.json'].message}`);
    check(files()['posts.json'].text.startsWith('{\n  "version": 1'), 'pretty JSON');
  });
} finally {
  await browser.close();
}

if (problems.length) {
  console.error('\nProblems:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nCue with GitHub: all good');
