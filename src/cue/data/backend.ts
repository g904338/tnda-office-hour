// The two places Cue's data can live behind one interface: this browser
// (the demo) or a GitHub repository (for real).

import type { Change, Snapshot } from '../core/ops';
import type { Channel } from '../core/model';

export type SyncState = 'synced' | 'saving' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** last time the data was known to match the cloud */
  at: number | null;
  message?: string;
}

export interface SchedulerStatus {
  /** installed: the workflow exists on the default branch */
  installed: boolean;
  enabled: boolean;
  lastRun: { at: number; ok: boolean | null; running: boolean; url?: string } | null;
  /** when the next automatic check should happen */
  every: number;
  url?: string;
}

export interface Backend {
  kind: 'demo' | 'github';
  /** what to call the place the data lives: 示範資料 / owner/repo */
  label: string;
  load(): Promise<Snapshot>;
  commit(change: Change): Promise<Snapshot>;
  /** keeps the data fresh; returns a stop function */
  watch(onData: (s: Snapshot) => void, onStatus: (s: SyncStatus) => void): () => void;
  /** asks the scheduler to run now (send-now, retries, retracts) */
  kick(reason: string): Promise<void>;
  saveWebhook(channel: Channel, url: string): Promise<void>;
  deleteWebhook(channel: Channel): Promise<void>;
  /** which channels have a webhook stored */
  webhooks(): Promise<Set<string>>;
  testChannel(channel: Channel, requestId: string): Promise<void>;
  scheduler(): Promise<SchedulerStatus>;
  enableScheduler?(): Promise<void>;
  /** re-reads everything now */
  refresh(): Promise<Snapshot>;
}
