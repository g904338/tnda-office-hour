// A month of posts. Each post sits on the day it goes out; deadlines and
// class times can be shown too. Drag a queued post to another day to move
// it (same time of day), or pick a day to see its agenda and add to it.

import { useMemo, useState } from 'preact/hooks';
import { go, href } from '../../app/router';
import { Icon } from '../../ui/icons';
import { Btn, Empty } from '../../ui/base';
import { toast } from '../../ui/toast';
import { kindStyle, type Post } from '../core/model';
import { postTime } from '../core/ops';
import { semesterWeek } from '../core/parse';
import { dayKey, DOW_ZH, fmtDate, fmtTime, parseDayKey, startOfWeek, wall, zoned } from '../core/time';
import { PageHead, StatusChip, useData, useNow } from '../ui/parts';
import { reschedule } from './actions';
import { pendingDay } from './bridge';
import { openPost } from './PostDetail';

interface Item {
  post: Post;
  at: number;
  type: 'send' | 'event';
}

export function CalendarPage({ month }: { month: string | null }) {
  const { config, posts, tz } = useData();
  const now = useNow(60000);
  const today = dayKey(now, tz);
  const cur = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : today.slice(0, 7);
  const [y, m] = cur.split('-').map(Number);
  const [layers, setLayers] = useState({ send: true, event: true });
  const [picked, setPicked] = useState<string | null>(today.startsWith(cur) ? today : null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const monthLink = (dy: number, dm: number) => {
    const d = new Date(Date.UTC(dy, dm - 1, 1));
    return `calendar/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const weeks = useMemo(() => {
    const key = (ms: number) => {
      const w = wall(ms, tz);
      return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
    };
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = key(zoned(y, m, lastDay, 12, 0, tz));
    let cursor = startOfWeek(zoned(y, m, 1, 12, 0, tz), tz);
    const rows: string[][] = [];
    for (let r = 0; r < 6; r++) {
      const row: string[] = [];
      for (let c = 0; c < 7; c++) {
        const w = wall(cursor, tz);
        row.push(key(cursor));
        cursor = zoned(w.y, w.m, w.d + 1, 12, 0, tz);
      }
      rows.push(row);
      if (row[6] >= end) break;
    }
    return rows;
  }, [y, m, tz]);

  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>();
    const add = (key: string, item: Item) => map.set(key, [...(map.get(key) ?? []), item]);
    // reminders share their event: show each event once
    const seen = new Set<string>();
    for (const p of posts) {
      const t = postTime(p);
      if (t !== null && layers.send) add(dayKey(t, tz), { post: p, at: t, type: 'send' });
      if (layers.event && p.content.when && p.status !== 'retracted') {
        const id = `${p.series?.id ?? p.id}|${p.content.when.at}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const e = Date.parse(p.content.when.at);
        add(dayKey(e, tz), { post: p, at: e, type: 'event' });
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.at - b.at || (a.type === 'event' ? 1 : -1));
    return map;
  }, [posts, layers, tz]);

  async function drop(key: string) {
    const id = dragging;
    setDragging(null);
    setOver(null);
    const post = posts.find((p) => p.id === id);
    if (!post || !post.at) return;
    const old = wall(Date.parse(post.at), tz);
    const d = parseDayKey(key);
    const at = zoned(d.y, d.m, d.d, old.h, old.min, tz);
    if (dayKey(Date.parse(post.at), tz) === key) return;
    if (at < Date.now()) {
      toast('不能改到已經過去的時間。', { kind: 'error' });
      return;
    }
    await reschedule(post, at);
  }

  const pickedItems = picked ? byDay.get(picked) ?? [] : [];

  return (
    <div class="cue-page enter cal-page">
      <PageHead title="行事曆" sub="公告排在送出的那一天；把排程中的公告拖到別天就能改日期。">
        <div class="layer-toggle" role="group" aria-label="顯示">
          <button type="button" aria-pressed={layers.send} onClick={() => setLayers((l) => ({ ...l, send: !l.send }))}>
            <span class="dot send" aria-hidden="true" />
            發送
          </button>
          <button type="button" aria-pressed={layers.event} onClick={() => setLayers((l) => ({ ...l, event: !l.event }))}>
            <span class="dot event" aria-hidden="true" />
            截止與活動
          </button>
        </div>
      </PageHead>

      <div class="cal-bar">
        <a class="btn icon ghost" href={href(monthLink(y, m - 1))} aria-label="上個月">
          <Icon name="left" />
        </a>
        <h2 class="title-m mono-num">
          {y} 年 {m} 月
        </h2>
        <a class="btn icon ghost" href={href(monthLink(y, m + 1))} aria-label="下個月">
          <Icon name="right" />
        </a>
        <a class="btn sm" href={href('calendar')} onClick={() => setPicked(today)}>
          今天
        </a>
      </div>

      <div class="cal-wrap">
        <div class="cal" role="grid" aria-label={`${y} 年 ${m} 月`}>
          <div class="cal-row cal-dow" role="row">
            <span class="cal-wk" aria-hidden="true" />
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <span key={d} role="columnheader" class={d >= 6 ? 'we' : ''}>
                {DOW_ZH[d]}
              </span>
            ))}
          </div>
          {weeks.map((row) => {
            const wk = semesterWeek(zoned(+row[0].slice(0, 4), +row[0].slice(5, 7), +row[0].slice(8, 10), 12, 0, tz), config.semesterStart, tz);
            return (
              <div class="cal-row" role="row" key={row[0]}>
                <span class="cal-wk" title={wk ? `第 ${wk} 週` : undefined}>
                  {wk ? `W${wk}` : ''}
                </span>
                {row.map((key) => {
                  const items = byDay.get(key) ?? [];
                  const d = parseDayKey(key);
                  const inMonth = key.startsWith(cur);
                  const past = key < today;
                  return (
                    <div
                      key={key}
                      role="gridcell"
                      aria-selected={picked === key}
                      class={`cal-day ${inMonth ? '' : 'out'} ${key === today ? 'today' : ''} ${past ? 'past' : ''} ${over === key ? 'over' : ''}`}
                      onClick={() => setPicked(key)}
                      onDragOver={(e) => {
                        if (!dragging || past) return;
                        e.preventDefault();
                        setOver(key);
                      }}
                      onDragLeave={() => setOver((o) => (o === key ? null : o))}
                      onDrop={(e) => {
                        e.preventDefault();
                        drop(key);
                      }}
                    >
                      <span class="cal-num">{d.d === 1 ? `${d.m}/${d.d}` : d.d}</span>
                      <div class="cal-items">
                        {items.slice(0, 3).map((it) => {
                          const k = kindStyle(config, it.post.content.kind);
                          const movable = it.type === 'send' && it.post.status === 'scheduled';
                          return (
                            <button
                              type="button"
                              key={`${it.type}-${it.post.id}`}
                              class={`cal-item ${it.type} st-${it.post.status}`}
                              style={{ '--k': k.color } as any}
                              draggable={movable}
                              title={`${fmtTime(it.at, tz)} ${it.type === 'event' ? `${k.whenLabel}：` : ''}${it.post.content.title}`}
                              onDragStart={(e) => {
                                setDragging(it.post.id);
                                e.dataTransfer?.setData('text/plain', it.post.id);
                              }}
                              onDragEnd={() => {
                                setDragging(null);
                                setOver(null);
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                openPost(it.post.id);
                              }}
                            >
                              <span class="t mono">{it.type === 'event' ? k.emoji : fmtTime(it.at, tz)}</span>
                              <span class="n">{it.post.content.title}</span>
                            </button>
                          );
                        })}
                        {items.length > 3 && <span class="cal-more">+{items.length - 3}</span>}
                        {items.length > 0 && (
                          <span class="cal-dots" aria-hidden="true">
                            {items.slice(0, 4).map((it) => (
                              <i key={`${it.type}-${it.post.id}`} class={it.type} style={{ background: kindStyle(config, it.post.content.kind).color }} />
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <aside class="card cal-agenda" aria-live="polite">
          {picked ? (
            <div class="stack">
              <div class="row between">
                <div class="stack tight">
                  <span class="eyebrow">{picked === today ? '今天' : ''}</span>
                  <h3 class="title-m">{fmtDate(zoned(+picked.slice(0, 4), +picked.slice(5, 7), +picked.slice(8, 10), 12, 0, tz), tz)}</h3>
                </div>
                {picked >= today && (
                  <Btn
                    size="sm"
                    icon="plus"
                    onClick={() => {
                      pendingDay.set(picked);
                      go('compose');
                    }}
                  >
                    在這天發
                  </Btn>
                )}
              </div>
              {pickedItems.length === 0 ? (
                <p class="small muted">這天沒有排程。</p>
              ) : (
                <ol class="agenda">
                  {pickedItems.map((it) => {
                    const k = kindStyle(config, it.post.content.kind);
                    return (
                      <li key={`${it.type}-${it.post.id}`}>
                        <button type="button" onClick={() => openPost(it.post.id)} style={{ '--k': k.color } as any}>
                          <span class="mono t">{fmtTime(it.at, tz)}</span>
                          <span class="grow stack" style={{ gap: '2px' }}>
                            <span class="a-title">
                              {k.emoji} {it.post.content.title}
                            </span>
                            <span class="small muted">{it.type === 'event' ? k.whenLabel : `發到 ${it.post.channels.map((c) => `#${config.channels.find((x) => x.id === c)?.name ?? '?'}`).join(' ')}`}</span>
                          </span>
                          {it.type === 'send' && <StatusChip status={it.post.status} small />}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          ) : (
            <Empty icon="calendar" title="點一天看看">
              看那天要發的公告、截止的作業。
            </Empty>
          )}
        </aside>
      </div>
    </div>
  );
}
