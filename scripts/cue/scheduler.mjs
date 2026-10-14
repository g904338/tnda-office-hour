#!/usr/bin/env node
// Cue's scheduler. GitHub Actions runs it every few minutes (and right away
// when someone presses "send now"). It reads the data branch, sends what is
// due to Discord, and writes back what happened. Webhook URLs come from the
// repository's encrypted secrets and never touch the data branch.
//
//   GITHUB_TOKEN, GITHUB_REPOSITORY   provided by Actions
//   CUE_SECRETS                       ${{ toJSON(secrets) }}
//   CUE_BRANCH                        data branch (default cue-data)
//   CUE_TEST                          "<channelId>:<requestId>" sends a test message
//   CUE_LOOKAHEAD_MINUTES             wait for posts due this soon (default 8)
//   CUE_DRY_RUN=1                     pretend to send (for trying it out)

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as E from './engine.mjs';

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({
  env = process.env,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  sleep = sleepReal,
  out = console,
} = {}) {
  const API = env.GITHUB_API_URL || 'https://api.github.com';
  const TOKEN = env.GITHUB_TOKEN;
  const [OWNER, REPO] = String(env.GITHUB_REPOSITORY || '').split('/');
  const BRANCH = env.CUE_BRANCH || 'cue-data';
  const RUN_ID = env.GITHUB_RUN_ID || `local-${now()}`;
  const LOOKAHEAD = Math.min(15, Math.max(0, Number(env.CUE_LOOKAHEAD_MINUTES ?? 8))) * 60000;
  const DRY = env.CUE_DRY_RUN === '1';
  const started = now();
  const summary = [];
  let failures = 0;

  if (!TOKEN || !OWNER || !REPO) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');

  const secrets = (() => {
    try {
      const o = JSON.parse(env.CUE_SECRETS || '{}');
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toUpperCase(), v]));
    } catch {
      return {};
    }
  })();

  // ---------------------------------------------------------------- GitHub

  async function gh(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${API}/repos/${OWNER}/${REPO}${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'cue-scheduler',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt < 3) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw e;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, data };
    }
  }

  async function readFile(name) {
    const r = await gh('GET', `/contents/${name}?ref=${encodeURIComponent(BRANCH)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`read ${name}: ${r.status} ${r.data?.message ?? ''}`);
    let content = r.data.content;
    if (r.data.encoding !== 'base64' || !content) content = (await gh('GET', `/git/blobs/${r.data.sha}`)).data.content;
    return { sha: r.data.sha, data: JSON.parse(Buffer.from(content, 'base64').toString('utf8')) };
  }

  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

  /** Read-modify-write that re-applies `fn` when someone else wrote first. */
  async function update(name, fn, message) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await readFile(name);
      if (!cur) throw new Error(`${name} disappeared`);
      const next = fn(cur.data);
      if (JSON.stringify(next) === JSON.stringify(cur.data)) return cur.data;
      const r = await gh('PUT', `/contents/${name}`, {
        message,
        content: Buffer.from(json(next), 'utf8').toString('base64'),
        sha: cur.sha,
        branch: BRANCH,
      });
      if (r.status === 200 || r.status === 201) return next;
      if (r.status === 409 || r.status === 422) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw new Error(`write ${name}: ${r.status} ${r.data?.message ?? ''}`);
    }
    throw new Error(`could not save ${name}: it kept changing`);
  }

  // --------------------------------------------------------------- Discord

  const infoCache = new Map();
  async function webhookInfo(url) {
    if (DRY) return { guild: '0', channel: '0', name: 'dry run' };
    if (infoCache.has(url)) return infoCache.get(url);
    let info = null;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'cue-scheduler' } });
      if (res.ok) {
        const j = await res.json();
        info = { guild: j.guild_id ?? undefined, channel: j.channel_id ?? undefined, name: j.name ?? undefined };
      }
    } catch {
      info = null;
    }
    infoCache.set(url, info);
    return info;
  }

  async function discord(method, url, payload) {
    if (DRY) return { ok: true, status: 200, body: { id: `dry-${now()}`, channel_id: '0' } };
    for (let attempt = 0; attempt < 5; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'cue-scheduler (https://github.com, 1.0)' },
          body: payload ? JSON.stringify(payload) : undefined,
        });
      } catch {
        if (attempt < 2) {
          await sleep(1500);
          continue;
        }
        return { ok: false, status: 0, body: null };
      }
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await sleep(Math.min(30, Number(j.retry_after) || 1) * 1000 + 250);
        continue;
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body };
    }
    return { ok: false, status: 429, body: null };
  }

  function hookFor(config, channelId) {
    const channel = config.channels.find((c) => c.id === channelId);
    if (!channel) return { error: '頻道已被刪除' };
    const url = secrets[String(channel.secret || '').toUpperCase()];
    if (!url) return { channel, error: '這個頻道還沒有設定 Webhook' };
    return { channel, url: String(url).trim().replace(/\/+$/, '').replace(/\?.*$/, '') };
  }

  async function sendTo(config, post, channelId) {
    const h = hookFor(config, channelId);
    if (!h.url) return { ok: false, error: h.error };
    const r = await discord('POST', `${h.url}?wait=true`, E.payloadFor(post, h.channel, config));
    if (!r.ok) return { ok: false, error: E.discordError(r.status, r.body) };
    const info = r.body?.guild_id ? null : await webhookInfo(h.url);
    return { ok: true, messageId: r.body?.id, discordChannel: r.body?.channel_id ?? info?.channel, guild: r.body?.guild_id ?? info?.guild };
  }

  // ----------------------------------------------------------------- work

  let configFile = await readFile('config.json');
  let postsFile = await readFile('posts.json');
  if (!configFile || !postsFile) {
    out.log(`No Cue data on branch "${BRANCH}" yet; nothing to do.`);
    return { failures: 0, summary };
  }
  let config = configFile.data;
  const tz = config.timezone || 'Asia/Taipei';
  const when = (ms) => E.isoLocal(ms, tz).slice(5, 16).replace('T', ' ');
  const titleOf = (p) => p.content?.title || '（無標題）';

  // a test message for one channel
  const test = String(env.CUE_TEST || '').trim();
  if (test) {
    const [channelId, requestId = 'test'] = test.split(':');
    const h = hookFor(config, channelId);
    let result;
    if (!h.url) {
      result = { ok: false, error: h.error };
    } else {
      const r = await discord('POST', `${h.url}?wait=true`, E.testPayload(h.channel, config));
      const info = r.ok ? await webhookInfo(h.url) : null;
      result = r.ok
        ? { ok: true, discord: { ...(info?.name ? { name: info.name } : {}), channel: r.body?.channel_id ?? info?.channel, guild: r.body?.guild_id ?? info?.guild } }
        : { ok: false, error: E.discordError(r.status, r.body) };
    }
    config = await update('config.json', (c) => E.recordTest(c, channelId, requestId, result, now()), `Cue：測試 #${h.channel?.name ?? channelId}${result.ok ? ' 成功' : ' 失敗'}`);
    summary.push(`| ${when(now())} | 連線測試 | #${h.channel?.name ?? channelId} | ${result.ok ? '✅ 成功' : `❌ ${result.error}`} |`);
  }

  async function pass() {
    const t = now();
    let posts = postsFile.data;

    // claims a crashed run never finished
    if (posts.posts.some((p) => p.status === 'sending')) {
      posts = await update('posts.json', (p) => E.releaseStuck(p, config, t), 'Cue：釋放中斷的發送');
    }

    const { due, stale, requests } = E.triage(posts, config, t);

    if (stale.length) {
      const ids = new Set(stale.map((p) => p.id));
      posts = await update('posts.json', (p) => E.markMissed(p, ids, config, t), `Cue：${stale.length} 則錯過發送時間`);
      for (const p of stale) summary.push(`| ${when(Date.parse(p.at))} | ${titleOf(p)} | — | ⏭️ 錯過時間，未送出 |`);
    }

    // retract or edit messages already in Discord
    for (const post of requests) {
      const type = post.request.type;
      const results = {};
      for (const d of post.deliveries.filter((x) => x.status === 'sent' && x.messageId)) {
        const h = hookFor(config, d.channel);
        if (!h.url) {
          results[d.channel] = { ok: false, error: h.error };
          continue;
        }
        const url = `${h.url}/messages/${d.messageId}`;
        let r;
        if (type === 'delete') {
          r = await discord('DELETE', url);
          // already gone counts as done
          if (!r.ok && r.body?.code === 10008) r = { ok: true };
        } else {
          const { username: _u, avatar_url: _a, ...edit } = E.payloadFor(post, h.channel, config);
          r = await discord('PATCH', url, edit);
        }
        results[d.channel] = r.ok ? { ok: true } : { ok: false, error: E.discordError(r.status, r.body) };
      }
      posts = await update('posts.json', (p) => E.recordRequest(p, post.id, type, results, config, now()), `Cue：${type === 'delete' ? '撤回' : '更新'}「${titleOf(post)}」`);
      const bad = Object.values(results).filter((r) => !r.ok).length;
      summary.push(`| ${when(now())} | ${titleOf(post)} | ${Object.keys(results).length} 個頻道 | ${type === 'delete' ? '🗑️ 撤回' : '✏️ 更新'}${bad ? `（${bad} 個失敗）` : ''} |`);
    }

    if (due.length) {
      const ids = new Set(due.map((p) => p.id));
      posts = await update('posts.json', (p) => E.claim(p, ids, config, t, RUN_ID), `Cue：開始發送 ${due.length} 則`);
      for (const id of E.claimedBy(posts, RUN_ID)) {
        const post = posts.posts.find((p) => p.id === id);
        const results = {};
        for (const c of E.pendingChannels(post)) results[c] = await sendTo(config, post, c);
        posts = await update('posts.json', (p) => E.recordSend(p, id, results, config, now()), `Cue：送出「${titleOf(post)}」`);
        for (const [c, r] of Object.entries(results)) {
          const ch = config.channels.find((x) => x.id === c);
          if (!r.ok) failures++;
          summary.push(`| ${when(Date.parse(post.at))} | ${titleOf(post)} | #${ch?.name ?? c} | ${r.ok ? '✅ 已送出' : `❌ ${r.error}`} |`);
        }
        if (!post.channels.length) failures++;
      }
    }
    postsFile = { ...postsFile, data: posts };
    return E.triage(posts, config, now()).next;
  }

  let next = await pass();
  // wait for posts due in the next few minutes, so they go out on the minute
  while (next !== null && next - now() <= LOOKAHEAD && now() - started < 14 * 60000) {
    const wait = Math.max(0, next - now()) + 1000;
    out.log(`Next post at ${new Date(next).toISOString()}, waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait);
    postsFile = (await readFile('posts.json')) ?? postsFile;
    configFile = (await readFile('config.json')) ?? configFile;
    config = configFile.data;
    next = await pass();
  }

  if (summary.length) {
    const table = ['### Cue 排程器', '', '| 時間 | 貼文 | 頻道 | 結果 |', '|---|---|---|---|', ...summary, ''].join('\n');
    out.log(table);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`);
  } else {
    out.log('Nothing was due.');
  }
  return { failures, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then(({ failures }) => {
      // a failed run makes GitHub email the repository owner
      if (failures) {
        console.error(`${failures} message(s) could not be sent. See the table above.`);
        process.exitCode = 1;
      }
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
