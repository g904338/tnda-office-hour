// Cue's data in a GitHub repository: config.json and posts.json on the
// cue-data branch. Every save is a commit, so the branch doubles as a full
// history. Two people (or the scheduler) writing at once is fine: a stale
// write is rejected by GitHub, and the change is re-applied to the newer file.

import { defaultConfig, emptyPosts, type Channel, type Config, type Posts } from '../core/model';
import { readConfig, readPosts, toJson, type Change, type Snapshot } from '../core/ops';
import type { Backend, SchedulerStatus, SyncStatus } from './backend';
import { GitHub, GitHubError, type RepoRef } from './github';

export class NotInitialized extends Error {
  constructor() {
    super('這個 repository 還沒有 Cue 的資料分支。');
  }
}

type FileKey = 'config' | 'posts';
const PATH: Record<FileKey, string> = { config: 'config.json', posts: 'posts.json' };

interface FileState<T> {
  sha: string;
  etag: string | null;
  data: T;
  /** shas this file had before; an older copy served by a cache is ignored */
  past: Set<string>;
}

const DATA_README = `# Cue 資料分支

這個分支由 [Cue](../../tree/main/src/cue)（Discord 公告排程）自動維護，請不要手動合併到其他分支。

- \`config.json\`：頻道、課程與發送設定。**Webhook 網址不在這裡**，它們加密存放在 repository 的 Actions secrets（\`CUE_WEBHOOK_*\`）。
- \`posts.json\`：所有貼文、排程時間與每個頻道的發送結果。

每一次修改都是一個 commit，所以這個分支的歷史就是完整的發文紀錄。
`;

export class GitHubBackend implements Backend {
  kind = 'github' as const;
  label: string;
  private gh: GitHub;
  private files: { config: FileState<Config> | null; posts: FileState<Posts> | null } = { config: null, posts: null };
  private queue: Promise<unknown> = Promise.resolve();
  private onData: ((s: Snapshot) => void) | null = null;
  private onStatus: ((s: SyncStatus) => void) | null = null;
  private status: SyncStatus = { state: 'synced', at: null };
  private fastUntil = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private defaultBranch: string | null = null;
  private schedulerCache: { at: number; value: SchedulerStatus } | null = null;
  private pending = 0;

  constructor(
    token: string,
    public ref: RepoRef,
  ) {
    this.gh = new GitHub(token, ref);
    this.label = `${ref.owner}/${ref.repo}`;
  }

  get api() {
    return this.gh;
  }

  /** Creates the data branch with empty files. */
  static async initialize(token: string, ref: RepoRef, config: Config = defaultConfig(), wait = 700): Promise<void> {
    const gh = new GitHub(token, ref);
    await gh.createOrphanBranch({ 'config.json': toJson(config), 'posts.json': toJson(emptyPosts()), 'README.md': DATA_README }, 'Cue：建立資料分支');
    // a new branch can take a moment to show up in the contents API
    for (let i = 0; i < 8; i++) {
      if ((await gh.readFile('config.json')) !== 'missing') return;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private snapshot(): Snapshot {
    return { config: this.files.config!.data, posts: this.files.posts!.data };
  }

  private setStatus(s: SyncStatus) {
    this.status = s;
    this.onStatus?.(s);
  }

  private async fetchFile(key: FileKey, conditional: boolean): Promise<boolean> {
    const cur = this.files[key];
    const r = await this.gh.readFile(PATH[key], conditional ? cur?.etag : null);
    if (r === 'unchanged') return false;
    if (r === 'missing') {
      if (key === 'config' || !(await this.gh.branchExists())) throw new NotInitialized();
      // posts.json was removed by hand: start a fresh one
      this.files.posts = { sha: '', etag: null, data: emptyPosts(), past: new Set() };
      return true;
    }
    if (cur && (r.sha === cur.sha || cur.past.has(r.sha))) {
      cur.etag = r.etag;
      return false;
    }
    const data = key === 'config' ? readConfig(r.text, defaultConfig()) : readPosts(r.text);
    const past = cur?.past ?? new Set<string>();
    if (cur?.sha) past.add(cur.sha);
    (this.files as any)[key] = { sha: r.sha, etag: r.etag, data, past };
    return true;
  }

  async load(): Promise<Snapshot> {
    if (!(await this.gh.branchExists())) throw new NotInitialized();
    await Promise.all([this.fetchFile('config', false), this.fetchFile('posts', false)]);
    this.setStatus({ state: 'synced', at: Date.now() });
    return this.snapshot();
  }

  async refresh(): Promise<Snapshot> {
    await Promise.all([this.fetchFile('config', false), this.fetchFile('posts', false)]);
    this.setStatus({ state: 'synced', at: Date.now() });
    return this.snapshot();
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  private async write<T extends Config | Posts>(key: FileKey, fn: (v: T) => T, message: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const cur = this.files[key] as FileState<T>;
      const next = fn(cur.data);
      if (JSON.stringify(next) === JSON.stringify(cur.data)) return;
      try {
        const sha = await this.gh.writeFile(PATH[key], toJson(next), cur.sha || null, message);
        if (cur.sha) cur.past.add(cur.sha);
        (this.files as any)[key] = { sha, etag: null, data: next, past: cur.past };
        return;
      } catch (e) {
        if (!(e instanceof GitHubError) || e.code !== 'conflict') throw e;
        // someone else saved first: take theirs and apply the change again
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        await this.fetchFile(key, false);
      }
    }
    throw new GitHubError('conflict', 409, '資料一直被其他裝置更新，請重新整理後再試一次。');
  }

  commit(change: Change): Promise<Snapshot> {
    this.pending++;
    this.setStatus({ state: 'saving', at: this.status.at });
    return this.enqueue(async () => {
      try {
        if (change.config) await this.write<Config>('config', change.config, change.message);
        if (change.posts) await this.write<Posts>('posts', change.posts, change.message);
        return this.snapshot();
      } catch (e) {
        this.setStatus({ state: 'error', at: this.status.at, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        this.pending--;
        if (this.pending === 0 && this.status.state === 'saving') this.setStatus({ state: 'synced', at: Date.now() });
      }
    });
  }

  private async poll() {
    if (this.pending > 0) return;
    try {
      const [a, b] = await Promise.all([this.fetchFile('config', true), this.fetchFile('posts', true)]);
      this.setStatus({ state: 'synced', at: Date.now() });
      if (a || b) this.onData?.(this.snapshot());
    } catch (e) {
      const offline = e instanceof GitHubError && e.code === 'network';
      this.setStatus({ state: offline ? 'offline' : 'error', at: this.status.at, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private schedule() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.onData) return;
    const fast = Date.now() < this.fastUntil;
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    const wait = fast ? 4000 : visible ? 20000 : 120000;
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedule();
    }, wait);
  }

  /** Check often for a while: the scheduler is about to write something. */
  burst(ms = 180000) {
    this.fastUntil = Date.now() + ms;
    this.schedule();
  }

  watch(onData: (s: Snapshot) => void, onStatus: (s: SyncStatus) => void): () => void {
    this.onData = onData;
    this.onStatus = onStatus;
    onStatus(this.status);
    const wake = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.schedule();
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    this.schedule();
    return () => {
      this.onData = null;
      this.onStatus = null;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }

  private async branchForDispatch(): Promise<string> {
    if (!this.defaultBranch) this.defaultBranch = (await this.gh.repoInfo()).default_branch;
    return this.defaultBranch;
  }

  async kick(reason: string): Promise<void> {
    const wf = await this.gh.workflow();
    if (!wf) throw new GitHubError('notfound', 404, '雲端排程器還沒有安裝：請先把 Cue 的程式碼合併到預設分支。');
    await this.gh.dispatch(await this.branchForDispatch(), { reason });
    this.schedulerCache = null;
    this.burst();
  }

  async saveWebhook(channel: Channel, url: string): Promise<void> {
    await this.gh.putSecret(channel.secret, url);
  }

  async deleteWebhook(channel: Channel): Promise<void> {
    await this.gh.deleteSecret(channel.secret);
  }

  async webhooks(): Promise<Set<string>> {
    return new Set((await this.gh.listSecrets()).map((s) => s.toUpperCase()));
  }

  async testChannel(channel: Channel, requestId: string): Promise<void> {
    const wf = await this.gh.workflow();
    if (!wf) throw new GitHubError('notfound', 404, '雲端排程器還沒有安裝：請先把 Cue 的程式碼合併到預設分支。');
    await this.gh.dispatch(await this.branchForDispatch(), { reason: 'test', test: `${channel.id}:${requestId}` });
    this.schedulerCache = null;
    this.burst();
  }

  async scheduler(): Promise<SchedulerStatus> {
    if (this.schedulerCache && Date.now() - this.schedulerCache.at < 15000) return this.schedulerCache.value;
    const wf = await this.gh.workflow();
    let value: SchedulerStatus;
    if (!wf) {
      value = { installed: false, enabled: false, lastRun: null, every: 5 };
    } else {
      const runs = await this.gh.runs(3);
      const r = runs[0];
      value = {
        installed: true,
        enabled: wf.state === 'active',
        every: 5,
        url: wf.html_url,
        lastRun: r
          ? {
              at: Date.parse(r.run_started_at ?? r.created_at),
              ok: r.status === 'completed' ? r.conclusion === 'success' : null,
              running: r.status !== 'completed',
              url: r.html_url,
            }
          : null,
      };
    }
    this.schedulerCache = { at: Date.now(), value };
    return value;
  }

  async enableScheduler(): Promise<void> {
    await this.gh.enableWorkflow();
    this.schedulerCache = null;
  }
}
