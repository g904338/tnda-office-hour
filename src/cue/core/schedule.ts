// From one piece of content to the posts that announce it: reminder rules
// ("the evening before", "3 hours before"), weekly repeats, and the small
// label each reminder carries ("明天截止", "剩 3 小時").

import type { Content, KindStyle } from './model';
import { addDays, calendarDays, dayKey, isoLocal, MINUTE, wall, zoned } from './time';
import { semesterWeek } from './parse';

export interface Rule {
  id: string;
  label: string;
}

export const RULES: Rule[] = [
  { id: 'now', label: '立即發布' },
  { id: 'd7@20:00', label: '一週前 20:00' },
  { id: 'd3@20:00', label: '三天前 20:00' },
  { id: 'd1@20:00', label: '前一天 20:00' },
  { id: 'd0@08:00', label: '當天 08:00' },
  { id: 'm180', label: '3 小時前' },
  { id: 'm60', label: '1 小時前' },
  { id: 'm30', label: '30 分鐘前' },
  { id: 'm10', label: '10 分鐘前' },
];

export function ruleLabel(id: string, tz: string, now = Date.now()): string {
  const known = RULES.find((r) => r.id === id);
  if (known) return known.label;
  if (id.startsWith('at:')) {
    const at = Date.parse(id.slice(3));
    if (Number.isFinite(at)) {
      const w = wall(at, tz);
      const sameYear = w.y === wall(now, tz).y;
      return `${sameYear ? '' : `${w.y}/`}${w.m}/${w.d} ${String(w.h).padStart(2, '0')}:${String(w.min).padStart(2, '0')}`;
    }
  }
  return id;
}

/** When a rule fires for an event at `event`; null when it needs an event and there is none. */
export function ruleTime(rule: string, event: number | null, now: number, tz: string): number | null {
  if (rule === 'now') return now;
  if (rule.startsWith('at:')) {
    const at = Date.parse(rule.slice(3));
    return Number.isFinite(at) ? at : null;
  }
  if (event === null) return null;
  const d = /^d(\d{1,2})@(\d{2}):(\d{2})$/.exec(rule);
  if (d) {
    const w = wall(event, tz);
    return zoned(w.y, w.m, w.d - Number(d[1]), Number(d[2]), Number(d[3]), tz);
  }
  const m = /^m(\d{1,4})$/.exec(rule);
  if (m) return event - Number(m[1]) * MINUTE;
  return null;
}

/** "明天截止", "剩 3 小時", "30 分鐘後上課" — how far the event is when the reminder goes out. */
export function reminderLabel(kind: KindStyle, sendAt: number, event: number, tz: string, allDay = false): string {
  if (sendAt >= event) return '';
  const days = calendarDays(sendAt, event, tz);
  const v = kind.verb;
  if (days >= 3) return `${days} 天後${v}`;
  if (days === 2) return `後天${v}`;
  if (days === 1) return `明天${v}`;
  if (allDay) return `今天${v}`;
  const mins = Math.round((event - sendAt) / MINUTE);
  const deadline = v === '截止';
  if (mins < 60) return deadline ? `剩 ${Math.max(1, mins)} 分鐘` : `${Math.max(1, mins)} 分鐘後${v}`;
  if (mins <= 6 * 60 && deadline) return `剩 ${Math.round(mins / 60)} 小時`;
  if (mins < 3 * 60) return `${Math.round(mins / 60)} 小時後${v}`;
  return `今天${v}`;
}

export interface Repeat {
  /** every 1 or 2 weeks */
  weeks: 1 | 2;
  /** last day, 'YYYY-MM-DD' */
  until: string;
}

export const MAX_OCCURRENCES = 30;

export function occurrences(event: number, repeat: Repeat | null, tz: string): number[] {
  if (!repeat) return [event];
  const out: number[] = [];
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const at = addDays(event, i * 7 * repeat.weeks, tz);
    if (dayKey(at, tz) > repeat.until) break;
    out.push(at);
  }
  return out.length ? out : [event];
}

/** {週} → semester week, {n} → 1, 2, 3…, {日期} → 10/21 */
export function fillTokens(s: string, ctx: { n: number; week: number | null; at: number | null; tz: string }): string {
  if (!s.includes('{')) return s;
  const w = ctx.at !== null ? wall(ctx.at, ctx.tz) : null;
  return s
    .replace(/\{週\}|\{week\}/g, String(ctx.week ?? ctx.n))
    .replace(/\{n\}/g, String(ctx.n))
    .replace(/\{日期\}|\{date\}/g, w ? `${w.m}/${w.d}` : '');
}

export interface PlanInput {
  content: Content;
  kind: KindStyle;
  rules: string[];
  repeat: Repeat | null;
  now: number;
  tz: string;
  semesterStart?: string;
}

export interface Planned {
  at: number;
  rule: string;
  label: string | null;
  content: Content;
  occurrence: number;
}

export interface Skipped {
  rule: string;
  occurrence: number;
  reason: 'past' | 'after' | 'no-time';
}

/** Every post one compose will create, earliest first. */
export function plan(input: PlanInput): { posts: Planned[]; skipped: Skipped[] } {
  const { content, kind, tz, now } = input;
  const event = content.when ? Date.parse(content.when.at) : null;
  const end = content.when?.end ? Date.parse(content.when.end) : null;
  const events = event !== null ? occurrences(event, input.repeat, tz) : [null];
  const posts: Planned[] = [];
  const skipped: Skipped[] = [];
  const rules = input.rules.length ? input.rules : ['now'];
  events.forEach((ev, i) => {
    const n = i + 1;
    const shift = ev !== null && event !== null ? ev - event : 0;
    const week = ev !== null ? semesterWeek(ev, input.semesterStart, tz) : null;
    const fill = (s: string) => fillTokens(s, { n, week, at: ev, tz });
    const c: Content = {
      ...content,
      title: fill(content.title),
      body: fill(content.body),
      when:
        content.when && ev !== null
          ? { ...content.when, at: isoLocal(ev, tz), end: end !== null ? isoLocal(end + shift, tz) : null }
          : content.when,
    };
    for (const rule of rules) {
      // "right now" only makes sense once, for the first occurrence
      if (rule === 'now' && i > 0) continue;
      const at = ruleTime(rule, ev, now, tz);
      if (at === null) {
        skipped.push({ rule, occurrence: n, reason: 'no-time' });
        continue;
      }
      if (rule !== 'now' && at < now - MINUTE) {
        skipped.push({ rule, occurrence: n, reason: 'past' });
        continue;
      }
      if (ev !== null && rule !== 'now' && !rule.startsWith('at:') && at >= ev) {
        skipped.push({ rule, occurrence: n, reason: 'after' });
        continue;
      }
      const label = ev !== null && rule !== 'now' && at < ev ? reminderLabel(kind, at, ev, tz, Boolean(content.when?.allDay)) || null : null;
      if (posts.some((p) => Math.abs(p.at - at) < MINUTE)) continue;
      posts.push({ at: rule === 'now' ? now : at, rule, label, content: c, occurrence: n });
    }
  });
  posts.sort((a, b) => a.at - b.at);
  return { posts, skipped };
}

/** Late at night or very early: worth a second look before scheduling. */
export function isQuietHour(at: number, tz: string): boolean {
  const h = wall(at, tz).h;
  return h >= 0 && h < 7;
}
