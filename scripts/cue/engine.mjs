// Cue's scheduler as pure functions over the two data files. The GitHub
// Actions job (scheduler.mjs) and the in-browser demo both run these, so
// what you see in the demo is exactly what happens in the cloud.
//
// Every function takes the current files and returns new ones; the caller
// commits them and, if someone else changed a file meanwhile, applies the
// same function again to the newer version.

const LOG_MAX = 12;

/** ISO time with the course's UTC offset: 2026-10-21T14:10:00+08:00 */
export function isoLocal(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  const off = Math.round((asUtc - (ms - (((ms % 1000) + 1000) % 1000))) / 60000);
  const a = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function log(post, text, at, tone) {
  return { ...post, log: [...(post.log ?? []), tone ? { at, text, tone } : { at, text }].slice(-LOG_MAX) };
}

function mapPosts(posts, fn) {
  return { ...posts, posts: posts.posts.map(fn) };
}

const channelName = (config, id) => {
  const c = config.channels.find((x) => x.id === id);
  return c ? `#${c.name}` : '已刪除的頻道';
};

/**
 * What needs doing at `now`: posts to send, posts that are too late, and
 * changes requested to messages already in Discord.
 */
export function triage(posts, config, now) {
  const staleMs = Math.max(5, Number(config.staleMinutes) || 720) * 60000;
  const due = [];
  const stale = [];
  const requests = [];
  let next = null;
  for (const p of posts.posts) {
    if (p.request && (p.status === 'sent' || p.status === 'failed') && p.deliveries.some((d) => d.messageId && d.status === 'sent')) requests.push(p);
    if (p.status !== 'scheduled' || !p.at) continue;
    const at = Date.parse(p.at);
    if (!Number.isFinite(at)) continue;
    if (at <= now) (now - at > staleMs ? stale : due).push(p);
    else if (next === null || at < next) next = at;
  }
  const byTime = (a, b) => Date.parse(a.at) - Date.parse(b.at);
  return { due: due.sort(byTime), stale, requests, next };
}

/** Marks posts that waited too long as missed, so a dead scheduler never floods a channel later. */
export function markMissed(posts, ids, config, now) {
  const stamp = isoLocal(now, config.timezone);
  return mapPosts(posts, (p) =>
    ids.has(p.id) && p.status === 'scheduled' ? log({ ...p, status: 'missed', updatedAt: stamp }, '錯過發送時間，沒有送出（排程器太久沒有執行）', stamp, 'error') : p,
  );
}

/** Claims due posts for this run. Only posts that are still due when the claim is applied are taken. */
export function claim(posts, ids, config, now, runId) {
  const stamp = isoLocal(now, config.timezone);
  return mapPosts(posts, (p) => {
    if (!ids.has(p.id) || p.status !== 'scheduled' || !p.at || Date.parse(p.at) > now) return p;
    return { ...p, status: 'sending', claim: { run: String(runId), at: stamp } };
  });
}

/** The ids a claim actually took (compare the files before and after). */
export function claimedBy(posts, runId) {
  return posts.posts.filter((p) => p.status === 'sending' && p.claim?.run === String(runId)).map((p) => p.id);
}

/** The body sent to one channel: the stored payload plus that channel's bot name and avatar. */
export function payloadFor(post, channel, config) {
  const payload = { ...post.payload };
  const username = (channel?.username || config.username || '').trim();
  const avatar = channel?.avatar || config.avatar || '';
  if (username) payload.username = username.slice(0, 80);
  if (/^https:\/\//.test(avatar)) payload.avatar_url = avatar;
  if (!payload.allowed_mentions) payload.allowed_mentions = { parse: [] };
  return payload;
}

/** Channels of a post that still need the message. */
export function pendingChannels(post) {
  return post.channels.filter((c) => {
    const d = post.deliveries.find((x) => x.channel === c);
    return !d || d.status === 'pending' || d.status === 'failed';
  });
}

/**
 * Records what happened for each channel and settles the post's status.
 * `results` maps channel id → { ok, messageId?, discordChannel?, guild?, error? }.
 */
export function recordSend(posts, postId, results, config, now) {
  const stamp = isoLocal(now, config.timezone);
  return mapPosts(posts, (p) => {
    if (p.id !== postId) return p;
    const deliveries = p.channels.map((c) => {
      const old = p.deliveries.find((d) => d.channel === c) ?? { channel: c, status: 'pending' };
      const r = results[c];
      if (!r) return old;
      return r.ok
        ? { channel: c, status: 'sent', messageId: r.messageId, discordChannel: r.discordChannel, guild: r.guild, at: stamp }
        : { channel: c, status: 'failed', error: r.error, at: stamp };
    });
    const sent = deliveries.filter((d) => d.status === 'sent').length;
    const failed = deliveries.filter((d) => d.status === 'failed');
    const status = failed.length || !deliveries.length ? 'failed' : sent === deliveries.length ? 'sent' : 'scheduled';
    let next = { ...p, deliveries, status, updatedAt: stamp };
    delete next.claim;
    if (!deliveries.length) next = log(next, '沒有選擇任何頻道，無法發送', stamp, 'error');
    if (sent && !p.sentAt) next.sentAt = stamp;
    for (const c of Object.keys(results)) {
      const r = results[c];
      next = r.ok ? log(next, `已送到 ${channelName(config, c)}`, stamp, 'ok') : log(next, `${channelName(config, c)} 發送失敗：${r.error}`, stamp, 'error');
    }
    return next;
  });
}

/** A claim that never finished (the job died mid-way) goes back to failed so a person can decide. */
export function releaseStuck(posts, config, now, maxMs = 30 * 60000) {
  const stamp = isoLocal(now, config.timezone);
  return mapPosts(posts, (p) => {
    if (p.status !== 'sending' || !p.claim?.at || now - Date.parse(p.claim.at) < maxMs) return p;
    const next = { ...p, status: 'failed', updatedAt: stamp };
    delete next.claim;
    return log(next, '發送中斷，不確定是否送出，請到 Discord 確認後再決定是否重送', stamp, 'error');
  });
}

/** Records the outcome of deleting or editing messages already in Discord. */
export function recordRequest(posts, postId, type, results, config, now) {
  const stamp = isoLocal(now, config.timezone);
  return mapPosts(posts, (p) => {
    if (p.id !== postId || !p.request || p.request.type !== type) return p;
    const errors = Object.entries(results).filter(([, r]) => !r.ok);
    let next = { ...p, request: null, updatedAt: stamp };
    if (type === 'delete') {
      next.deliveries = p.deliveries.map((d) => (results[d.channel]?.ok ? { ...d, status: 'deleted', at: stamp } : d));
      if (next.deliveries.every((d) => d.status !== 'sent')) next.status = 'retracted';
      next = errors.length ? log(next, `部分訊息無法撤回：${errors.map(([c, r]) => `${channelName(config, c)} ${r.error}`).join('；')}`, stamp, 'error') : log(next, '已從 Discord 撤回', stamp, 'ok');
    } else {
      next = errors.length ? log(next, `部分訊息無法更新：${errors.map(([c, r]) => `${channelName(config, c)} ${r.error}`).join('；')}`, stamp, 'error') : log(next, 'Discord 上的訊息已更新', stamp, 'ok');
    }
    return next;
  });
}

/** The result of a channel's test message. */
export function recordTest(config, channelId, requestId, result, now) {
  const stamp = isoLocal(now, config.timezone);
  return {
    ...config,
    channels: config.channels.map((c) =>
      c.id !== channelId
        ? c
        : {
            ...c,
            test: { id: requestId, at: stamp, ok: result.ok, ...(result.ok ? {} : { error: result.error }) },
            ...(result.ok && result.discord ? { discord: { ...(c.discord ?? {}), ...result.discord } } : {}),
          },
    ),
  };
}

export function testPayload(channel, config) {
  return payloadFor(
    {
      payload: {
        embeds: [
          {
            author: { name: '✅ Cue 連線測試' },
            title: `#${channel.name} 已經連上 Cue`,
            description: '之後排程的公告會在指定時間自動出現在這個頻道。這則測試訊息可以直接刪除。',
            color: 0x5865f2,
            ...(config.course || config.footer ? { footer: { text: config.footer || config.course } } : {}),
          },
        ],
        allowed_mentions: { parse: [] },
      },
    },
    channel,
    config,
  );
}

/** Turns a Discord error response into a sentence a TA can act on. */
export function discordError(status, body) {
  const code = body?.code;
  if (status === 0) return '連不上 Discord';
  if (code === 10015 || status === 404) return 'Webhook 已被刪除或網址錯誤，請到頻道設定重新貼上 Webhook（Discord 10015）';
  if (status === 401 || code === 50027) return 'Webhook 金鑰不正確，請重新貼上 Webhook 網址';
  if (code === 10008) return '訊息已經不在 Discord 上了';
  if (status === 429) return 'Discord 限制了發送頻率，稍後會再試';
  if (status === 400) {
    const detail = body?.message ? `：${body.message}` : '';
    return `Discord 拒絕了訊息格式${detail}`;
  }
  if (status >= 500) return `Discord 暫時無法使用（${status}）`;
  return `Discord 回應 ${status}${body?.message ? `：${body.message}` : ''}`;
}
