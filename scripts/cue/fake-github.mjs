// An in-memory stand-in for the parts of GitHub's REST API that Cue uses,
// plus a fake Discord. Used by scripts/cue-e2e-github.mjs to drive the real
// app (in a browser) and the real scheduler (in Node) against one shared
// pretend repository.

const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: body === null ? '' : JSON.stringify(body) });

export function fakeGitHub({ owner = 'g904338', repo = 'tnda-office-hour', token = 'github_pat_good', publicKey, keyId = 'key1', openSecret }) {
  const state = {
    dataBranch: null, // { files: { path: { sha, text } } }
    secrets: {},
    dispatches: [],
    runs: [],
    workflow: 'active',
    seq: 0,
    onDispatch: null,
  };
  const prefix = `/repos/${owner}/${repo}`;
  const sha = () => `sha${++state.seq}`.padEnd(40, '0');

  async function handle(method, url, headers = {}, body = '') {
    const u = new URL(url);
    const auth = headers.authorization ?? headers.Authorization;
    if (auth !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    if (!u.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const path = u.pathname.slice(prefix.length);
    const data = body ? JSON.parse(body) : null;

    if (path === '' && method === 'GET') return json(200, { full_name: `${owner}/${repo}`, default_branch: 'main', private: false, html_url: `https://github.com/${owner}/${repo}`, permissions: { admin: true, push: true, pull: true } });
    if (path === '/branches/cue-data') return state.dataBranch ? json(200, { name: 'cue-data' }) : json(404, { message: 'Branch not found' });

    if (path.startsWith('/contents/')) {
      const name = decodeURIComponent(path.slice('/contents/'.length));
      const files = state.dataBranch?.files;
      if (method === 'GET') {
        const f = files?.[name];
        if (!f) return json(404, { message: 'Not Found' });
        const etag = `"${f.sha}"`;
        if ((headers['if-none-match'] ?? headers['If-None-Match']) === etag) return { status: 304, headers: { etag }, body: '' };
        return json(200, { type: 'file', name, sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64').replace(/(.{60})/g, '$1\n') }, { etag });
      }
      if (method === 'PUT') {
        if (!files) return json(404, { message: 'Branch not found' });
        const cur = files[name];
        if (cur && data.sha !== cur.sha) return json(409, { message: `${name} does not match ${data.sha}` });
        if (!cur && data.sha) return json(422, { message: '"sha" was supplied but the file does not exist' });
        files[name] = { sha: sha(), text: Buffer.from(data.content, 'base64').toString('utf8'), message: data.message };
        return json(cur ? 200 : 201, { content: { name, sha: files[name].sha }, commit: { sha: sha(), message: data.message } });
      }
    }

    if (path === '/git/trees' && method === 'POST') {
      state.pendingTree = data.tree;
      return json(201, { sha: 'tree0' });
    }
    if (path === '/git/commits' && method === 'POST') return json(201, { sha: 'commit0' });
    if (path === '/git/refs' && method === 'POST') {
      if (state.dataBranch) return json(422, { message: 'Reference already exists' });
      state.dataBranch = { files: Object.fromEntries((state.pendingTree ?? []).map((t) => [t.path, { sha: sha(), text: t.content }])) };
      return json(201, { ref: data.ref });
    }

    if (path === '/actions/secrets/public-key') return json(200, { key_id: keyId, key: publicKey });
    if (path === '/actions/secrets' && method === 'GET') return json(200, { total_count: Object.keys(state.secrets).length, secrets: Object.keys(state.secrets).map((name) => ({ name })) });
    if (path.startsWith('/actions/secrets/')) {
      const name = decodeURIComponent(path.split('/').pop());
      if (method === 'PUT') {
        if (data.key_id !== keyId) return json(422, { message: 'bad key id' });
        const existed = name in state.secrets;
        state.secrets[name] = openSecret(data.encrypted_value);
        return { status: existed ? 204 : 201, headers: {}, body: '' };
      }
      if (method === 'DELETE') {
        delete state.secrets[name];
        return { status: 204, headers: {}, body: '' };
      }
    }

    const wf = '/actions/workflows/cue-scheduler.yml';
    if (path === wf) return state.workflow ? json(200, { state: state.workflow, html_url: `https://github.com/${owner}/${repo}/actions/workflows/cue-scheduler.yml` }) : json(404, { message: 'Not Found' });
    if (path === `${wf}/enable` && method === 'PUT') {
      state.workflow = 'active';
      return { status: 204, headers: {}, body: '' };
    }
    if (path === `${wf}/runs`) return json(200, { total_count: state.runs.length, workflow_runs: [...state.runs].reverse() });
    if (path === `${wf}/dispatches` && method === 'POST') {
      if (!state.workflow) return json(404, { message: 'Not Found' });
      state.dispatches.push(data);
      const run = { id: state.runs.length + 1, status: 'in_progress', conclusion: null, event: 'workflow_dispatch', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: 'https://github.com/x/actions/runs/1' };
      state.runs.push(run);
      // the "runner" picks it up a moment later
      setTimeout(async () => {
        try {
          const r = await state.onDispatch?.(data);
          run.conclusion = r?.failures ? 'failure' : 'success';
        } catch (e) {
          console.error('scheduler run failed', e);
          run.conclusion = 'failure';
        }
        run.status = 'completed';
      }, 300);
      return { status: 204, headers: {}, body: '' };
    }
    return json(404, { message: `fake GitHub has no route for ${method} ${path}` });
  }

  return { state, handle };
}

/** A Discord that accepts every webhook it knows and remembers what it got. */
export function fakeDiscord(known = new Set()) {
  const calls = [];
  let n = 0;
  async function handle(method, url, body) {
    const m = /\/api\/webhooks\/(\d+)\/([\w-]+)(\/messages\/(\d+))?/.exec(url);
    const ok = m && known.has(`${m[1]}/${m[2]}`);
    calls.push({ method, url, body: body ? JSON.parse(body) : null });
    if (!ok) return json(404, { message: 'Unknown Webhook', code: 10015 });
    if (method === 'GET') return json(200, { id: m[1], name: 'Cue', channel_id: '1290000000000000001', guild_id: '1280000000000000001' });
    if (method === 'DELETE') return { status: 204, headers: {}, body: '' };
    if (method === 'PATCH') return json(200, { id: m[4], channel_id: '1290000000000000001' });
    return json(200, { id: `13000000000000000${String(++n).padStart(2, '0')}`, channel_id: '1290000000000000001' });
  }
  return { calls, handle, known };
}

/** A fetch() for the scheduler that talks to the fakes. */
export function fakeFetch(gh, discord) {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const target = url.startsWith('https://api.github.com') ? (u, m, h, b) => gh.handle(m, u, h, b) : (u, m, _h, b) => discord.handle(m, u, b);
    const r = await target(url, method, init.headers ?? {}, init.body ?? '');
    return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
  };
}
