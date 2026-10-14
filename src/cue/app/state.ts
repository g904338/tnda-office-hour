// App-wide state: which backend we are on, the data, and how in sync it is.
// Changes are applied on screen immediately and saved in the background; if
// saving fails, the screen goes back to what the backend really has.

import { local, store } from '../../app/store';
import type { Config, Post } from '../core/model';
import type { Change, Snapshot } from '../core/ops';
import type { Backend, SyncStatus } from '../data/backend';
import { DemoBackend, resetDemo } from '../data/demo';
import { GitHubError, type RepoRef } from '../data/github';
import { GitHubBackend, NotInitialized } from '../data/remote';
import { toast } from '../../ui/toast';
import { base64ToUtf8, utf8ToBase64 } from '../data/crypto';

export interface GitHubSession extends RepoRef {
  mode: 'github';
  token: string;
}
export type Session = { mode: 'demo' } | GitHubSession;

export type Phase = 'welcome' | 'loading' | 'ready' | 'needs-init' | 'error';

export interface AppState {
  session: Session | null;
  phase: Phase;
  error: string | null;
  backend: Backend | null;
  config: Config | null;
  posts: Post[];
  sync: SyncStatus;
}

export const app = store<AppState>({
  session: null,
  phase: 'welcome',
  error: null,
  backend: null,
  config: null,
  posts: [],
  sync: { state: 'synced', at: null },
});

const SESSION_KEY = 'cue:session';
const TOKEN_KEY = 'cue:token';

export function savedSession(): Session | null {
  const s = local.get<{ mode: string; owner?: string; repo?: string; branch?: string }>(SESSION_KEY);
  if (!s) return null;
  if (s.mode === 'demo') return { mode: 'demo' };
  const token = local.get<string>(TOKEN_KEY);
  if (s.mode === 'github' && s.owner && s.repo && token) return { mode: 'github', owner: s.owner, repo: s.repo, branch: s.branch || 'cue-data', token };
  return null;
}

function remember(session: Session) {
  if (session.mode === 'demo') {
    local.set(SESSION_KEY, { mode: 'demo' });
  } else {
    local.set(SESSION_KEY, { mode: 'github', owner: session.owner, repo: session.repo, branch: session.branch });
    local.set(TOKEN_KEY, session.token);
  }
}

let stopWatch: (() => void) | null = null;

function applySnapshot(s: Snapshot) {
  app.set((st) => ({ ...st, config: s.config, posts: s.posts.posts }));
}

export async function open(session: Session): Promise<void> {
  stopWatch?.();
  stopWatch = null;
  const backend: Backend =
    session.mode === 'demo' ? new DemoBackend() : new GitHubBackend(session.token, { owner: session.owner, repo: session.repo, branch: session.branch });
  app.set((st) => ({ ...st, session, backend, phase: 'loading', error: null }));
  remember(session);
  try {
    const snap = await backend.load();
    app.set((st) => ({ ...st, phase: 'ready', config: snap.config, posts: snap.posts.posts }));
    stopWatch = backend.watch(applySnapshot, (sync) => app.set((st) => ({ ...st, sync })));
  } catch (e) {
    if (e instanceof NotInitialized) {
      app.set((st) => ({ ...st, phase: 'needs-init' }));
    } else {
      app.set((st) => ({ ...st, phase: 'error', error: e instanceof Error ? e.message : String(e) }));
    }
  }
}

/** Creates the data branch, then opens it. */
export async function initialize(config?: Config): Promise<void> {
  const s = app.get().session;
  if (!s || s.mode !== 'github') return;
  await GitHubBackend.initialize(s.token, s, config);
  await open(s);
}

export function close() {
  stopWatch?.();
  stopWatch = null;
  local.remove(SESSION_KEY);
  local.remove(TOKEN_KEY);
  app.set({ session: null, phase: 'welcome', error: null, backend: null, config: null, posts: [], sync: { state: 'synced', at: null } });
}

export async function restartDemo() {
  resetDemo();
  await open({ mode: 'demo' });
}

/**
 * Applies a change right away and saves it. Resolves true once saved.
 * Change functions must be pure: they can run more than once.
 */
export async function save(change: Change, opts: { ok?: string; undo?: Change } = {}): Promise<boolean> {
  const st = app.get();
  if (!st.backend || !st.config) return false;
  app.set((s) => ({
    ...s,
    config: change.config ? change.config(s.config!) : s.config,
    posts: change.posts ? change.posts({ version: 1, posts: s.posts }).posts : s.posts,
  }));
  try {
    const snap = await st.backend.commit(change);
    applySnapshot(snap);
    if (opts.ok) {
      const undo = opts.undo;
      toast(opts.ok, undo ? { action: { label: '復原', run: () => save(undo, { ok: '已復原' }) } } : {});
    }
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : '儲存失敗，請再試一次。', { kind: 'error' });
    try {
      applySnapshot(await st.backend.refresh());
    } catch {
      /* keep what we have */
    }
    return false;
  }
}

/** Asks the scheduler to run now. */
export async function kick(reason: string): Promise<boolean> {
  const b = app.get().backend;
  if (!b) return false;
  try {
    await b.kick(reason);
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : '無法啟動雲端排程器。', { kind: 'error' });
    return false;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof GitHubError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---- moving a connection to another device

/** A link that signs another device in: the token travels in the URL fragment, never to a server. */
export function deviceLink(session: GitHubSession, base = `${location.origin}${location.pathname}`): string {
  const payload = utf8ToBase64(JSON.stringify({ o: session.owner, r: session.repo, b: session.branch, t: session.token }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${base}#/link/${payload}`;
}

export function readDeviceLink(payload: string): GitHubSession | null {
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(base64ToUtf8(b64 + '==='.slice((b64.length + 3) % 4)));
    if (typeof j.o === 'string' && typeof j.r === 'string' && typeof j.t === 'string') return { mode: 'github', owner: j.o, repo: j.r, branch: j.b || 'cue-data', token: j.t };
  } catch {
    /* not a link */
  }
  return null;
}
