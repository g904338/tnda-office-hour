// Time for Cue. Instants are epoch milliseconds; everything a person reads
// or types is wall time in the course's timezone (Asia/Taipei by default),
// whatever timezone the browser or the GitHub runner happens to be in.

export const DEFAULT_TZ = 'Asia/Taipei';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface Wall {
  y: number;
  m: number; // 1–12
  d: number;
  h: number;
  min: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday */
  dow: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock fields of an instant in `tz`. */
export function wall(ms: number, tz = DEFAULT_TZ): Wall {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    y: Number(out.year),
    m: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour) % 24,
    min: Number(out.minute),
    dow: WEEKDAY[out.weekday] ?? 1,
  };
}

/** Minutes east of UTC at that instant (Taipei: +480). */
export function offsetMinutes(ms: number, tz = DEFAULT_TZ): number {
  const whole = ms - (((ms % 1000) + 1000) % 1000);
  const w = wall(whole, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, new Date(whole).getUTCSeconds());
  return Math.round((asUtc - whole) / MINUTE);
}

/**
 * The instant at which the clock in `tz` shows that wall time. Days and
 * months may overflow (d = 32 is the 1st of next month), like Date.UTC.
 */
export function zoned(y: number, m: number, d: number, h = 0, min = 0, tz = DEFAULT_TZ): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ms = guess - offsetMinutes(guess, tz) * MINUTE;
  // one more pass settles DST transitions
  const off2 = offsetMinutes(ms, tz);
  ms = guess - off2 * MINUTE;
  return ms;
}

export const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** 'YYYY-MM-DD' of the instant in `tz`. */
export function dayKey(ms: number, tz = DEFAULT_TZ): string {
  const w = wall(ms, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

export function parseDayKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

/** Midnight (in `tz`) of the day of the instant. */
export function startOfDay(ms: number, tz = DEFAULT_TZ): number {
  const w = wall(ms, tz);
  return zoned(w.y, w.m, w.d, 0, 0, tz);
}

/** Same wall time, `n` calendar days later. */
export function addDays(ms: number, n: number, tz = DEFAULT_TZ): number {
  const w = wall(ms, tz);
  return zoned(w.y, w.m, w.d + n, w.h, w.min, tz);
}

/** Whole calendar days from a to b in `tz` (negative when b is earlier). */
export function calendarDays(a: number, b: number, tz = DEFAULT_TZ): number {
  const wa = wall(a, tz);
  const wb = wall(b, tz);
  return Math.round((Date.UTC(wb.y, wb.m - 1, wb.d) - Date.UTC(wa.y, wa.m - 1, wa.d)) / DAY);
}

/** Monday 00:00 of the week containing the instant. */
export function startOfWeek(ms: number, tz = DEFAULT_TZ): number {
  const w = wall(ms, tz);
  return zoned(w.y, w.m, w.d - (w.dow - 1), 0, 0, tz);
}

export const DOW_ZH = ['', '一', '二', '三', '四', '五', '六', '日'];

/** '10/21（二）' */
export function fmtDate(ms: number, tz = DEFAULT_TZ, opts: { year?: boolean } = {}): string {
  const w = wall(ms, tz);
  return `${opts.year ? `${w.y}/` : ''}${w.m}/${w.d}（${DOW_ZH[w.dow]}）`;
}

/** '14:05' */
export function fmtTime(ms: number, tz = DEFAULT_TZ): string {
  const w = wall(ms, tz);
  return `${pad(w.h)}:${pad(w.min)}`;
}

/** '10/21（二）14:05', with the year when it is not this year. */
export function fmtDateTime(ms: number, tz = DEFAULT_TZ, now = Date.now()): string {
  const year = wall(ms, tz).y !== wall(now, tz).y;
  return `${fmtDate(ms, tz, { year })} ${fmtTime(ms, tz)}`;
}

/** Human distance in Chinese: '3 天後', '2 小時前', '剛剛'. */
export function fmtRelative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '後' : '前';
  if (abs < 45_000) return diff >= 0 ? '即將' : '剛剛';
  if (abs < 50 * MINUTE) return `${Math.max(1, Math.round(abs / MINUTE))} 分鐘${suffix}`;
  if (abs < 22 * HOUR) return `${Math.max(1, Math.round(abs / HOUR))} 小時${suffix}`;
  if (abs < 26 * DAY) return `${Math.max(1, Math.round(abs / DAY))} 天${suffix}`;
  if (abs < 320 * DAY) return `${Math.max(1, Math.round(abs / (30 * DAY)))} 個月${suffix}`;
  return `${Math.max(1, Math.round(abs / (365 * DAY)))} 年${suffix}`;
}

/** Countdown text: '2 天 3 小時', '45 分鐘', '12 秒'. */
export function fmtCountdown(ms: number, now = Date.now()): string {
  let s = Math.max(0, Math.round((ms - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return h ? `${d} 天 ${h} 小時` : `${d} 天`;
  if (h > 0) return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
  if (m > 0) return `${m} 分鐘`;
  return `${s} 秒`;
}

/**
 * How Discord shows a <t:unix:style> timestamp to a reader whose client is
 * set to Traditional Chinese, so the preview matches what students see.
 */
export function discordTimestamp(unix: number, style: string, tz = DEFAULT_TZ, now = Date.now()): string {
  const ms = unix * 1000;
  const w = wall(ms, tz);
  const date = `${w.y}年${w.m}月${w.d}日`;
  const time = `${pad(w.h)}:${pad(w.min)}`;
  switch (style) {
    case 't':
      return time;
    case 'T':
      return `${time}:${pad(new Date(ms).getUTCSeconds())}`;
    case 'd':
      return `${w.y}/${pad(w.m)}/${pad(w.d)}`;
    case 'D':
      return date;
    case 'R':
      return fmtRelative(ms, now);
    case 'F':
      return `${date}星期${DOW_ZH[w.dow]} ${time}`;
    case 'f':
    default:
      return `${date} ${time}`;
  }
}

/** ISO string with the zone's offset: 2026-10-21T14:10:00+08:00. */
export function isoLocal(ms: number, tz = DEFAULT_TZ): string {
  const w = wall(ms, tz);
  const off = offsetMinutes(ms, tz);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const sec = pad(Math.floor((((ms % MINUTE) + MINUTE) % MINUTE) / 1000));
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.min)}:${sec}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Value for <input type="datetime-local"> in `tz`. */
export function toInputValue(ms: number, tz = DEFAULT_TZ): string {
  const w = wall(ms, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.min)}`;
}

/** Reads <input type="datetime-local"> as wall time in `tz`. */
export function fromInputValue(v: string, tz = DEFAULT_TZ): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return zoned(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
