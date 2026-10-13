import { describe, expect, it } from 'vitest';
import { csvText, icsText } from '../src/lib/files';
import { slotLines, minutesText } from '../src/lib/format';
import { addDays, addMinutes, daysBetween, instant, isoDow, localStamp, relativeDay, tzOffset, untilText } from '../src/lib/time';

describe('time', () => {
  it('does calendar maths without timezone drift', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-14', '2026-10-21')).toBe(7);
    expect(isoDow('2026-10-19')).toBe(1);
    expect(isoDow('2026-10-25')).toBe(7);
    expect(addMinutes('11:30', 30)).toBe('12:00');
    expect(relativeDay('2026-10-15', '2026-10-14')).toBe('明天');
    expect(relativeDay('2026-10-20', '2026-10-14')).toBeNull();
  });

  it('converts Taipei wall-clock time to instants and back', () => {
    expect(tzOffset('Asia/Taipei', Date.UTC(2026, 9, 14))).toBe(480);
    const ms = instant('2026-10-21', '10:00', 'Asia/Taipei');
    expect(new Date(ms).toISOString()).toBe('2026-10-21T02:00:00.000Z');
    expect(localStamp(ms, 'Asia/Taipei')).toBe('2026-10-21 10:00');
    // a timezone with daylight saving still lands on the right wall clock
    const ny = instant('2026-07-01', '09:30', 'America/New_York');
    expect(localStamp(ny, 'America/New_York')).toBe('2026-07-01 09:30');
  });

  it('describes durations in plain words', () => {
    expect(untilText(-1)).toBe('進行中');
    expect(untilText(25 * 60000)).toBe('25 分鐘後');
    expect(untilText(5 * 3600000)).toBe('5 小時後');
    expect(untilText(3 * 86400000)).toBe('3 天後');
    expect(minutesText(30)).toBe('30 分鐘');
    expect(minutesText(60)).toBe('1 小時');
    expect(minutesText(90)).toBe('1 小時 30 分鐘');
  });

  it('groups picked slots by day', () => {
    expect(slotLines([{ d: '2026-10-22', t: '16:00' }, { d: '2026-10-21', t: '10:30' }, { d: '2026-10-21', t: '10:00' }])).toEqual([
      { d: '2026-10-21', label: '週三 10/21', times: ['10:00', '10:30'] },
      { d: '2026-10-22', label: '週四 10/22', times: ['16:00'] },
    ]);
  });
});

describe('files', () => {
  it('writes valid, folded iCalendar', () => {
    const ics = icsText([{ uid: 'oh-1@x', d: '2026-10-21', t: '10:00', minutes: 30, tz: 'Asia/Taipei', title: 'Office Hour · 第 2 組｜展場動線要怎麼配合互動裝置，以及觀眾排隊的位置要放哪裡', location: 'Discord; 聊天室' }]);
    expect(ics).toContain('DTSTART:20261021T020000Z');
    expect(ics).toContain('DTEND:20261021T023000Z');
    expect(ics).toContain(String.raw`LOCATION:Discord\; 聊天室`);
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });

  it('writes CSV that Excel opens and that cannot run formulas', () => {
    const csv = csvText([{ a: '=HYPERLINK("x")', b: '逗號,與"引號"' }], [['a', 'A'], ['b', 'B']]);
    expect(csv.startsWith('﻿A,B\r\n')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"逗號,與""引號"""');
  });
});
