// The home screen answers "what goes out next, and is anything wrong?"
// — then gets out of the way with a box to paste the next announcement.

import { useMemo, useState } from 'preact/hooks';
import { go, href } from '../../app/router';
import { Icon } from '../../ui/icons';
import { Btn, Empty } from '../../ui/base';
import { kindStyle, type Post } from '../core/model';
import { labelOf, postTime } from '../core/ops';
import { semesterWeek } from '../core/parse';
import { calendarDays, DAY, fmtCountdown, fmtDate, fmtTime, startOfDay, startOfWeek, wall } from '../core/time';
import { DiscordPreview } from '../ui/DiscordPreview';
import { ChannelChips, useData, useNow } from '../ui/parts';
import { sendNow } from './actions';
import { pendingText } from './bridge';
import { openPost } from './PostDetail';
import { PostRow } from './PostRow';
import { SchedulerCard } from './Scheduler';

function greeting(h: number) {
  if (h < 5) return '夜深了';
  if (h < 11) return '早安';
  if (h < 14) return '午安';
  if (h < 18) return '下午好';
  return '晚安';
}

function dayHeading(ms: number, now: number, tz: string) {
  const d = calendarDays(now, ms, tz);
  const base = fmtDate(ms, tz);
  if (d === 0) return `今天 · ${base}`;
  if (d === 1) return `明天 · ${base}`;
  if (d === 2) return `後天 · ${base}`;
  return base;
}

function NextUp({ post }: { post: Post }) {
  const { config, tz } = useData();
  const at = Date.parse(post.at!);
  const now = useNow(at - Date.now() < 3600_000 ? 1000 : 15000);
  const k = kindStyle(config, post.content.kind);
  const ch = config.channels.find((c) => c.id === post.channels[0]);
  const label = labelOf(post);
  return (
    <section class="card next-up" aria-labelledby="next-title">
      <div class="nu-copy stack">
        <span class="eyebrow">下一則公告</span>
        <div class="nu-count" aria-live="off">
          <span class="num-xl">
            {fmtCountdown(at, now)
              .split(/(\d+)/)
              .filter((x) => x.trim())
              .map((x, i) => (/^\d+$/.test(x) ? <span key={i}>{x}</span> : <small key={i}>{x.trim()}</small>))}
          </span>
          <span class="muted">後送出</span>
        </div>
        <div class="stack tight">
          <h2 class="title-m" id="next-title">
            <span aria-hidden="true">{k.emoji}</span> {post.content.title || k.headline}
          </h2>
          <p class="muted small">
            {fmtDate(at, tz)} {fmtTime(at, tz)}
            {label ? ` · ${label}` : ''}
          </p>
        </div>
        <ChannelChips post={post} config={config} />
        <div class="row wrap">
          <Btn size="sm" variant="primary" icon="eye" onClick={() => openPost(post.id)}>
            查看
          </Btn>
          <Btn size="sm" icon="send" onClick={() => sendNow(post)}>
            現在就送
          </Btn>
          <a class="btn sm ghost" href={href(`compose/${post.id}`)}>
            <Icon name="edit" size={16} />
            編輯
          </a>
        </div>
      </div>
      <div class="nu-preview">
        <DiscordPreview payload={post.payload} config={config} channel={ch} at={at} now={now} compact />
      </div>
    </section>
  );
}

/** Shown until the basics are done: a channel, a working webhook, a first post. */
function SetupChecklist() {
  const { config, posts, backend } = useData();
  const steps = [
    { done: true, text: '連接 GitHub，建立資料分支', href: 'settings' },
    { done: config.channels.length > 0, text: '新增第一個 Discord 頻道', href: 'channels' },
    { done: config.channels.some((c) => c.test?.ok), text: '傳送測試訊息，確認 Webhook 可用', href: 'channels' },
    { done: posts.length > 0, text: '貼上第一則公告並排程', href: 'compose' },
  ];
  if (backend?.kind !== 'github' || steps.every((s) => s.done)) return null;
  const next = steps.find((s) => !s.done)!;
  return (
    <section class="card setup" aria-labelledby="setup-title">
      <div class="row between wrap">
        <h2 class="title-s" id="setup-title">
          開始使用 · {steps.filter((s) => s.done).length}/{steps.length}
        </h2>
        <a class="btn sm accent" href={href(next.href)}>
          {next.text}
          <Icon name="arrow" size={16} />
        </a>
      </div>
      <ol class="setup-steps">
        {steps.map((s) => (
          <li key={s.text} class={s.done ? 'done' : ''}>
            <span class="tick" aria-hidden="true">
              {s.done && <Icon name="check" size={14} />}
            </span>
            <a href={href(s.href)}>{s.text}</a>
            {s.done && <span class="sr-only">（完成）</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function QuickPaste() {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    pendingText.set(text);
    go('compose');
  };
  return (
    <form
      class="card quick"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label class="title-s" for="quick-paste">
        有新公告？直接貼上
      </label>
      <textarea
        id="quick-paste"
        class="textarea"
        rows={3}
        placeholder={'例如：作業四 下週五 23:59 前上傳到 Moodle\n遲交扣 10 分'}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="row between">
        <span class="small muted">Cue 會整理成 Discord 格式，送出前你還可以修改。</span>
        <Btn type="submit" variant="accent" icon="spark" disabled={!text.trim()}>
          整理
        </Btn>
      </div>
    </form>
  );
}

export function Overview() {
  const { config, posts, tz } = useData();
  const now = useNow(30000);
  const w = wall(now, tz);
  const week = semesterWeek(now, config.semesterStart, tz);

  const { upcoming, attention, drafts, sentThisWeek, next, recent } = useMemo(() => {
    const scheduled = posts.filter((p) => p.status === 'scheduled' && p.at).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    const weekStart = startOfWeek(now, tz);
    return {
      next: scheduled[0] ?? null,
      upcoming: scheduled.filter((p) => Date.parse(p.at!) < startOfDay(now, tz) + 7 * DAY),
      attention: posts.filter((p) => p.status === 'failed' || p.status === 'missed'),
      drafts: posts.filter((p) => p.status === 'draft'),
      sentThisWeek: posts.filter((p) => p.sentAt && Date.parse(p.sentAt) >= weekStart).length,
      recent: posts
        .filter((p) => p.sentAt && (p.status === 'sent' || p.status === 'retracted'))
        .sort((a, b) => Date.parse(b.sentAt!) - Date.parse(a.sentAt!))
        .slice(0, 5),
    };
  }, [posts, now, tz]);

  const scheduledCount = posts.filter((p) => p.status === 'scheduled').length;
  const byDay = new Map<string, Post[]>();
  for (const p of upcoming) {
    const key = fmtDate(Date.parse(p.at!), tz);
    byDay.set(key, [...(byDay.get(key) ?? []), p]);
  }

  return (
    <div class="cue-page enter">
      <header class="page-head">
        <div class="stack tight">
          <span class="eyebrow">
            {w.m} 月 {w.d} 日 星期{'一二三四五六日'[w.dow - 1]}
            {week ? ` · 第 ${week} 週` : ''}
            {config.course ? ` · ${config.course}` : ''}
          </span>
          <h1 class="title-l">{greeting(w.h)}，今天要發什麼？</h1>
        </div>
      </header>

      <div class="ov-grid">
        <div class="stack loose" style={{ minWidth: 0 }}>
          <SetupChecklist />
          {next ? (
            <NextUp post={next} />
          ) : (
            <section class="card next-up empty-next">
              <Empty icon="clock" title="沒有排程中的公告">
                貼上一段文字，Cue 會幫你排好。
              </Empty>
            </section>
          )}

          <ul class="stats">
            <li>
              <a class="stat" href={href('posts/scheduled')}>
                <b class="mono">{scheduledCount}</b>
                <span>排程中</span>
              </a>
            </li>
            <li>
              <a class="stat" href={href('posts/sent')}>
                <b class="mono">{sentThisWeek}</b>
                <span>本週已發送</span>
              </a>
            </li>
            <li>
              <a class={`stat ${attention.length ? 'bad' : ''}`} href={href('posts/attention')}>
                <b class="mono">{attention.length}</b>
                <span>需要處理</span>
              </a>
            </li>
            <li>
              <a class="stat" href={href('posts/draft')}>
                <b class="mono">{drafts.length}</b>
                <span>草稿</span>
              </a>
            </li>
          </ul>

          {attention.length > 0 && (
            <section class="section">
              <div class="section-head">
                <h2>需要處理</h2>
                <a class="small" href={href('posts/attention')}>
                  全部
                </a>
              </div>
              <div class="list">
                {attention.slice(0, 4).map((p) => (
                  <PostRow key={p.id} post={p} config={config} date />
                ))}
              </div>
            </section>
          )}

          <section class="section">
            <div class="section-head">
              <h2>接下來 7 天</h2>
              <a class="small" href={href('calendar')}>
                看行事曆
              </a>
            </div>
            {upcoming.length === 0 ? (
              <Empty icon="calendar" title="這一週沒有排程">
                <a href={href('compose')}>撰寫一則公告</a>
              </Empty>
            ) : (
              <div class="days">
                {[...byDay.entries()].map(([key, list]) => (
                  <div class="day-group" key={key}>
                    <div class="day-head">{dayHeading(Date.parse(list[0].at!), now, tz)}</div>
                    <div class="list">
                      {list.map((p) => (
                        <PostRow key={p.id} post={p} config={config} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside class="stack loose ov-side">
          <QuickPaste />
          <SchedulerCard />
          <section class="section">
            <div class="section-head">
              <h2>最近送出</h2>
              <a class="small" href={href('posts/sent')}>
                全部
              </a>
            </div>
            {recent.length === 0 ? (
              <p class="small muted">還沒有送出的公告。</p>
            ) : (
              <ol class="recent">
                {recent.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => openPost(p.id)}>
                      <span class="r-dot" style={{ background: kindStyle(config, p.content.kind).color }} aria-hidden="true" />
                      <span class="grow">
                        <span class="r-title">{p.content.title}</span>
                        <span class="r-sub">
                          {fmtDate(postTime(p)!, tz)} {fmtTime(postTime(p)!, tz)} · {p.channels.map((c) => `#${config.channels.find((x) => x.id === c)?.name ?? '?'}`).join(' ')}
                        </span>
                      </span>
                      {p.status === 'retracted' && <span class="chip sm st-retracted">已撤回</span>}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {config.channels.length === 0 && (
            <div class="notice info">
              <Icon name="hash" />
              <div class="stack tight">
                <b>先新增一個 Discord 頻道</b>
                <span class="small">每個頻道貼一次 Webhook 網址，之後就能排程發送。</span>
                <div>
                  <a class="btn sm" href={href('channels')}>
                    新增頻道
                  </a>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
