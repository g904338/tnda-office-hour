import { describe, expect, test } from 'vitest';
import {
  addDays,
  calendarDays,
  dayKey,
  discordTimestamp,
  fmtCountdown,
  fmtDate,
  fmtDateTime,
  fmtRelative,
  fromInputValue,
  isoLocal,
  offsetMinutes,
  startOfWeek,
  toInputValue,
  wall,
  zoned,
} from '../../src/cue/core/time';

const TPE = 'Asia/Taipei';

describe('cue time', () => {
  test('wall time and offsets in Taipei, whatever the machine timezone', () => {
    const ms = Date.parse('2026-10-14T02:00:00Z');
    expect(wall(ms, TPE)).toEqual({ y: 2026, m: 10, d: 14, h: 10, min: 0, dow: 3 });
    expect(offsetMinutes(ms, TPE)).toBe(480);
    expect(zoned(2026, 10, 14, 10, 0, TPE)).toBe(ms);
  });

  test('zoned() overflows days like Date.UTC', () => {
    expect(isoLocal(zoned(2026, 10, 32, 9, 0, TPE), TPE)).toBe('2026-11-01T09:00:00+08:00');
    expect(isoLocal(zoned(2026, 10, 0, 9, 0, TPE), TPE)).toBe('2026-09-30T09:00:00+08:00');
  });

  test('DST zones keep the wall time across a transition', () => {
    const ny = 'America/New_York';
    // 2026-11-01 is the end of DST in New York
    const before = zoned(2026, 10, 31, 9, 0, ny);
    const after = addDays(before, 2, ny);
    expect(wall(after, ny)).toMatchObject({ d: 2, h: 9, min: 0 });
    expect(after - before).toBe(2 * 86400000 + 3600000);
    expect(isoLocal(zoned(2026, 7, 1, 12, 0, ny), ny)).toBe('2026-07-01T12:00:00-04:00');
  });

  test('calendar arithmetic', () => {
    const a = zoned(2026, 10, 14, 23, 30, TPE);
    const b = zoned(2026, 10, 15, 0, 30, TPE);
    expect(calendarDays(a, b, TPE)).toBe(1);
    expect(dayKey(b, TPE)).toBe('2026-10-15');
    expect(isoLocal(startOfWeek(a, TPE), TPE)).toBe('2026-10-12T00:00:00+08:00');
  });

  test('formatting', () => {
    const now = zoned(2026, 10, 14, 10, 0, TPE);
    const at = zoned(2026, 10, 21, 14, 5, TPE);
    expect(fmtDate(at, TPE)).toBe('10/21（三）');
    expect(fmtDateTime(at, TPE, now)).toBe('10/21（三） 14:05');
    expect(fmtDateTime(zoned(2027, 1, 4, 9, 0, TPE), TPE, now)).toBe('2027/1/4（一） 09:00');
    expect(fmtRelative(now + 3 * 86400000, now)).toBe('3 天後');
    expect(fmtRelative(now - 2 * 3600000, now)).toBe('2 小時前');
    expect(fmtRelative(now - 10_000, now)).toBe('剛剛');
    expect(fmtCountdown(now + 26 * 3600000 + 5 * 60000, now)).toBe('1 天 2 小時');
    expect(fmtCountdown(now + 90 * 60000, now)).toBe('1 小時 30 分');
  });

  test('Discord timestamps read like a zh-TW Discord client', () => {
    const now = zoned(2026, 10, 14, 10, 0, TPE);
    const unix = zoned(2026, 10, 21, 14, 10, TPE) / 1000;
    expect(discordTimestamp(unix, 'F', TPE, now)).toBe('2026年10月21日星期三 14:10');
    expect(discordTimestamp(unix, 'D', TPE, now)).toBe('2026年10月21日');
    expect(discordTimestamp(unix, 't', TPE, now)).toBe('14:10');
    expect(discordTimestamp(unix, 'R', TPE, now)).toBe('7 天後');
  });

  test('datetime-local inputs are read in the course timezone', () => {
    const ms = fromInputValue('2026-10-21T14:10', TPE)!;
    expect(isoLocal(ms, TPE)).toBe('2026-10-21T14:10:00+08:00');
    expect(toInputValue(ms, TPE)).toBe('2026-10-21T14:10');
    expect(fromInputValue('nope', TPE)).toBeNull();
  });
});
