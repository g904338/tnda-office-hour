import type { SlotRef } from '../api/types';
import { addMinutes, dayLabel, isoDow, md, DOW } from './time';

/** "週三 10/21  10:00、10:30" lines, one per day. */
export function slotLines(slots: SlotRef[]): Array<{ d: string; label: string; times: string[] }> {
  const byDay = new Map<string, string[]>();
  for (const s of slots) {
    const l = byDay.get(s.d) ?? [];
    l.push(s.t);
    byDay.set(s.d, l);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, times]) => ({ d, label: dayLabel(d), times: times.sort() }));
}

export function timeRange(t: string, minutes: number): string {
  return `${t}–${addMinutes(t, minutes)}`;
}

export function whenText(d: string, t: string, minutes: number): string {
  return `${md(d)}（${DOW[isoDow(d)]}）${timeRange(t, minutes)}`;
}

export function minutesText(n: number): string {
  if (n % 60 === 0) return `${n / 60} 小時`;
  if (n > 60) return `${Math.floor(n / 60)} 小時 ${n % 60} 分鐘`;
  return `${n} 分鐘`;
}

export function greeting(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早安';
  if (hour < 14) return '午安';
  if (hour < 18) return '下午好';
  return '晚安';
}
