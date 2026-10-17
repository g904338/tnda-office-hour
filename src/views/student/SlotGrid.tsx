import { useEffect, useRef } from 'preact/hooks';
import type { StudentSlot } from '../../api/types';
import { addDays, addMinutes, DOW, isoDow, md, minutes } from '../../lib/time';

export const slotKey = (d: string, t: string) => `${d} ${t}`;

interface Props {
  weekStart: string;
  today: string;
  slots: StudentSlot[];
  closures: Array<{ d: string; reason: string }>;
  picks: Set<string>;
  saved: Set<string>;
  slotMinutes: number;
  onChange: (key: string, on: boolean) => void;
}

/**
 * Week × time grid. Tap a cell to toggle it; with a mouse you can also
 * press and drag across cells to paint several at once.
 */
export function SlotGrid({ weekStart, today, slots, closures, picks, saved, slotMinutes, onChange }: Props) {
  const bySlot = new Map(slots.map((s) => [slotKey(s.d, s.t), s]));
  const days = [0, 1, 2, 3, 4, 5, 6]
    .map((i) => addDays(weekStart, i))
    .filter((d, i) => i < 5 || slots.some((s) => s.d === d));
  const times = [...new Set(slots.map((s) => s.t))].sort((a, b) => minutes(a) - minutes(b));
  const holiday = new Map(closures.map((c) => [c.d, c.reason]));

  const drag = useRef<{ on: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    const stop = () => {
      drag.current = null;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const rows: Array<string | { gap: [string, string] }> = [];
  times.forEach((t, i) => {
    if (i > 0 && minutes(t) - minutes(times[i - 1]) > slotMinutes) rows.push({ gap: [addMinutes(times[i - 1], slotMinutes), t] });
    rows.push(t);
  });

  if (!times.length) {
    return <p class="empty">這週沒有開放的時段</p>;
  }

  // arrow keys move between cells like a spreadsheet
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = keys[e.key];
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-r]');
    if (!step || !from) return;
    e.preventDefault();
    let r = Number(from.dataset.r);
    let c = Number(from.dataset.c);
    const grid = e.currentTarget as HTMLElement;
    for (let i = 0; i < 40; i++) {
      r += step[0];
      c += step[1];
      if (r < 0 || c < 0 || r >= times.length || c >= days.length) return;
      const next = grid.querySelector<HTMLElement>(`button[data-r="${r}"][data-c="${c}"]`);
      if (next) {
        next.focus();
        return;
      }
    }
  };

  return (
    <div class="grid-scroll">
      <div class="sgrid" style={{ '--cols': days.length }} role="group" aria-label="可預約時段，可用方向鍵移動" onKeyDown={onKeyDown}>
        <div aria-hidden="true" />
        {days.map((d) => (
          <div class={`dh ${d === today ? 'today' : ''}`} key={d}>
            <b>{DOW[isoDow(d)]}</b>
            <span>{md(d)}</span>
            {holiday.has(d) && <span class="tag">{holiday.get(d) || '休息'}</span>}
          </div>
        ))}
        {rows.map((r) =>
          typeof r !== 'string' ? (
            <div class="gap" key={`gap-${r.gap[0]}`}>
              <span class="mono">
                {r.gap[0]}–{r.gap[1]}
              </span>
              不開放
            </div>
          ) : (
            [
              <div class="tl" key={`t-${r}`}>
                {r}
              </div>,
              ...days.map((d, ci) => {
                const k = slotKey(d, r);
                const ri = times.indexOf(r);
                const s = bySlot.get(k);
                const label = `${DOW[isoDow(d)]} ${md(d)} ${r}–${addMinutes(r, slotMinutes)}`;
                if (!s) return <div class="cell none" key={k} aria-hidden="true" />;
                const on = picks.has(k);
                if (s.late && !(on && saved.has(k))) {
                  return (
                    <div class="cell late" key={k} title={`${label}（已過截止）`}>
                      截止
                    </div>
                  );
                }
                if (s.full && !(on && saved.has(k))) {
                  return (
                    <div class="cell late" key={k} title={`${label}（已排給別組）`}>
                      已排滿
                    </div>
                  );
                }
                // kept from before the deadline, or before another group got the slot: can only be removed
                const lockedOn = s.late || s.full;
                const set = (v: boolean) => {
                  if (lockedOn && v) return;
                  onChange(k, v);
                };
                return (
                  <button
                    type="button"
                    key={k}
                    class="cell"
                    aria-pressed={on}
                    aria-label={`${label}${s.cap > 1 ? `，×${s.cap} 位 PM` : ''}${s.demand ? `，已有 ${s.demand} 組勾選` : ''}${s.late ? '，已過截止，只能取消' : s.full ? '，已排給別組，只能取消' : ''}`}
                    title={`${label}${s.cap > 1 ? ` · ${s.cap} 位 PM` : ''}${s.demand ? ` · 已有 ${s.demand} 組勾選` : ''}`}
                    data-k={k}
                    data-r={ri}
                    data-c={ci}
                    onPointerDown={(e) => {
                      if (e.pointerType !== 'mouse' || e.button !== 0) return;
                      e.preventDefault();
                      drag.current = { on: !on };
                      suppressClick.current = true;
                      set(!on);
                      (e.currentTarget as HTMLElement).focus({ preventScroll: true });
                    }}
                    onPointerEnter={() => {
                      if (drag.current && on !== drag.current.on) set(drag.current.on);
                    }}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      set(!on);
                    }}
                  >
                    {on ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M5 12.5l4.2 4.2L19 7" />
                      </svg>
                    ) : null}
                    {s.demand > 0 && (
                      <span class="hot" aria-hidden="true">
                        {Array.from({ length: Math.min(3, s.demand) }, (_, i) => (
                          <i key={i} />
                        ))}
                      </span>
                    )}
                    {s.cap > 1 && (
                      <span class="cap" aria-hidden="true">
                        ×{s.cap}
                      </span>
                    )}
                  </button>
                );
              }),
            ]
          ),
        )}
      </div>
    </div>
  );
}
