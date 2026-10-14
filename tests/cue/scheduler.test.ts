// The cloud scheduler against an in-memory GitHub and Discord.
import { beforeEach, describe, expect, test } from 'vitest';
import * as E from '../../scripts/cue/engine.mjs';
import { run } from '../../scripts/cue/scheduler.mjs';
import { defaultConfig, emptyContent, type Config, type Post, type Posts } from '../../src/cue/core/model';
import { makePost } from '../../src/cue/core/ops';
import { zoned } from '../../src/cue/core/time';
import { base64ToUtf8, utf8ToBase64 } from '../../src/cue/data/crypto';

const TPE = 'Asia/Taipei';
const T0 = zoned(2026, 10, 14, 20, 0, TPE);
const HOOK_A = 'https://discord.com/api/webhooks/111111111111111111/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOOK_B = 'https://discord.com/api/webhooks/222222222222222222/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function config(): Config {
  const c = defaultConfig('2026-10-01T00:00:00+08:00');
  c.course = 'TN0006';
  c.channels = [
    { id: 'ch_a', name: '公告', emoji: '📢', color: '#5865f2', note: '', secret: 'CUE_WEBHOOK_CH_A', webhookSavedAt: null, webhookHint: '', username: '助教', avatar: '', mention: { type: 'none' }, discord: null, test: null },
    { id: 'ch_b', name: '作業', emoji: '📝', color: '#f59e0b', note: '', secret: 'CUE_WEBHOOK_CH_B', webhookSavedAt: null, webhookHint: '', username: '', avatar: '', mention: { type: 'none' }, discord: null, test: null },
    { id: 'ch_c', name: '沒有網址', emoji: '💬', color: '#888888', note: '', secret: 'CUE_WEBHOOK_CH_C', webhookSavedAt: null, webhookHint: '', username: '', avatar: '', mention: { type: 'none' }, discord: null, test: null },
  ];
  return c;
}

function post(cfg: Config, title: string, at: number | null, channels: string[], now = T0 - 3600_000): Post {
  return makePost(
    { content: { ...emptyContent('notice'), title }, style: 'embed', mention: { type: 'none' }, channels, at, rule: null, label: null, series: null, source: '' },
    cfg,
    now,
  );
}

// ---- fakes
let files: Record<string, { sha: string; text: string }>;
let sent: Array<{ method: string; url: string; body: any }>;
let discordStatus: (url: string) => number;
let writes: number;
let conflictOnce: boolean;
let clock: number;

function fakeFetch() {
  return async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://api.github.com/repos/o/r/contents/')) {
      const name = url.split('/contents/')[1].split('?')[0];
      if (method === 'GET') {
        const f = files[name];
        return f ? json(200, { sha: f.sha, encoding: 'base64', content: utf8ToBase64(f.text) }) : json(404, { message: 'Not Found' });
      }
      const body = JSON.parse(init.body);
      if (conflictOnce) {
        conflictOnce = false;
        // someone else edits the file in between
        const other = JSON.parse(files[name].text);
        other.posts.push({ ...other.posts[0], id: 'p_other', at: null, status: 'draft' });
        files[name] = { sha: `sha${++writes}`, text: JSON.stringify(other) };
        return json(409, { message: 'sha does not match' });
      }
      if (body.sha !== files[name]?.sha) return json(409, { message: 'sha does not match' });
      writes++;
      files[name] = { sha: `sha${writes}`, text: base64ToUtf8(body.content) };
      return json(200, { content: { sha: files[name].sha } });
    }
    if (url.startsWith('https://discord.com/api/webhooks/')) {
      sent.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
      const status = discordStatus(url);
      if (status === 404) return json(404, { message: 'Unknown Webhook', code: 10015 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (method === 'GET') return json(200, { guild_id: '999', channel_id: '888', name: 'Cue' });
      return json(200, { id: `m${sent.length}`, channel_id: '888' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const env = (extra: Record<string, string> = {}) => ({
  GITHUB_TOKEN: 't',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_RUN_ID: '42',
  CUE_SECRETS: JSON.stringify({ github_token: 'x', cue_webhook_ch_a: HOOK_A, CUE_WEBHOOK_CH_B: HOOK_B }),
  CUE_LOOKAHEAD_MINUTES: '8',
  ...extra,
});
const quiet = { log: () => {}, error: () => {} };
const load = () => ({ config: JSON.parse(files['config.json'].text) as Config, posts: JSON.parse(files['posts.json'].text) as Posts });
const go = (extra?: Record<string, string>) =>
  run({ env: env(extra), fetch: fakeFetch() as any, now: () => clock, sleep: async (ms: number) => void (clock += ms), out: quiet });

function seed(cfg: Config, list: Post[]) {
  files = { 'config.json': { sha: 'c0', text: JSON.stringify(cfg) }, 'posts.json': { sha: 'p0', text: JSON.stringify({ version: 1, posts: list }) } };
}

beforeEach(() => {
  sent = [];
  writes = 0;
  conflictOnce = false;
  clock = T0;
  discordStatus = () => 200;
});

describe('scheduler', () => {
  test('sends what is due, to every channel, and records it', async () => {
    const cfg = config();
    seed(cfg, [post(cfg, '現在', T0 - 60_000, ['ch_a', 'ch_b']), post(cfg, '明天', T0 + 86400_000, ['ch_a']), post(cfg, '草稿', null, ['ch_a'])]);
    const r = await go();
    expect(r.failures).toBe(0);
    const posts = load().posts.posts;
    expect(posts.map((p) => p.status)).toEqual(['sent', 'scheduled', 'draft']);
    expect(posts[0].deliveries.map((d) => [d.channel, d.status, d.discordChannel, d.guild])).toEqual([
      ['ch_a', 'sent', '888', '999'],
      ['ch_b', 'sent', '888', '999'],
    ]);
    const posted = sent.filter((s) => s.method === 'POST');
    expect(posted.map((s) => s.url)).toEqual([`${HOOK_A}?wait=true`, `${HOOK_B}?wait=true`]);
    // the channel's own bot name; nobody pinged by accident
    expect(posted[0].body.username).toBe('助教');
    expect(posted[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(posted[0].body.embeds[0].title).toBe('現在');
  });

  test('a channel without a webhook fails that channel only, and the run reports it', async () => {
    const cfg = config();
    seed(cfg, [post(cfg, '公告', T0 - 1000, ['ch_a', 'ch_c'])]);
    const r = await go();
    expect(r.failures).toBe(1);
    const p = load().posts.posts[0];
    expect(p.status).toBe('failed');
    expect(p.deliveries.map((d) => d.status)).toEqual(['sent', 'failed']);
    expect(p.deliveries[1].error).toBe('這個頻道還沒有設定 Webhook');
  });

  test('a retry only sends to the channels that failed', async () => {
    const cfg = config();
    seed(cfg, [post(cfg, '公告', T0 - 1000, ['ch_a', 'ch_b'])]);
    discordStatus = (u) => (u.startsWith(HOOK_B) ? 404 : 200);
    await go();
    let p = load().posts.posts[0];
    expect(p.deliveries.map((d) => d.status)).toEqual(['sent', 'failed']);
    expect(p.deliveries[1].error).toContain('10015');
    // the TA fixes the webhook and presses retry
    p = { ...p, status: 'scheduled', at: p.at };
    files['posts.json'] = { sha: 'x1', text: JSON.stringify({ version: 1, posts: [p] }) };
    discordStatus = () => 200;
    sent = [];
    await go();
    expect(sent.filter((s) => s.method === 'POST').map((s) => s.url)).toEqual([`${HOOK_B}?wait=true`]);
    expect(load().posts.posts[0].status).toBe('sent');
  });

  test('posts due in the next few minutes go out on the minute', async () => {
    const cfg = config();
    seed(cfg, [post(cfg, '五分鐘後', T0 + 5 * 60_000, ['ch_a']), post(cfg, '二十分鐘後', T0 + 20 * 60_000, ['ch_a'])]);
    await go();
    const posts = load().posts.posts;
    expect(posts.map((p) => p.status)).toEqual(['sent', 'scheduled']);
    // sent within a couple of seconds of its time, not up to five minutes late
    expect(Date.parse(posts[0].sentAt!) - (T0 + 5 * 60_000)).toBeLessThan(3000);
  });

  test('very late posts are marked missed instead of flooding the channel', async () => {
    const cfg = config();
    seed(cfg, [post(cfg, '昨天的提醒', T0 - 13 * 3600_000, ['ch_a'], T0 - 20 * 3600_000)]);
    await go();
    expect(load().posts.posts[0].status).toBe('missed');
    expect(sent).toEqual([]);
  });

  test('re-applies its change when someone else wrote first', async () => {
    const cfg = config();
    seed(cfg, [post(cfg, '公告', T0 - 1000, ['ch_a'])]);
    conflictOnce = true;
    await go();
    const posts = load().posts.posts;
    expect(posts.map((p) => [p.id === 'p_other' ? 'other' : 'mine', p.status])).toEqual([
      ['mine', 'sent'],
      ['other', 'draft'],
    ]);
  });

  test('retracts and edits messages already in Discord', async () => {
    const cfg = config();
    seed(cfg, [post(cfg, '公告', T0 - 1000, ['ch_a', 'ch_b'])]);
    await go();
    let p = load().posts.posts[0];
    p = { ...p, request: { type: 'delete', at: '2026-10-14T20:01:00+08:00' } };
    files['posts.json'] = { sha: 'y', text: JSON.stringify({ version: 1, posts: [p] }) };
    sent = [];
    await go();
    expect(sent.map((s) => s.method)).toEqual(['DELETE', 'DELETE']);
    p = load().posts.posts[0];
    expect(p.status).toBe('retracted');
    expect(p.request).toBeNull();
    expect(p.deliveries.map((d) => d.status)).toEqual(['deleted', 'deleted']);
  });

  test('test messages record the result on the channel', async () => {
    const cfg = config();
    seed(cfg, []);
    await go({ CUE_TEST: 'ch_a:req1' });
    expect(load().config.channels[0].test).toMatchObject({ id: 'req1', ok: true });
    expect(load().config.channels[0].discord).toEqual({ name: 'Cue', channel: '888', guild: '999' });
    await go({ CUE_TEST: 'ch_c:req2' });
    expect(load().config.channels[2].test).toMatchObject({ id: 'req2', ok: false, error: '這個頻道還沒有設定 Webhook' });
  });

  test('a run that died mid-send is not sent again', async () => {
    const cfg = config();
    const p = { ...post(cfg, '公告', T0 - 60 * 60_000, ['ch_a']), status: 'sending' as const, claim: { run: '41', at: E.isoLocal(T0 - 45 * 60_000, TPE) } };
    seed(cfg, [p]);
    await go();
    expect(load().posts.posts[0].status).toBe('failed');
    expect(sent).toEqual([]);
  });

  test('no data branch yet is not an error', async () => {
    files = {};
    await expect(go()).resolves.toMatchObject({ failures: 0 });
  });
});
