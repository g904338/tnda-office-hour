// Small pieces every Cue screen uses.

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { app } from '../app/state';
import { kindStyle, STATUS_TEXT, type Channel, type Config, type KindKey, type Post, type PostStatus } from '../core/model';
import { fmtDateTime, fmtRelative, fmtTime } from '../core/time';
import { Icon, type IconName } from '../../ui/icons';

/** Re-renders every `ms` and returns the current time. */
export function useNow(ms = 30000): number {
  const [now, set] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useData() {
  const st = app.use();
  return { ...st, config: st.config!, tz: st.config?.timezone ?? 'Asia/Taipei' };
}

export function CueMark({ size = 32 }: { size?: number }) {
  return (
    <span class="cue-mark" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <i />
    </span>
  );
}

export function Brand({ sub }: { sub?: string }) {
  return (
    <span class="brand">
      <CueMark />
      <span class="stack" style={{ gap: '0px', lineHeight: 1.2 }}>
        <span class="brand-name">Cue</span>
        <span class="brand-code">{sub ?? '課堂公告排程'}</span>
      </span>
    </span>
  );
}

const STATUS_ICON: Record<PostStatus, IconName> = {
  draft: 'file',
  scheduled: 'clock',
  sending: 'send',
  sent: 'check',
  failed: 'alert',
  missed: 'pause',
  retracted: 'undo',
};

export function StatusChip({ status, small }: { status: PostStatus; small?: boolean }) {
  return (
    <span class={`chip st-${status} ${small ? 'sm' : ''}`}>
      <Icon name={STATUS_ICON[status]} size={13} />
      {STATUS_TEXT[status]}
    </span>
  );
}

export function KindTag({ kind, config }: { kind: KindKey; config: Config | null }) {
  const k = kindStyle(config, kind);
  return (
    <span class="kind-tag" style={{ '--k': k.color } as any}>
      <span aria-hidden="true">{k.emoji}</span>
      {k.label}
    </span>
  );
}

export function ChannelChip({ channel, status }: { channel?: Channel; id?: string; status?: 'sent' | 'failed' | 'pending' | 'deleted' }) {
  return (
    <span class={`ch-chip ${status ? `d-${status}` : ''} ${channel ? '' : 'gone'}`} style={{ '--c': channel?.color ?? '#888' } as any} title={channel?.note || undefined}>
      <span aria-hidden="true">{channel?.emoji ?? '💬'}</span>
      {channel ? channel.name : '已刪除的頻道'}
      {status === 'sent' && <Icon name="check" size={12} />}
      {status === 'failed' && <Icon name="alert" size={12} />}
    </span>
  );
}

export function ChannelChips({ post, config, deliveries }: { post: Post; config: Config; deliveries?: boolean }) {
  return (
    <span class="ch-chips">
      {post.channels.map((id) => (
        <ChannelChip
          key={id}
          id={id}
          channel={config.channels.find((c) => c.id === id)}
          status={deliveries ? post.deliveries.find((d) => d.channel === id)?.status : undefined}
        />
      ))}
      {!post.channels.length && <span class="faint small">沒有頻道</span>}
    </span>
  );
}

/** "3 小時後" that keeps itself current; the full time in a tooltip. */
export function Rel({ ms, tz }: { ms: number; tz: string }) {
  const now = useNow(30000);
  return (
    <time dateTime={new Date(ms).toISOString()} title={fmtDateTime(ms, tz, now)}>
      {fmtRelative(ms, now)}
    </time>
  );
}

export function TimeCell({ ms, tz }: { ms: number | null; tz: string }) {
  if (ms === null) return <span class="faint">未排程</span>;
  return (
    <span class="time-cell">
      <b class="mono">{fmtTime(ms, tz)}</b>
      <span>
        <Rel ms={ms} tz={tz} />
      </span>
    </span>
  );
}

export function PageHead({ title, sub, children }: { title: ComponentChildren; sub?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <header class="page-head">
      <div class="stack tight" style={{ minWidth: 0 }}>
        <h1 class="title-l">{title}</h1>
        {sub && <p class="muted">{sub}</p>}
      </div>
      {children && <div class="row wrap">{children}</div>}
    </header>
  );
}

export function SyncBadge() {
  const { sync, backend } = app.use();
  const now = useNow(15000);
  if (backend?.kind === 'demo')
    return (
      <span class="live" title="示範資料只存在這個瀏覽器">
        <i aria-hidden="true" style={{ background: 'var(--accent)' }} />
        示範資料
      </span>
    );
  const text =
    sync.state === 'saving'
      ? '儲存中…'
      : sync.state === 'offline'
        ? '離線中'
        : sync.state === 'error'
          ? '同步失敗'
          : sync.at
            ? `已同步 · ${fmtRelative(sync.at, now)}`
            : '已同步';
  const cls = sync.state === 'synced' ? '' : sync.state === 'saving' ? 'connecting' : 'offline';
  return (
    <span class={`live ${cls}`} title={sync.message ?? '資料存在 GitHub，所有裝置自動同步'}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}
