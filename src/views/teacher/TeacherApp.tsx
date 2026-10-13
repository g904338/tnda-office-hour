import { useState } from 'preact/hooks';
import type { TeacherSession, TeacherState } from '../../api/types';
import { clock, useDiff, useLive, useTick } from '../../app/hooks';
import { signOut } from '../../app/session';
import { downloadIcs } from '../../lib/files';
import { greeting, timeRange } from '../../lib/format';
import { addMinutes, agoText, DOW, dayLabel, instant, md, relativeDay, tzNote, untilText } from '../../lib/time';
import { confirm } from '../../ui/dialog';
import { toast } from '../../ui/toast';
import { Icon } from '../../ui/icons';
import { BrandMark, Btn, Empty, LiveBadge, Loading, Menu, safeHref } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';

export function TeacherApp() {
  const { data, error, reload } = useLive<TeacherState>('oh_teacher_state');
  useDiff(data, (prev, next) => {
    const before = new Map(prev.mine.map((m) => [m.id, m]));
    for (const m of next.mine) {
      const old = before.get(m.id);
      if (m.status === 'confirmed' && !old) toast(`新的場次：${dayLabel(m.d)} ${m.t} 第 ${m.group.no} 組`, { ms: 7000 });
      if (m.status === 'cancelled' && old?.status === 'confirmed') toast(`第 ${m.group.no} 組取消了 ${dayLabel(m.d)} ${m.t}`, { kind: 'error', ms: 8000 });
    }
  });
  return (
    <>
      <header class="topbar">
        <div class="topbar-inner">
          <BrandMark code={data?.settings.course_code} sub={data ? data.settings.host_label : undefined} />
          <span class="grow" />
          <LiveBadge />
          {data && (
            <Menu
              label="帳號選單"
              trigger={
                <>
                  <Icon name="user" size={16} />
                  <span>{data.me.name}</span>
                  <Icon name="down" size={14} />
                </>
              }
            >
              {(close) => (
                <button
                  type="button"
                  class="mi danger"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    if (await confirm({ title: '登出這台裝置？', body: '之後需要再輸入一次你的代碼。', ok: '登出', danger: true })) signOut();
                  }}
                >
                  <Icon name="logout" /> 登出
                </button>
              )}
            </Menu>
          )}
        </div>
      </header>
      {data ? <TeacherHome st={data} /> : error ? <ErrorState onRetry={reload} /> : <Loading />}
    </>
  );
}

function TeacherHome({ st }: { st: TeacherState }) {
  const now = useTick();
  const mins = st.settings.slot_minutes;
  const tz = st.clock.tz;
  const end = (s: { d: string; t: string }) => instant(s.d, addMinutes(s.t, mins), tz);
  const live = st.mine.filter((s) => s.status === 'confirmed');
  const upcoming = live.filter((s) => end(s) > now);
  const past = live.filter((s) => end(s) <= now).reverse();
  const cancelled = st.mine.filter((s) => s.status === 'cancelled');
  const next = upcoming[0];
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));

  const byDay = new Map<string, TeacherSession[]>();
  for (const s of [...upcoming, ...cancelled.filter((c) => end(c) > now)].sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t))) {
    const l = byDay.get(s.d) ?? [];
    l.push(s);
    byDay.set(s.d, l);
  }

  const exportAll = () =>
    downloadIcs(
      'office-hour-pm.ics',
      upcoming.map((s) => ({
        uid: `oh-${s.id}@tnda-office-hour`,
        d: s.d,
        t: s.t,
        minutes: mins,
        tz,
        title: `Office Hour · 第 ${s.group.no} 組${s.request?.topic ? `｜${s.request.topic}` : ''}`,
        location: st.settings.location,
        description: [s.request?.progress, s.request?.link].filter(Boolean).join('\n\n'),
      })),
      `Office Hour · ${st.me.name}`,
    );

  return (
    <main class="page enter">
      <div class="stack tight">
        <p class="eyebrow">
          {greeting(hour)}，{st.me.name}
        </p>
        <h1 class="title-l">
          {upcoming.length ? `接下來有 ${upcoming.length} 場 Office Hour` : '目前沒有排定的 Office Hour'}
        </h1>
      </div>

      {next && (
        <section class="hero" aria-label="下一場">
          <div class="row between wrap">
            <p class="eyebrow">下一場</p>
            <span class="countdown">
              <Icon name="clock" size={14} />
              {untilText(instant(next.d, next.t, tz) - now)}
            </span>
          </div>
          <div class="stack tight">
            <span class="day">
              {relativeDay(next.d, clock.today) ? `${relativeDay(next.d, clock.today)}・` : ''}
              {dayLabel(next.d)}
            </span>
            <span class="num-xl">{timeRange(next.t, mins)}</span>
            {tzNote(tz) && <span class="small" style={{ opacity: 0.7 }}>以上為{tzNote(tz)}</span>}
          </div>
          <div class="stack tight">
            <p class="title-m">
              第 {next.group.no} 組{next.group.name ? `「${next.group.name}」` : ''}
            </p>
            {next.request && <p style={{ opacity: 0.85 }}>{next.request.topic}</p>}
          </div>
          <div class="meta">
            <span>
              <Icon name="pin" size={16} />
              {st.settings.location || '線上'}
            </span>
            {next.request && (
              <span>
                <Icon name="user" size={16} />
                {next.request.author} 填寫
              </span>
            )}
          </div>
          <div class="row wrap">
            {safeHref(next.request?.link) && (
              <a class="btn solid" href={safeHref(next.request?.link)} target="_blank" rel="noopener noreferrer">
                <Icon name="external" /> 打開雲端資料夾
              </a>
            )}
            <Btn icon="calendar" onClick={exportAll}>
              全部加入行事曆
            </Btn>
          </div>
        </section>
      )}

      <section class="section" aria-labelledby="t-agenda">
        <div class="section-head">
          <h2 id="t-agenda">我的場次</h2>
          {upcoming.length > 0 && !next && (
            <Btn size="sm" icon="calendar" onClick={exportAll}>
              加入行事曆
            </Btn>
          )}
        </div>
        {byDay.size === 0 ? (
          <Empty icon="calendar" title="還沒有排到你的場次">
            助教排好時間後，這裡會即時出現各組的題目與進度。
          </Empty>
        ) : (
          <div class="stack">
            {[...byDay.entries()].map(([d, list]) => (
              <div class="stack tight" key={d}>
                <p class="small" style={{ fontWeight: 700 }}>
                  {relativeDay(d, clock.today) ? `${relativeDay(d, clock.today)}・` : ''}
                  {dayLabel(d)}
                </p>
                <div class="list">
                  {list.map((s) => (
                    <SessionCard key={s.id} s={s} mins={mins} now={now} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <TeamWeek st={st} now={now} />

      <section class="section" aria-labelledby="t-avail">
        <div class="section-head">
          <h2 id="t-avail">我的開放時段</h2>
          <span class="small muted">需要調整請聯絡助教</span>
        </div>
        {st.blocks.length ? (
          <div class="row wrap">
            {st.blocks.map((b, i) => (
              <span class="chip outline" key={i}>
                {b.dow ? `每${DOW[b.dow]}` : `${md(b.on_date!)}（單次）`}{' '}
                <span class="mono">
                  {b.start}–{b.end}
                </span>
                {b.valid_to && <span class="faint">至 {md(b.valid_to)}</span>}
              </span>
            ))}
          </div>
        ) : (
          <p class="muted small">目前沒有設定開放時段。</p>
        )}
        {st.closures.length > 0 && (
          <div class="row wrap">
            {st.closures.map((c, i) => (
              <span class={`chip ${c.mine ? 'warn' : ''}`} key={i}>
                {md(c.d)} {c.reason || (c.mine ? '請假' : '休息')}
              </span>
            ))}
          </div>
        )}
      </section>

      {past.length > 0 && <PastSessions list={past} />}
    </main>
  );
}

function SessionCard({ s, mins, now }: { s: TeacherSession; mins: number; now: number }) {
  const [open, setOpen] = useState(false);
  const cancelled = s.status === 'cancelled';
  const r = s.request;
  return (
    <div class={`li top ${cancelled ? 'cancelled' : ''}`}>
      <div class="when">
        <b>{s.t}</b>
        <span class="mono">{addMinutes(s.t, mins)}</span>
      </div>
      <div class="grow stack tight">
        <div class="row wrap" style={{ gap: '8px' }}>
          <span class="gno">{s.group.no}</span>
          <b>{s.group.name || `第 ${s.group.no} 組`}</b>
          {cancelled && <span class="chip danger">已取消{s.cancel_reason ? `：${s.cancel_reason}` : ''}</span>}
        </div>
        {r ? (
          <>
            <p style={{ fontWeight: 600 }}>{r.topic}</p>
            <p class={`small muted pre ${open ? '' : 'clamp-2'}`}>{r.progress}</p>
            <div class="row wrap small">
              {r.progress.length > 60 && (
                <button type="button" class="link-btn" onClick={() => setOpen(!open)}>
                  {open ? '收起' : '展開進度'}
                </button>
              )}
              {safeHref(r.link) && (
                <a href={safeHref(r.link)} target="_blank" rel="noopener noreferrer" class="row" style={{ gap: '4px' }}>
                  <Icon name="external" size={14} /> 雲端資料夾
                </a>
              )}
              <span class="faint tiny">
                {r.author} · {agoText(r.updated_at, now)}更新
              </span>
            </div>
          </>
        ) : (
          <p class="small muted">這組沒有填寫題目。</p>
        )}
      </div>
    </div>
  );
}

function TeamWeek({ st, now }: { st: TeacherState; now: number }) {
  if (!st.team.length) return null;
  const mins = st.settings.slot_minutes;
  return (
    <section class="section" aria-labelledby="t-team">
      <div class="section-head">
        <h2 id="t-team">這兩週全部場次</h2>
        <span class="small muted">標示橘色的是你的場次</span>
      </div>
      <div class="list">
        {st.team.map((x, i) => {
          const past = instant(x.d, addMinutes(x.t, mins), st.clock.tz) <= now;
          return (
            <div key={i} class={`li ${past ? 'past' : ''}`} style={x.mine ? { background: 'var(--accent-soft)' } : undefined}>
              <div class="when">
                <b>{x.t}</b>
                <span>{dayLabel(x.d)}</span>
              </div>
              <div class="grow stack" style={{ gap: '2px' }}>
                <span class="row" style={{ gap: '8px' }}>
                  <span class="gno soft">{x.group.no}</span>
                  <span class="small" style={{ fontWeight: 600 }}>
                    {x.group.name || `第 ${x.group.no} 組`}
                  </span>
                </span>
                {x.topic && <span class="small muted clamp-2">{x.topic}</span>}
              </div>
              <span class={`chip ${x.mine ? 'accent' : ''}`}>{x.teacher}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PastSessions({ list }: { list: TeacherSession[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section class="section" aria-labelledby="t-past">
      <div class="section-head">
        <h2 id="t-past">最近四週已完成</h2>
        <button type="button" class="link-btn small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '收起' : `顯示 ${list.length} 場`}
        </button>
      </div>
      {open && (
        <div class="list">
          {list.map((s) => (
            <div class="li past" key={s.id}>
              <div class="when">
                <b>{s.t}</b>
                <span>{dayLabel(s.d)}</span>
              </div>
              <div class="grow">
                <span class="gno soft" style={{ marginRight: '8px' }}>
                  {s.group.no}
                </span>
                {s.request?.topic ?? '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
