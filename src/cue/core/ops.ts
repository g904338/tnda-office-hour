// Every change to Cue's data is a pure function from the old files to the
// new ones. That keeps the GitHub sync honest: when someone else changed a
// file in the meantime, the same change is simply applied again to theirs.

import { newId, type Channel, type Config, type Content, type Delivery, type LogEntry, type Mention, type Post, type Posts, type PostStyle } from './model';
import { renderPayload } from './render';
import { isoLocal } from './time';

export interface Snapshot {
  config: Config;
  posts: Posts;
}

export interface Change {
  /** commit message, also shown in history */
  message: string;
  config?: (c: Config) => Config;
  posts?: (p: Posts) => Posts;
}

const LOG_MAX = 12;

export function addLog(post: Post, text: string, at: string, tone?: LogEntry['tone']): Post {
  return { ...post, log: [...post.log, { at, text, ...(tone ? { tone } : {}) }].slice(-LOG_MAX) };
}

export function freshDeliveries(channels: string[], keep: Delivery[] = []): Delivery[] {
  return channels.map((c) => {
    const old = keep.find((d) => d.channel === c);
    return old && old.status === 'sent' ? old : { channel: c, status: 'pending' as const };
  });
}

export interface NewPost {
  content: Content;
  style: PostStyle;
  mention: Mention;
  channels: string[];
  /** null for a draft */
  at: number | null;
  rule: string | null;
  label: string | null;
  series: Post['series'];
  source: string;
}

export function makePost(input: NewPost, config: Config, now: number): Post {
  const tz = config.timezone;
  const stamp = isoLocal(now, tz);
  return {
    id: newId('p'),
    series: input.series,
    rule: input.rule,
    content: input.content,
    style: input.style,
    mention: input.mention,
    channels: input.channels,
    at: input.at === null ? null : isoLocal(input.at, tz),
    status: input.at === null ? 'draft' : 'scheduled',
    payload: renderPayload({ content: input.content, style: input.style, mention: input.mention, config, label: input.label }),
    deliveries: freshDeliveries(input.channels),
    request: null,
    source: input.source,
    createdAt: stamp,
    updatedAt: stamp,
    sentAt: null,
    log: [{ at: stamp, text: input.at === null ? '存成草稿' : '建立排程' }],
  };
}

/** The label a post's reminder rule gave it, kept in the payload's headline. */
export function labelOf(post: Post): string | null {
  const name = post.payload.embeds?.[0]?.author?.name ?? /^-# (.*)$/m.exec(post.payload.content ?? '')?.[1] ?? '';
  const i = name.indexOf(' · ');
  return i >= 0 ? name.slice(i + 3) : null;
}

/** Re-renders the stored payload after the content, style, mention or config changed. */
export function rerender(post: Post, config: Config, label: string | null = labelOf(post)): Post {
  return { ...post, payload: renderPayload({ content: post.content, style: post.style, mention: post.mention, config, label }) };
}

export const touch = (post: Post, now: number, tz: string): Post => ({ ...post, updatedAt: isoLocal(now, tz) });

export function mapPost(posts: Posts, id: string, fn: (p: Post) => Post): Posts {
  return { ...posts, posts: posts.posts.map((p) => (p.id === id ? fn(p) : p)) };
}

export function mapPosts(posts: Posts, ids: Set<string>, fn: (p: Post) => Post): Posts {
  return { ...posts, posts: posts.posts.map((p) => (ids.has(p.id) ? fn(p) : p)) };
}

/** Can people still change what this post will say before it goes out? */
export const isEditable = (p: Post) => p.status === 'draft' || p.status === 'scheduled' || p.status === 'failed' || p.status === 'missed';

/** Moves a post (back) into the queue at `at`. Channels that already got it are not sent again. */
export function schedule(post: Post, at: number, now: number, tz: string): Post {
  const p: Post = {
    ...post,
    at: isoLocal(at, tz),
    status: 'scheduled',
    deliveries: freshDeliveries(post.channels, post.deliveries),
    updatedAt: isoLocal(now, tz),
  };
  return addLog(p, post.status === 'draft' ? '排入發送' : post.status === 'failed' || post.status === 'missed' ? '重新排程' : '改了發送時間', p.updatedAt);
}

export function unschedule(post: Post, now: number, tz: string): Post {
  const stamp = isoLocal(now, tz);
  return addLog({ ...post, status: 'draft', at: null, updatedAt: stamp }, '取消排程，改回草稿', stamp);
}

/** Asks the scheduler to delete the messages already in Discord. */
export function requestRetract(post: Post, now: number, tz: string): Post {
  const stamp = isoLocal(now, tz);
  return addLog({ ...post, request: { type: 'delete', at: stamp }, updatedAt: stamp }, '要求從 Discord 撤回', stamp);
}

/** New content for messages already in Discord: re-render and ask the scheduler to edit them. */
export function requestEdit(post: Post, config: Config, now: number): Post {
  const stamp = isoLocal(now, config.timezone);
  const p = rerender({ ...post, request: { type: 'edit', at: stamp }, updatedAt: stamp }, config);
  return addLog(p, '要求更新 Discord 上的訊息', stamp);
}

export function deletePosts(posts: Posts, ids: Set<string>): Posts {
  return { ...posts, posts: posts.posts.filter((p) => !ids.has(p.id)) };
}

export function addPosts(posts: Posts, list: Post[]): Posts {
  return { ...posts, posts: [...posts.posts, ...list] };
}

/** The channel list with one channel replaced, added, or removed (null). */
export function putChannel(config: Config, id: string, channel: Channel | null, now: number): Config {
  const exists = config.channels.some((c) => c.id === id);
  const channels = channel ? (exists ? config.channels.map((c) => (c.id === id ? channel : c)) : [...config.channels, channel]) : config.channels.filter((c) => c.id !== id);
  return { ...config, channels, updatedAt: isoLocal(now, config.timezone) };
}

export function sortByTime(list: Post[]): Post[] {
  const key = (p: Post) => (p.at ? Date.parse(p.at) : p.sentAt ? Date.parse(p.sentAt) : Date.parse(p.createdAt));
  return [...list].sort((a, b) => key(a) - key(b));
}

/** The moment a post is about on a timeline: when it went (or will go) out. */
export function postTime(p: Post): number | null {
  if (p.sentAt) return Date.parse(p.sentAt);
  if (p.at) return Date.parse(p.at);
  return null;
}

/** Parses JSON files written by any version of Cue, filling in what is missing. */
export function readConfig(text: string, fallback: Config): Config {
  const raw = JSON.parse(text);
  const c = { ...fallback, ...raw };
  c.channels = Array.isArray(raw.channels) ? raw.channels.map((ch: Partial<Channel>) => ({ ...CHANNEL_DEFAULTS, ...ch })) : [];
  c.kinds = raw.kinds && typeof raw.kinds === 'object' ? raw.kinds : {};
  return c as Config;
}

export function readPosts(text: string): Posts {
  const raw = JSON.parse(text);
  const list: Post[] = Array.isArray(raw.posts) ? raw.posts : [];
  return {
    version: 1,
    posts: list.filter((p) => p && typeof p.id === 'string').map((p) => ({ ...POST_DEFAULTS, ...p, log: Array.isArray(p.log) ? p.log : [], deliveries: Array.isArray(p.deliveries) ? p.deliveries : [] })),
  };
}

const CHANNEL_DEFAULTS: Omit<Channel, 'id' | 'name' | 'secret'> = {
  emoji: '💬',
  color: '#5865f2',
  note: '',
  webhookSavedAt: null,
  webhookHint: '',
  username: '',
  avatar: '',
  mention: { type: 'none' },
  discord: null,
  test: null,
};

const POST_DEFAULTS: Partial<Post> = {
  series: null,
  rule: null,
  style: 'embed',
  mention: { type: 'none' },
  channels: [],
  at: null,
  request: null,
  source: '',
  sentAt: null,
};

/** Pretty JSON with a trailing newline: readable diffs on GitHub. */
export const toJson = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
