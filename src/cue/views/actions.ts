// What people can do to a post, from any screen.

import { go } from '../../app/router';
import { confirm } from '../../ui/dialog';
import { toast } from '../../ui/toast';
import { app, kick, save } from '../app/state';
import { newId, type Post } from '../core/model';
import { addLog, addPosts, deletePosts, isEditable, mapPost, requestEdit, requestRetract, schedule, unschedule } from '../core/ops';
import { fmtDateTime, isoLocal } from '../core/time';

const tz = () => app.get().config?.timezone ?? 'Asia/Taipei';
const demo = () => app.get().backend?.kind === 'demo';

export async function sendNow(post: Post): Promise<boolean> {
  const now = Date.now();
  const ok = await save({ message: `Cue：立即發送「${post.content.title}」`, posts: (p) => mapPost(p, post.id, (x) => (isEditable(x) ? schedule(x, now, now, tz()) : x)) });
  if (!ok) return false;
  if (await kick('send-now')) toast(demo() ? '已交給模擬排程器，馬上「送出」。' : '已交給雲端排程器，大約 30 秒內送達 Discord。');
  return true;
}

export async function reschedule(post: Post, at: number, opts: { quiet?: boolean } = {}): Promise<boolean> {
  const before = post;
  const now = Date.now();
  return save(
    { message: `Cue：改時間「${post.content.title}」→ ${fmtDateTime(at, tz(), now)}`, posts: (p) => mapPost(p, post.id, (x) => schedule(x, at, now, tz())) },
    opts.quiet
      ? {}
      : {
          ok: `已改到 ${fmtDateTime(at, tz(), now)}`,
          undo: { message: 'Cue：復原改時間', posts: (p) => mapPost(p, post.id, () => before) },
        },
  );
}

export async function toDraft(post: Post): Promise<boolean> {
  return save({ message: `Cue：取消排程「${post.content.title}」`, posts: (p) => mapPost(p, post.id, (x) => unschedule(x, Date.now(), tz())) }, { ok: '已改回草稿，不會發送' });
}

export async function retry(post: Post): Promise<boolean> {
  return sendNow(post);
}

export async function duplicate(post: Post): Promise<void> {
  const now = Date.now();
  const stamp = isoLocal(now, tz());
  const copy: Post = {
    ...post,
    id: newId('p'),
    series: null,
    status: 'draft',
    at: null,
    sentAt: null,
    request: null,
    deliveries: post.channels.map((c) => ({ channel: c, status: 'pending' as const })),
    createdAt: stamp,
    updatedAt: stamp,
    log: [{ at: stamp, text: `從「${post.content.title}」複製` }],
  };
  delete copy.claim;
  if (await save({ message: `Cue：複製「${post.content.title}」`, posts: (p) => addPosts(p, [copy]) })) go(`compose/${copy.id}`);
}

export async function remove(post: Post): Promise<boolean> {
  const sentSomewhere = post.deliveries.some((d) => d.status === 'sent');
  const ok = await confirm({
    title: '刪除這則貼文？',
    body: sentSomewhere ? '只會刪除 Cue 裡的紀錄，已經在 Discord 上的訊息不會被刪掉。要連 Discord 一起收回，請用「撤回」。' : '它不會被發送，紀錄也會消失。',
    ok: '刪除',
    danger: true,
  });
  if (!ok) return false;
  return save(
    { message: `Cue：刪除「${post.content.title}」`, posts: (p) => deletePosts(p, new Set([post.id])) },
    { ok: '已刪除', undo: { message: 'Cue：復原刪除', posts: (p) => (p.posts.some((x) => x.id === post.id) ? p : addPosts(p, [post])) } },
  );
}

export async function removeSeries(post: Post): Promise<boolean> {
  if (!post.series) return remove(post);
  const all = app.get().posts.filter((p) => p.series?.id === post.series!.id);
  const pending = all.filter((p) => p.status === 'scheduled' || p.status === 'draft');
  const ok = await confirm({
    title: `刪除這一系列還沒發送的 ${pending.length} 則？`,
    body: '已經發送過的會留在紀錄裡。',
    ok: '全部刪除',
    danger: true,
  });
  if (!ok) return false;
  const ids = new Set(pending.map((p) => p.id));
  return save(
    { message: `Cue：刪除系列「${post.content.title}」的 ${ids.size} 則排程`, posts: (p) => deletePosts(p, ids) },
    { ok: `已刪除 ${ids.size} 則`, undo: { message: 'Cue：復原刪除', posts: (p) => addPosts(p, pending.filter((x) => !p.posts.some((y) => y.id === x.id))) } },
  );
}

export async function retract(post: Post): Promise<boolean> {
  const ok = await confirm({
    title: '從 Discord 撤回這則訊息？',
    body: '排程器會刪掉它在每個頻道的訊息（通常 30 秒內）。紀錄會保留在 Cue 裡，標示為「已撤回」。',
    ok: '撤回',
    danger: true,
  });
  if (!ok) return false;
  const saved = await save({ message: `Cue：撤回「${post.content.title}」`, posts: (p) => mapPost(p, post.id, (x) => requestRetract(x, Date.now(), tz())) });
  if (saved && (await kick('retract'))) toast(demo() ? '已撤回（示範模式）。' : '已請排程器從 Discord 撤回，稍後會更新狀態。');
  return saved;
}

/** Saves edits to a post that is already in Discord and asks the scheduler to update the messages. */
export async function pushEdit(post: Post): Promise<boolean> {
  const config = app.get().config!;
  const saved = await save({
    message: `Cue：更新已發送的「${post.content.title}」`,
    posts: (p) => mapPost(p, post.id, () => requestEdit(post, config, Date.now())),
  });
  if (saved && (await kick('edit'))) toast(demo() ? '已更新（示範模式）。' : '已請排程器更新 Discord 上的訊息。');
  return saved;
}

export function note(post: Post, text: string): Post {
  return addLog(post, text, isoLocal(Date.now(), tz()));
}
