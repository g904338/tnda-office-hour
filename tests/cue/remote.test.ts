// The GitHub backend against an in-memory GitHub.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { defaultConfig, emptyContent } from '../../src/cue/core/model';
import { addPosts, makePost } from '../../src/cue/core/ops';
import { base64ToUtf8, bytesToBase64, utf8ToBase64 } from '../../src/cue/data/crypto';
import { GitHubError, parseRepo, repoFromPagesUrl, tokenTemplateUrl } from '../../src/cue/data/github';
import { GitHubBackend, NotInitialized } from '../../src/cue/data/remote';

const ref = { owner: 'o', repo: 'r', branch: 'cue-data' };
let files: Record<string, { sha: string; text: string }> | null;
let secrets: Record<string, string>;
let dispatches: any[];
let staleOnce: { sha: string; text: string } | null;
let seq = 0;
let keys: { publicKey: Uint8Array; privateKey: Uint8Array };

function server() {
  return vi.fn(async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    const path = u.pathname.replace('/repos/o/r', '');
    const auth = init.headers?.Authorization;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    if (auth !== 'Bearer good') return json(401, { message: 'Bad credentials' });
    if (path === '' && method === 'GET') return json(200, { full_name: 'o/r', default_branch: 'main', private: false, html_url: 'https://github.com/o/r' });
    if (path === '/branches/cue-data') return files ? json(200, { name: 'cue-data' }) : json(404, { message: 'Branch not found' });
    if (path.startsWith('/contents/')) {
      const name = path.slice('/contents/'.length);
      if (method === 'GET') {
        if (!files?.[name]) return json(404, { message: 'Not Found' });
        const f = name === 'posts.json' && staleOnce ? staleOnce : files[name];
        if (name === 'posts.json') staleOnce = null;
        const etag = `"${f.sha}"`;
        if (init.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304 });
        return json(200, { sha: f.sha, encoding: 'base64', content: utf8ToBase64(f.text) }, { ETag: etag });
      }
      const body = JSON.parse(init.body);
      if ((files![name]?.sha ?? null) !== (body.sha ?? null)) return json(409, { message: 'is at abc but expected def' });
      files![name] = { sha: `s${++seq}`, text: base64ToUtf8(body.content) };
      return json(200, { content: { sha: files![name].sha } });
    }
    if (path === '/git/trees') return json(201, { sha: 'tree1' });
    if (path === '/git/commits') return json(201, { sha: 'commit1' });
    if (path === '/git/refs') {
      files = {};
      return json(201, { ref: 'refs/heads/cue-data' });
    }
    if (path === '/actions/secrets/public-key') return json(200, { key_id: 'k1', key: bytesToBase64(keys.publicKey) });
    if (path.startsWith('/actions/secrets/') && method === 'PUT') {
      const body = JSON.parse(init.body);
      const opened = sodium.crypto_box_seal_open(sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey);
      secrets[path.split('/').pop()!] = sodium.to_string(opened);
      return new Response(null, { status: 201 });
    }
    if (path === '/actions/secrets') return json(200, { total_count: Object.keys(secrets).length, secrets: Object.keys(secrets).map((name) => ({ name })) });
    if (path === '/actions/workflows/cue-scheduler.yml') return json(200, { state: 'active', html_url: 'https://github.com/o/r/actions/workflows/cue-scheduler.yml' });
    if (path === '/actions/workflows/cue-scheduler.yml/dispatches') {
      dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (path === '/actions/workflows/cue-scheduler.yml/runs')
      return json(200, { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', event: 'schedule', created_at: '2026-10-14T02:00:00Z', updated_at: '2026-10-14T02:00:20Z', html_url: 'https://x' }] });
    return json(404, { message: `no route ${method} ${path}` });
  });
}

beforeEach(async () => {
  await sodium.ready;
  keys = sodium.crypto_box_keypair() as any;
  files = null;
  secrets = {};
  dispatches = [];
  staleOnce = null;
  vi.stubGlobal('fetch', server());
});
afterEach(() => vi.unstubAllGlobals());

async function initialised() {
  await GitHubBackend.initialize('good', ref, { ...defaultConfig('2026-10-01T00:00:00+08:00'), course: 'TN0006' }, 1);
  // the fake refs endpoint does not see the tree; write what initialize sent
  files = {
    'config.json': { sha: 'c1', text: JSON.stringify({ ...defaultConfig('2026-10-01T00:00:00+08:00'), course: 'TN0006' }) },
    'posts.json': { sha: 'p1', text: JSON.stringify({ version: 1, posts: [] }) },
  };
}

describe('GitHub backend', () => {
  test('a repository without the data branch asks to be initialised', async () => {
    await expect(new GitHubBackend('good', ref).load()).rejects.toBeInstanceOf(NotInitialized);
  });

  test('bad tokens say so', async () => {
    const e = await new GitHubBackend('bad', ref).load().catch((x) => x);
    expect(e).toBeInstanceOf(GitHubError);
    expect(e.code).toBe('auth');
  });

  test('initialise creates an orphan branch with both files and a README', async () => {
    await GitHubBackend.initialize('good', ref, undefined, 1);
    const calls = (fetch as any).mock.calls.map((c: any[]) => [c[1]?.method ?? 'GET', new URL(c[0]).pathname]).slice(0, 3);
    expect(calls).toEqual([
      ['POST', '/repos/o/r/git/trees'],
      ['POST', '/repos/o/r/git/commits'],
      ['POST', '/repos/o/r/git/refs'],
    ]);
    const tree = JSON.parse((fetch as any).mock.calls[0][1].body).tree.map((t: any) => t.path);
    expect(tree).toEqual(['config.json', 'posts.json', 'README.md']);
    expect(JSON.parse((fetch as any).mock.calls[1][1].body).parents).toEqual([]);
  });

  test('loads, saves, and re-applies a change over someone else’s', async () => {
    await initialised();
    const b = new GitHubBackend('good', ref);
    const snap = await b.load();
    expect(snap.config.course).toBe('TN0006');
    // another device adds a post behind our back
    const cfg = snap.config;
    const theirs = makePost({ content: { ...emptyContent(), title: '他們的' }, style: 'embed', mention: { type: 'none' }, channels: [], at: null, rule: null, label: null, series: null, source: '' }, cfg, 0);
    files!['posts.json'] = { sha: 'other', text: JSON.stringify({ version: 1, posts: [theirs] }) };
    const mine = makePost({ content: { ...emptyContent(), title: '我的' }, style: 'embed', mention: { type: 'none' }, channels: [], at: null, rule: null, label: null, series: null, source: '' }, cfg, 0);
    const after = await b.commit({ message: '新增', posts: (p) => addPosts(p, [mine]) });
    expect(after.posts.posts.map((p) => p.content.title)).toEqual(['他們的', '我的']);
    expect(JSON.parse(files!['posts.json'].text).posts.map((p: any) => p.content.title)).toEqual(['他們的', '我的']);
  });

  test('an older copy served by a cache does not replace newer data', async () => {
    await initialised();
    const b = new GitHubBackend('good', ref);
    const snap = await b.load();
    const old = files!['posts.json'];
    const p = makePost({ content: { ...emptyContent(), title: '新的' }, style: 'embed', mention: { type: 'none' }, channels: [], at: null, rule: null, label: null, series: null, source: '' }, snap.config, 0);
    await b.commit({ message: '新增', posts: (x) => addPosts(x, [p]) });
    staleOnce = old;
    const again = await b.refresh();
    expect(again.posts.posts.map((x) => x.content.title)).toEqual(['新的']);
  });

  test('webhooks go into encrypted secrets; the scheduler is dispatched on the default branch', async () => {
    await initialised();
    const b = new GitHubBackend('good', ref);
    await b.load();
    const ch = { id: 'ch_a', secret: 'CUE_WEBHOOK_CH_A' } as any;
    await b.saveWebhook(ch, 'https://discord.com/api/webhooks/1/abc');
    expect(secrets).toEqual({ CUE_WEBHOOK_CH_A: 'https://discord.com/api/webhooks/1/abc' });
    expect([...(await b.webhooks())]).toEqual(['CUE_WEBHOOK_CH_A']);
    await b.testChannel(ch, 'req9');
    await b.kick('send-now');
    expect(dispatches).toEqual([
      { ref: 'main', inputs: { reason: 'test', test: 'ch_a:req9' } },
      { ref: 'main', inputs: { reason: 'send-now' } },
    ]);
    const st = await b.scheduler();
    expect(st).toMatchObject({ installed: true, enabled: true, lastRun: { ok: true, running: false } });
  });
});

describe('repository helpers', () => {
  test('owner/repo from a Pages address or a URL', () => {
    expect(repoFromPagesUrl('https://g904338.github.io/tnda-office-hour/cue/#/')).toEqual({ owner: 'g904338', repo: 'tnda-office-hour' });
    expect(repoFromPagesUrl('http://localhost:5173/cue/')).toBeNull();
    expect(parseRepo('https://github.com/g904338/tnda-office-hour.git')).toEqual({ owner: 'g904338', repo: 'tnda-office-hour' });
    expect(parseRepo('g904338/tnda-office-hour')).toEqual({ owner: 'g904338', repo: 'tnda-office-hour' });
    expect(parseRepo('nope')).toBeNull();
  });
  test('token template link', () => {
    const u = new URL(tokenTemplateUrl('tnda-office-hour'));
    expect(u.pathname).toBe('/settings/personal-access-tokens/new');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ contents: 'write', actions: 'write', secrets: 'write' });
  });
});
