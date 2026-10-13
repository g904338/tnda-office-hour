// Dates travel as 'YYYY-MM-DD' strings and times as 'HH:MM' strings, both
// in the course's timezone. Calendar arithmetic is done in UTC so the
// visitor's own timezone never shifts a day.

export const DOW = ['', '週一', '週二', '週三', '週四', '週五', '週六', '週日'];
export const DOW_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];

function parts(d: string): [number, number, number] {
  const [y, m, day] = d.split('-').map(Number);
  return [y, m, day];
}

export function toUTC(d: string): number {
  const [y, m, day] = parts(d);
  return Date.UTC(y, m - 1, day);
}

export function fromUTC(ms: number): string {
  const x = new Date(ms);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function addDays(d: string, n: number): string {
  return fromUTC(toUTC(d) + n * 86400000);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

/** ISO weekday, 1 = Monday … 7 = Sunday */
export function isoDow(d: string): number {
  const w = new Date(toUTC(d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function md(d: string): string {
  const [, m, day] = parts(d);
  return `${m}/${day}`;
}

export function mdPad(d: string): string {
  const [, m, day] = parts(d);
  return `${pad(m)}/${pad(day)}`;
}

export function dayLabel(d: string): string {
  return `${DOW[isoDow(d)]} ${md(d)}`;
}

export function minutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function hm(mins: number): string {
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

export function addMinutes(t: string, n: number): string {
  return hm(minutes(t) + n);
}

/** 今天 / 明天 / 後天 / 昨天, otherwise null */
export function relativeDay(d: string, today: string): string | null {
  const n = daysBetween(today, d);
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === 2) return '後天';
  if (n === -1) return '昨天';
  return null;
}

/** Offset of a timezone from UTC in minutes at a given instant. */
export function tzOffset(tz: string, at: number): number {
  try {
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
    const p: Record<string, number> = {};
    for (const x of f.formatToParts(new Date(at))) if (x.type !== 'literal') p[x.type] = Number(x.value);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUTC - Math.floor(at / 1000) * 1000) / 60000);
  } catch {
    return 480; // Asia/Taipei
  }
}

/** Absolute instant (ms) of a local date + time in a timezone. */
export function instant(d: string, t: string, tz: string): number {
  const local = toUTC(d) + minutes(t) * 60000;
  let guess = local - tzOffset(tz, local) * 60000;
  // second pass settles DST edges
  guess = local - tzOffset(tz, guess) * 60000;
  return guess;
}

/** 'YYYY-MM-DD HH:MM' of an instant in a timezone. */
export function localStamp(ms: number, tz: string): string {
  const local = ms + tzOffset(tz, ms) * 60000;
  const x = new Date(local);
  return `${fromUTC(local)} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
}

export function untilText(ms: number): string {
  if (ms <= 0) return '進行中';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分鐘後`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小時後`;
  const days = Math.round(h / 24);
  return `${days} 天後`;
}

export function agoText(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 45) return '剛剛';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-TW');
}

/** A server clock that keeps ticking from the last response. */
export class Clock {
  private offset = 0;
  today = fromUTC(Date.now());
  tz = 'Asia/Taipei';
  sync(c: { now: string; today: string; tz: string }) {
    this.offset = Date.parse(c.now) - Date.now();
    this.today = c.today;
    this.tz = c.tz;
  }
  now(): number {
    return Date.now() + this.offset;
  }
}

/** A hint like "台北時間" when the viewer's device is in another timezone. */
export function tzNote(tz: string): string | null {
  try {
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!mine || mine === tz) return null;
    if (tzOffset(mine, Date.now()) === tzOffset(tz, Date.now())) return null;
    return tz === 'Asia/Taipei' ? '台北時間' : tz;
  } catch {
    return null;
  }
}
