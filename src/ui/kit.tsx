import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useEngineStatus } from '../app/hooks';
import { useApp } from '../app/session';
import { addDays, mdPad } from '../lib/time';

// The generic building blocks live in ./base so other apps can use them
// without pulling in Office Hour's session and engine.
export { Btn, CopyBtn, Empty, Field, Loading, Menu, QR, Seg, Spinner, Switch, copyText, safeHref } from './base';

export function BrandMark({ code, sub }: { code?: string; sub?: string }) {
  return (
    <span class="brand">
      <span class="brand-mark" aria-hidden="true">
        OH
      </span>
      <span class="stack" style={{ gap: '0px', lineHeight: 1.2 }}>
        <span class="brand-name">Office Hour</span>
        {(code || sub) && <span class="brand-code">{[code, sub].filter(Boolean).join(' · ')}</span>}
      </span>
    </span>
  );
}

export function LiveBadge() {
  const s = useEngineStatus();
  const { demo } = useApp();
  const text = demo ? '示範資料' : s === 'live' ? '即時同步' : s === 'offline' ? '重新連線中' : '連線中';
  return (
    <span class={`live ${s}`} title={demo ? '資料只存在這個分頁' : '資料會即時同步到每個人的畫面'}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

export interface WeekItem {
  id: number;
  start: string;
  label: string;
  status?: ComponentChildren;
  on?: boolean;
  pip?: boolean;
  past?: boolean;
  disabled?: boolean;
}

export function WeekStrip({ items, value, onPick, label = '選擇週次' }: { items: WeekItem[]; value: number | null; onPick: (id: number) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left - b.left - 12;
  }, [value, items.length]);
  return (
    <div class="weeks" ref={ref} role="group" aria-label={label}>
      {items.map((w) => (
        <button
          type="button"
          key={w.id}
          class={`wk ${w.past ? 'past' : ''}`}
          aria-pressed={w.id === value}
          disabled={w.disabled}
          onClick={() => onPick(w.id)}
        >
          <span class="w">{w.label || '—'}</span>
          <span class="d">
            {mdPad(w.start)}–{mdPad(addDays(w.start, 4))}
          </span>
          {w.status !== undefined && <span class={`s ${w.on ? 'on' : ''}`}>{w.status}</span>}
          {w.pip && <span class="pip" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

export function GroupTag({ no, name, soft }: { no: number; name?: string; soft?: boolean }) {
  return (
    <span class="row" style={{ gap: '8px' }}>
      <span class={`gno ${soft ? 'soft' : ''}`}>{no}</span>
      {name !== undefined && <span class="nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name || `第 ${no} 組`}</span>}
    </span>
  );
}

export function groupLabel(no: number, name?: string) {
  return name ? `第 ${no} 組「${name}」` : `第 ${no} 組`;
}
