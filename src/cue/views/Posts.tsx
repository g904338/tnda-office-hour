// Every post, past and future, grouped by day. Filters live in the URL
// (#/posts/scheduled) so the overview's counters link straight here.

import { useMemo, useState } from 'preact/hooks';
import { go, href } from '../../app/router';
import { Icon } from '../../ui/icons';
import { Btn, Empty } from '../../ui/base';
import { KIND_ORDER, kindStyle, STATUS_TEXT, type KindKey, type Post } from '../core/model';
import { postTime } from '../core/ops';
import { calendarDays, dayKey, fmtDate, isoLocal } from '../core/time';
import { PageHead, useData, useNow } from '../ui/parts';
import { PostRow } from './PostRow';

type Filter = 'all' | 'scheduled' | 'sent' | 'attention' | 'draft';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'scheduled', label: '排程中' },
  { id: 'sent', label: '已發送' },
  { id: 'attention', label: '需要處理' },
  { id: 'draft', label: '草稿' },
];

function matches(p: Post, f: Filter) {
  switch (f) {
    case 'scheduled':
      return p.status === 'scheduled' || p.status === 'sending';
    case 'sent':
      return p.status === 'sent' || p.status === 'retracted';
    case 'attention':
      return p.status === 'failed' || p.status === 'missed';
    case 'draft':
      return p.status === 'draft';
    default:
      return true;
  }
}

function csv(rows: string[][]): string {
  const cell = (v: string) => {
    // a leading = + - @ would run as a formula in Excel
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

export function PostsPage({ filter }: { filter: string | null }) {
  const { config, posts, tz } = useData();
  const now = useNow(60000);
  const f: Filter = (FILTERS.some((x) => x.id === filter) ? filter : 'all') as Filter;
  const [q, setQ] = useState('');
  const [channel, setChannel] = useState('');
  const [kind, setKind] = useState<KindKey | ''>('');

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((x) => [x.id, posts.filter((p) => matches(p, x.id)).length])) as Record<Filter, number>, [posts]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return posts.filter(
      (p) =>
        matches(p, f) &&
        (!channel || p.channels.includes(channel)) &&
        (!kind || p.content.kind === kind) &&
        (!needle || `${p.content.title}\n${p.content.body}\n${p.source}\n${p.content.notes.join('\n')}`.toLowerCase().includes(needle)),
    );
  }, [posts, f, q, channel, kind]);

  const { upcoming, past, drafts } = useMemo(() => {
    const upcoming: Post[] = [];
    const past: Post[] = [];
    const drafts: Post[] = [];
    for (const p of list) {
      const t = postTime(p);
      if (t === null) drafts.push(p);
      else if ((p.status === 'scheduled' || p.status === 'sending') && t >= now - 60_000) upcoming.push(p);
      else past.push(p);
    }
    upcoming.sort((a, b) => postTime(a)! - postTime(b)!);
    past.sort((a, b) => postTime(b)! - postTime(a)!);
    drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { upcoming, past, drafts };
  }, [list, now]);

  function group(items: Post[]) {
    const out: Array<{ key: string; label: string; items: Post[] }> = [];
    for (const p of items) {
      const t = postTime(p)!;
      const key = dayKey(t, tz);
      let g = out[out.length - 1];
      if (!g || g.key !== key) {
        const d = calendarDays(now, t, tz);
        const label = d === 0 ? `今天 · ${fmtDate(t, tz)}` : d === 1 ? `明天 · ${fmtDate(t, tz)}` : d === -1 ? `昨天 · ${fmtDate(t, tz)}` : fmtDate(t, tz, { year: Math.abs(d) > 200 });
        g = { key, label, items: [] };
        out.push(g);
      }
      g.items.push(p);
    }
    return out;
  }

  function exportCsv() {
    const rows = [
      ['狀態', '發送時間', '類型', '標題', '頻道', '事件時間', '內文'],
      ...list.map((p) => [
        STATUS_TEXT[p.status],
        postTime(p) ? isoLocal(postTime(p)!, tz).slice(0, 16).replace('T', ' ') : '',
        kindStyle(config, p.content.kind).label,
        p.content.title,
        p.channels.map((c) => config.channels.find((x) => x.id === c)?.name ?? c).join('、'),
        p.content.when ? p.content.when.at.slice(0, 16).replace('T', ' ') : '',
        p.content.body,
      ]),
    ];
    const blob = new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cue-posts-${dayKey(Date.now(), tz)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const sections: Array<{ title: string; groups: ReturnType<typeof group>; flat?: Post[] }> = [];
  if (upcoming.length) sections.push({ title: '接下來', groups: group(upcoming) });
  if (drafts.length) sections.push({ title: '草稿', groups: [], flat: drafts });
  if (past.length) sections.push({ title: f === 'attention' ? '需要處理' : '已經過去', groups: group(past) });

  return (
    <div class="cue-page enter">
      <PageHead title="發文紀錄" sub="每一則發過、要發的公告，以及它們在每個頻道的結果。">
        <Btn variant="ghost" icon="download" onClick={exportCsv} disabled={!list.length}>
          匯出 CSV
        </Btn>
        <a class="btn accent" href={href('compose')}>
          <Icon name="pen" />
          撰寫
        </a>
      </PageHead>

      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="篩選">
          {FILTERS.map((x) => (
            <a key={x.id} role="tab" aria-selected={f === x.id} href={href(x.id === 'all' ? 'posts' : `posts/${x.id}`)} class={x.id === 'attention' && counts.attention ? 'bad' : ''}>
              {x.label}
              <span class="mono">{counts[x.id]}</span>
            </a>
          ))}
        </div>
        <div class="row wrap filters">
          <label class="search">
            <Icon name="search" size={16} />
            <input data-search type="search" class="input sm" placeholder="搜尋標題或內文（/）" aria-label="搜尋" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </label>
          <select class="select sm" aria-label="頻道" value={channel} onChange={(e) => setChannel((e.target as HTMLSelectElement).value)}>
            <option value="">所有頻道</option>
            {config.channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.name}
              </option>
            ))}
          </select>
          <select class="select sm" aria-label="類型" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as KindKey | '')}>
            <option value="">所有類型</option>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {kindStyle(config, k).emoji} {kindStyle(config, k).label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {list.length === 0 ? (
        <Empty icon="inbox" title={q || channel || kind ? '沒有符合的貼文' : f === 'attention' ? '沒有需要處理的貼文' : '這裡還沒有貼文'}>
          {q || channel || kind ? (
            <button
              type="button"
              class="link-btn"
              onClick={() => {
                setQ('');
                setChannel('');
                setKind('');
              }}
            >
              清除篩選
            </button>
          ) : (
            <button type="button" class="link-btn" onClick={() => go('compose')}>
              撰寫第一則
            </button>
          )}
        </Empty>
      ) : (
        sections.map((s) => (
          <section class="section" key={s.title}>
            <div class="section-head">
              <h2>{s.title}</h2>
              <span class="small muted">{s.flat ? s.flat.length : s.groups.reduce((n, g) => n + g.items.length, 0)} 則</span>
            </div>
            {s.flat ? (
              <div class="list">
                {s.flat.map((p) => (
                  <PostRow key={p.id} post={p} config={config} />
                ))}
              </div>
            ) : (
              <div class="days">
                {s.groups.map((g) => (
                  <div class="day-group" key={g.key}>
                    <div class="day-head">{g.label}</div>
                    <div class="list">
                      {g.items.map((p) => (
                        <PostRow key={p.id} post={p} config={config} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
