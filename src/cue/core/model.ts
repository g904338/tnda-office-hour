// The data Cue keeps. Both files live as readable JSON on the `cue-data`
// branch of the repository; times are ISO strings with the course's offset
// (2026-10-21T14:10:00+08:00) so the history on GitHub reads naturally.

export type KindKey = 'class' | 'homework' | 'exam' | 'event' | 'material' | 'notice';

export interface KindStyle {
  key: KindKey;
  /** short label for chips: 作業 */
  label: string;
  /** headline above the title: 作業提醒 */
  headline: string;
  emoji: string;
  /** #rrggbb, the embed's colour bar */
  color: string;
  /** name of the time field: 截止時間 */
  whenLabel: string;
  /** verb for reminder labels: 明天「截止」 */
  verb: string;
  /** reminder rules ticked by default when there is a time */
  reminders: string[];
  /** default hour:minute when a date has no time */
  defaultTime: string;
}

export const KINDS: Record<KindKey, KindStyle> = {
  class: {
    key: 'class',
    label: '上課',
    headline: '上課提醒',
    emoji: '📚',
    color: '#5865f2',
    whenLabel: '上課時間',
    verb: '上課',
    reminders: ['d1@20:00', 'm30'],
    defaultTime: '09:00',
  },
  homework: {
    key: 'homework',
    label: '作業',
    headline: '作業提醒',
    emoji: '📝',
    color: '#f59e0b',
    whenLabel: '截止時間',
    verb: '截止',
    reminders: ['now', 'd1@20:00', 'm180'],
    defaultTime: '23:59',
  },
  exam: {
    key: 'exam',
    label: '考試',
    headline: '考試提醒',
    emoji: '✏️',
    color: '#ef4444',
    whenLabel: '考試時間',
    verb: '考試',
    reminders: ['d7@20:00', 'd1@20:00'],
    defaultTime: '09:00',
  },
  event: {
    key: 'event',
    label: '活動',
    headline: '活動通知',
    emoji: '🎬',
    color: '#ec4899',
    whenLabel: '活動時間',
    verb: '登場',
    reminders: ['d3@20:00', 'd1@20:00', 'm60'],
    defaultTime: '09:00',
  },
  material: {
    key: 'material',
    label: '教材',
    headline: '教材上架',
    emoji: '📎',
    color: '#10b981',
    whenLabel: '時間',
    verb: '',
    reminders: ['now'],
    defaultTime: '09:00',
  },
  notice: {
    key: 'notice',
    label: '公告',
    headline: '課程公告',
    emoji: '📢',
    color: '#0ea5e9',
    whenLabel: '時間',
    verb: '',
    reminders: ['now'],
    defaultTime: '09:00',
  },
};

export const KIND_ORDER: KindKey[] = ['class', 'homework', 'exam', 'event', 'material', 'notice'];

export interface Link {
  url: string;
  label: string;
}

export interface Place {
  /** 地點 / 繳交 / 線上 */
  label: string;
  value: string;
}

/** What a post says, before it is dressed up for Discord. */
export interface Content {
  kind: KindKey;
  title: string;
  /** free text, Discord markdown allowed */
  body: string;
  /** the time the post is about (deadline, class start…) */
  when: { at: string; end?: string | null; allDay?: boolean } | null;
  place: Place | null;
  bring: string;
  links: Link[];
  bullets: string[];
  notes: string[];
  image: string;
}

export type Mention = { type: 'none' } | { type: 'everyone' } | { type: 'here' } | { type: 'role'; id: string; name?: string };

export type PostStyle = 'embed' | 'text';

export type PostStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'missed' | 'retracted';

export interface Delivery {
  channel: string;
  status: 'pending' | 'sent' | 'failed' | 'deleted';
  messageId?: string;
  /** Discord ids, for a link that opens the message */
  discordChannel?: string;
  guild?: string;
  at?: string;
  error?: string;
}

export interface LogEntry {
  at: string;
  text: string;
  tone?: 'ok' | 'error';
}

/** Discord's execute-webhook body (the parts Cue uses). */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  author?: { name: string; icon_url?: string; url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  timestamp?: string;
}

export interface DiscordPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: { parse: Array<'everyone' | 'roles' | 'users'>; roles?: string[] };
}

export interface Post {
  id: string;
  /** posts made from one paste share a series (reminders, weekly repeats) */
  series: { id: string; index: number; total: number } | null;
  /** which reminder rule made this post, e.g. 'd1@20:00' */
  rule: string | null;
  content: Content;
  style: PostStyle;
  mention: Mention;
  channels: string[];
  /** when to send; null for drafts */
  at: string | null;
  status: PostStatus;
  /** the exact message the scheduler sends, rendered when saved */
  payload: DiscordPayload;
  deliveries: Delivery[];
  /** a change to messages already in Discord, done by the next scheduler run */
  request: { type: 'delete' | 'edit'; at: string } | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  log: LogEntry[];
}

export interface Channel {
  id: string;
  name: string;
  emoji: string;
  /** #rrggbb, only for Cue's own screens */
  color: string;
  note: string;
  /** name of the repository secret that holds the webhook URL */
  secret: string;
  /** when the webhook was last saved (never the URL itself) */
  webhookSavedAt: string | null;
  /** the last characters of the webhook, so people can tell them apart */
  webhookHint: string;
  username: string;
  avatar: string;
  mention: Mention;
  /** filled in by the scheduler after a successful test */
  discord: { name?: string; channel?: string; guild?: string } | null;
  test: { id: string; at: string; ok: boolean | null; error?: string } | null;
}

export interface Config {
  version: 1;
  timezone: string;
  course: string;
  /** 'YYYY-MM-DD', Monday of week 1, for 第 N 週 */
  semesterStart: string;
  footer: string;
  username: string;
  avatar: string;
  /** a post more than this many minutes late is marked missed instead of sent */
  staleMinutes: number;
  channels: Channel[];
  kinds: Partial<Record<KindKey, Partial<Pick<KindStyle, 'emoji' | 'color' | 'headline'>>>>;
  updatedAt: string;
}

export interface Posts {
  version: 1;
  posts: Post[];
}

export const LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  footer: 2048,
  author: 256,
  embedTotal: 6000,
  username: 80,
} as const;

export function kindStyle(config: Pick<Config, 'kinds'> | null | undefined, key: KindKey): KindStyle {
  const base = KINDS[key] ?? KINDS.notice;
  const o = config?.kinds?.[key];
  return o ? { ...base, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v)) } : base;
}

export function emptyContent(kind: KindKey = 'notice'): Content {
  return { kind, title: '', body: '', when: null, place: null, bring: '', links: [], bullets: [], notes: [], image: '' };
}

export function defaultConfig(now = new Date().toISOString()): Config {
  return {
    version: 1,
    timezone: 'Asia/Taipei',
    course: '',
    semesterStart: '',
    footer: '',
    username: '',
    avatar: '',
    staleMinutes: 720,
    channels: [],
    kinds: {},
    updatedAt: now,
  };
}

export function emptyPosts(): Posts {
  return { version: 1, posts: [] };
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Short random id: p_k3j9x2m7 */
export function newId(prefix: string, length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

/** The repository secret that holds a channel's webhook URL. */
export function secretName(channelId: string): string {
  return `CUE_WEBHOOK_${channelId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
}

export const STATUS_TEXT: Record<PostStatus, string> = {
  draft: '草稿',
  scheduled: '排程中',
  sending: '發送中',
  sent: '已發送',
  failed: '發送失敗',
  missed: '已錯過',
  retracted: '已撤回',
};

export const MENTION_TEXT = (m: Mention): string =>
  m.type === 'everyone' ? '@everyone' : m.type === 'here' ? '@here' : m.type === 'role' ? `@${m.name || '身分組'}` : '不標註';

/** A webhook URL Discord would accept. */
export function parseWebhookUrl(raw: string): { id: string; token: string; url: string } | null {
  const m = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,22})\/([\w-]{20,})\/?(?:\?.*)?$/.exec(raw.trim());
  if (!m) return null;
  return { id: m[1], token: m[2], url: `https://discord.com/api/webhooks/${m[1]}/${m[2]}` };
}

/** Someone pasted a channel link (discord.com/channels/…) instead of a webhook. */
export function looksLikeChannelLink(raw: string): boolean {
  return /discord(?:app)?\.com\/channels\/\d+\/\d+/.test(raw);
}

export function messageLink(d: Delivery): string | null {
  if (!d.messageId || !d.discordChannel) return null;
  return `https://discord.com/channels/${d.guild || '@me'}/${d.discordChannel}/${d.messageId}`;
}

export function hexToInt(hex: string): number {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return Number.isFinite(n) ? n : 0x5865f2;
}
