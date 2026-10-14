// The demo: Cue's data lives in this browser and a simulated scheduler —
// the very same engine the GitHub Actions job runs — "sends" posts when
// they are due. Nothing ever reaches Discord.

import * as E from '../../../scripts/cue/engine.mjs';
import type { Channel, Config, Posts } from '../core/model';
import type { Change, Snapshot } from '../core/ops';
import { local } from '../../app/store';
import type { Backend, SchedulerStatus, SyncStatus } from './backend';
import { demoConfig, demoPosts } from './seed';

const KEY = 'cue:demo:v1';

interface Saved extends Snapshot {
  /** channels whose webhook was "deleted on Discord", so the demo can show a failure */
  broken: string[];
}

export class DemoBackend implements Backend {
  kind = 'demo' as const;
  label = '示範資料';
  private state: Saved | null = null;
  private onData: ((s: Snapshot) => void) | null = null;
  private lastTick = Date.now();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  private snapshot(): Snapshot {
    return { config: this.state!.config, posts: this.state!.posts };
  }

  private save() {
    local.set(KEY, this.state);
  }

  async load(): Promise<Snapshot> {
    const saved = local.get<Saved>(KEY);
    if (saved?.config?.channels && Array.isArray(saved.posts?.posts)) {
      this.state = { ...saved, broken: Array.isArray(saved.broken) ? saved.broken : [] };
    } else {
      const now = Date.now();
      const config = demoConfig(now);
      this.state = { config, posts: demoPosts(config, now), broken: ['ch_oh'] };
      this.save();
    }
    this.tick();
    return this.snapshot();
  }

  async refresh(): Promise<Snapshot> {
    return this.load();
  }

  async commit(change: Change): Promise<Snapshot> {
    const s = this.state!;
    this.state = {
      ...s,
      config: change.config ? change.config(s.config) : s.config,
      posts: change.posts ? change.posts(s.posts) : s.posts,
    };
    this.save();
    return this.snapshot();
  }

  /** One run of the scheduler, exactly as in the cloud. */
  private tick(): boolean {
    const s = this.state;
    if (!s) return false;
    const now = Date.now();
    this.lastTick = now;
    const config: Config = s.config;
    let posts: Posts = s.posts;
    const before = posts;
    const { due, stale, requests } = E.triage(posts, config, now);
    if (stale.length) posts = E.markMissed(posts, new Set(stale.map((p) => p.id)), config, now);
    for (const p of requests) {
      const results = Object.fromEntries(p.deliveries.filter((d) => d.status === 'sent' && d.messageId).map((d) => [d.channel, { ok: true }]));
      posts = E.recordRequest(posts, p.id, p.request!.type, results, config, now);
    }
    if (due.length) {
      posts = E.claim(posts, new Set(due.map((p) => p.id)), config, now, 'demo');
      for (const id of E.claimedBy(posts, 'demo')) {
        const post = posts.posts.find((p) => p.id === id)!;
        const results: Record<string, { ok: boolean; messageId?: string; discordChannel?: string; guild?: string; error?: string }> = {};
        for (const c of E.pendingChannels(post)) {
          const ch = config.channels.find((x) => x.id === c);
          results[c] = !ch
            ? { ok: false, error: '頻道已被刪除' }
            : !ch.webhookSavedAt
              ? { ok: false, error: '這個頻道還沒有設定 Webhook' }
              : s.broken.includes(c)
                ? { ok: false, error: E.discordError(404, { code: 10015 }) }
                : { ok: true, messageId: String(1300000000000000000n + BigInt(now)), discordChannel: '1290000000000000000', guild: '1280000000000000000' };
        }
        posts = E.recordSend(posts, id, results, config, now);
      }
    }
    if (posts === before) return false;
    this.state = { ...s, posts };
    this.save();
    return true;
  }

  watch(onData: (s: Snapshot) => void, onStatus: (s: SyncStatus) => void): () => void {
    this.onData = onData;
    onStatus({ state: 'synced', at: Date.now() });
    const every = setInterval(() => {
      if (this.tick()) onData(this.snapshot());
    }, 3000);
    // another tab of the demo changed something
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY || !e.newValue) return;
      try {
        this.state = JSON.parse(e.newValue);
        onData(this.snapshot());
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(every);
      window.removeEventListener('storage', onStorage);
      for (const t of this.timers) clearTimeout(t);
      this.onData = null;
    };
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  async kick(): Promise<void> {
    // the "cloud" picks it up after a moment, like a real dispatch
    this.later(1600, () => {
      if (this.tick()) this.onData?.(this.snapshot());
    });
  }

  async saveWebhook(channel: Channel): Promise<void> {
    const s = this.state!;
    this.state = { ...s, broken: s.broken.filter((id) => id !== channel.id) };
    this.save();
  }

  async deleteWebhook(): Promise<void> {}

  async webhooks(): Promise<Set<string>> {
    return new Set(this.state!.config.channels.filter((c) => c.webhookSavedAt).map((c) => c.secret));
  }

  async testChannel(channel: Channel, requestId: string): Promise<void> {
    this.later(1800, () => {
      const s = this.state!;
      const ok = Boolean(channel.webhookSavedAt) && !s.broken.includes(channel.id);
      const result = ok
        ? { ok: true, discord: { name: 'Cue', channel: '1290000000000000000', guild: '1280000000000000000' } }
        : { ok: false, error: channel.webhookSavedAt ? E.discordError(404, { code: 10015 }) : '這個頻道還沒有設定 Webhook' };
      this.state = { ...s, config: E.recordTest(s.config, channel.id, requestId, result, Date.now()) };
      this.save();
      this.onData?.(this.snapshot());
    });
  }

  async scheduler(): Promise<SchedulerStatus> {
    return { installed: true, enabled: true, every: 5, lastRun: { at: this.lastTick, ok: true, running: false } };
  }
}

export function resetDemo() {
  local.remove(KEY);
}
