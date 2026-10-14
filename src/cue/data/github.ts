// A small GitHub REST client for the browser. Cue keeps its data as two
// JSON files on a branch of the repository, puts webhook URLs into
// encrypted repository secrets, and asks GitHub Actions to run the
// scheduler. Everything goes through the person's own access token.

import { base64ToUtf8, encryptSecret, utf8ToBase64 } from './crypto';

export const API = 'https://api.github.com';
export const SCHEDULER_WORKFLOW = 'cue-scheduler.yml';

export interface RepoRef {
  owner: string;
  repo: string;
  /** the branch that holds Cue's data */
  branch: string;
}

export type GitHubErrorCode = 'auth' | 'forbidden' | 'notfound' | 'conflict' | 'ratelimit' | 'network' | 'invalid' | 'server';

export class GitHubError extends Error {
  constructor(
    public code: GitHubErrorCode,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FileRead {
  sha: string;
  text: string;
  etag: string | null;
}

export interface WorkflowRun {
  id: number;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending' | string;
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null | string;
  event: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  html_url: string;
}

export interface RepoInfo {
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

function describe(status: number, body: any, path: string): GitHubError {
  const msg: string = body?.message ?? '';
  if (status === 401) return new GitHubError('auth', status, '存取權杖無效或已過期，請重新建立一組。');
  if (status === 403 && /rate limit/i.test(msg)) return new GitHubError('ratelimit', status, 'GitHub API 使用次數暫時用完了，請稍等幾分鐘再試。');
  if (status === 403 || (status === 404 && /secrets|actions/.test(path)))
    return new GitHubError('forbidden', status, '存取權杖的權限不夠。請確認它可以存取這個 repository，並開啟 Contents、Actions、Secrets 的讀寫權限。');
  if (status === 404) return new GitHubError('notfound', status, '找不到這個 repository 或檔案。');
  if (status === 409 || (status === 422 && /sha/i.test(msg))) return new GitHubError('conflict', status, '資料剛被別的裝置更新了。');
  if (status === 422) return new GitHubError('invalid', status, msg || 'GitHub 拒絕了這個請求。');
  return new GitHubError('server', status, `GitHub 暫時沒有回應（${status}），請稍後再試。`);
}

export class GitHub {
  constructor(
    private token: string,
    public ref: RepoRef,
  ) {}

  private get base() {
    return `/repos/${encodeURIComponent(this.ref.owner)}/${encodeURIComponent(this.ref.repo)}`;
  }

  async request<T = any>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; ok404?: boolean } = {},
  ): Promise<{ status: number; data: T; etag: string | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        cache: 'no-store',
        signal: ctrl.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new GitHubError('network', 0, '連不上 GitHub，請檢查網路連線。');
    } finally {
      clearTimeout(timer);
    }
    const etag = res.headers.get('ETag');
    if (res.status === 304) return { status: 304, data: undefined as T, etag };
    if (res.status === 204) return { status: 204, data: undefined as T, etag };
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.status === 404 && opts.ok404) return { status: 404, data: null as T, etag };
    if (!res.ok) throw describe(res.status, data, path);
    return { status: res.status, data, etag };
  }

  async repoInfo(): Promise<RepoInfo> {
    return (await this.request<RepoInfo>('GET', this.base)).data;
  }

  async branchExists(branch = this.ref.branch): Promise<boolean> {
    const r = await this.request('GET', `${this.base}/branches/${encodeURIComponent(branch)}`, { ok404: true });
    return r.status !== 404;
  }

  /** Reads a text file from the data branch. Resolves null on 304 (unchanged) or 404 when `missing` is set. */
  async readFile(path: string, etag?: string | null): Promise<FileRead | 'unchanged' | 'missing'> {
    const r = await this.request<any>('GET', `${this.base}/contents/${path}?ref=${encodeURIComponent(this.ref.branch)}`, {
      headers: etag ? { 'If-None-Match': etag } : {},
      ok404: true,
    });
    if (r.status === 304) return 'unchanged';
    if (r.status === 404) return 'missing';
    let text: string;
    if (r.data.encoding === 'base64' && r.data.content) {
      text = base64ToUtf8(r.data.content);
    } else {
      // over 1 MB the contents API leaves the content out; the blob API still has it
      const blob = await this.request<any>('GET', `${this.base}/git/blobs/${r.data.sha}`);
      text = base64ToUtf8(blob.data.content);
    }
    return { sha: r.data.sha, text, etag: r.etag };
  }

  /** Creates or updates a file. Throws GitHubError('conflict') when `sha` is stale. */
  async writeFile(path: string, text: string, sha: string | null, message: string): Promise<string> {
    const r = await this.request<any>('PUT', `${this.base}/contents/${path}`, {
      body: { message, content: utf8ToBase64(text), branch: this.ref.branch, ...(sha ? { sha } : {}) },
    });
    return r.data.content.sha as string;
  }

  /** A new branch with no history, holding just these files. */
  async createOrphanBranch(files: Record<string, string>, message: string): Promise<void> {
    const tree = await this.request<any>('POST', `${this.base}/git/trees`, {
      body: { tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) },
    });
    const commit = await this.request<any>('POST', `${this.base}/git/commits`, { body: { message, tree: tree.data.sha, parents: [] } });
    await this.request('POST', `${this.base}/git/refs`, { body: { ref: `refs/heads/${this.ref.branch}`, sha: commit.data.sha } });
  }

  async listSecrets(): Promise<string[]> {
    const r = await this.request<any>('GET', `${this.base}/actions/secrets?per_page=100`);
    return (r.data.secrets ?? []).map((s: { name: string }) => s.name);
  }

  async putSecret(name: string, value: string): Promise<void> {
    const key = await this.request<{ key_id: string; key: string }>('GET', `${this.base}/actions/secrets/public-key`);
    await this.request('PUT', `${this.base}/actions/secrets/${encodeURIComponent(name)}`, {
      body: { encrypted_value: encryptSecret(value, key.data.key), key_id: key.data.key_id },
    });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.request('DELETE', `${this.base}/actions/secrets/${encodeURIComponent(name)}`, { ok404: true });
  }

  /** The scheduler workflow, or null when it is not on the default branch yet. */
  async workflow(): Promise<{ state: string; html_url: string } | null> {
    const r = await this.request<any>('GET', `${this.base}/actions/workflows/${SCHEDULER_WORKFLOW}`, { ok404: true });
    return r.status === 404 ? null : { state: r.data.state, html_url: r.data.html_url };
  }

  async enableWorkflow(): Promise<void> {
    await this.request('PUT', `${this.base}/actions/workflows/${SCHEDULER_WORKFLOW}/enable`);
  }

  async dispatch(ref: string, inputs: Record<string, string>): Promise<void> {
    await this.request('POST', `${this.base}/actions/workflows/${SCHEDULER_WORKFLOW}/dispatches`, { body: { ref, inputs } });
  }

  async runs(perPage = 6): Promise<WorkflowRun[]> {
    const r = await this.request<any>('GET', `${this.base}/actions/workflows/${SCHEDULER_WORKFLOW}/runs?per_page=${perPage}`, { ok404: true });
    return r.status === 404 ? [] : (r.data.workflow_runs ?? []);
  }
}

/** owner/repo from a GitHub Pages address: g904338.github.io/tnda-office-hour → g904338/tnda-office-hour */
export function repoFromPagesUrl(href: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(href);
    const m = /^([a-z0-9-]+)\.github\.io$/i.exec(u.hostname);
    if (!m) return null;
    const first = u.pathname.split('/').filter(Boolean)[0];
    return { owner: m[1], repo: first || `${m[1]}.github.io` };
  } catch {
    return null;
  }
}

/** Accepts owner/repo or a github.com URL. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** A link that opens GitHub's form for a fine-grained token with Cue's permissions ticked. */
export function tokenTemplateUrl(repo: string): string {
  const q = new URLSearchParams({
    name: `Cue · ${repo}`.slice(0, 40),
    description: 'Cue（Discord 公告排程）讀寫資料、儲存 Webhook、啟動排程器用',
    expires_in: '180',
    contents: 'write',
    actions: 'write',
    secrets: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}
