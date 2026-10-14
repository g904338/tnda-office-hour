// Types for engine.mjs, so the TypeScript app can share the scheduler's logic.
import type { Config, DiscordPayload, Post, Posts, Channel } from '../../src/cue/core/model';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  discordChannel?: string;
  guild?: string;
  error?: string;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  discord?: { name?: string; channel?: string; guild?: string };
}

export function isoLocal(ms: number, tz: string): string;
export function triage(posts: Posts, config: Config, now: number): { due: Post[]; stale: Post[]; requests: Post[]; next: number | null };
export function markMissed(posts: Posts, ids: Set<string>, config: Config, now: number): Posts;
export function claim(posts: Posts, ids: Set<string>, config: Config, now: number, runId: string | number): Posts;
export function claimedBy(posts: Posts, runId: string | number): string[];
export function payloadFor(post: Pick<Post, 'payload'>, channel: Channel | undefined, config: Config): DiscordPayload;
export function pendingChannels(post: Post): string[];
export function recordSend(posts: Posts, postId: string, results: Record<string, SendResult>, config: Config, now: number): Posts;
export function releaseStuck(posts: Posts, config: Config, now: number, maxMs?: number): Posts;
export function recordRequest(posts: Posts, postId: string, type: 'delete' | 'edit', results: Record<string, SendResult>, config: Config, now: number): Posts;
export function recordTest(config: Config, channelId: string, requestId: string, result: TestResult, now: number): Config;
export function testPayload(channel: Channel, config: Config): DiscordPayload;
export function discordError(status: number, body: any): string;
