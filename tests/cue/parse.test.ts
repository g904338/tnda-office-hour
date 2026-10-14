import { describe, expect, test } from 'vitest';
import { cnNumber, normalize, parse } from '../../src/cue/core/parse';
import { isoLocal, zoned } from '../../src/cue/core/time';

const TPE = 'Asia/Taipei';
// Wednesday 14 October 2026, 10:00 in Taipei
const now = zoned(2026, 10, 14, 10, 0, TPE);
const opts = { now, tz: TPE, semesterStart: '2026-09-07' };
const p = (s: string, o: Partial<typeof opts> = {}) => parse(s, { ...opts, ...o });
const when = (s: string, o: Partial<typeof opts> = {}) => p(s, o).content.when?.at ?? null;

describe('helpers', () => {
  test('full-width text is normalised without changing length', () => {
    const s = '繳交期限：１０／２８　２３：５９';
    expect(normalize(s)).toBe('繳交期限:10/28 23:59');
    expect(normalize(s).length).toBe(s.length);
  });
  test('Chinese numerals', () => {
    expect(cnNumber('十')).toBe(10);
    expect(cnNumber('十二')).toBe(12);
    expect(cnNumber('二十三')).toBe(23);
    expect(cnNumber('廿一')).toBe(21);
    expect(cnNumber('兩')).toBe(2);
    expect(cnNumber('07')).toBe(7);
    expect(cnNumber('百')).toBeNull();
  });
});

describe('dates and times', () => {
  test('month/day with time, after a colon label', () => {
    expect(when('繳交期限：10/28 23:59')).toBe('2026-10-28T23:59:00+08:00');
    expect(when('繳交期限：１０／２８　２３：５９')).toBe('2026-10-28T23:59:00+08:00');
  });
  test('full dates and Chinese dates', () => {
    expect(when('期末考 2026/12/25 9:00')).toBe('2026-12-25T09:00:00+08:00');
    expect(when('12月25日早上9點期末考')).toBe('2026-12-25T09:00:00+08:00');
    expect(when('十二月二十五號 上午十點 期末考')).toBe('2026-12-25T10:00:00+08:00');
  });
  test('relative days and parts of the day', () => {
    expect(when('明天早上10點上課')).toBe('2026-10-15T10:00:00+08:00');
    expect(when('明晚 8 點 Discord 討論')).toBe('2026-10-15T20:00:00+08:00');
    expect(when('今晚 11:59 前交')).toBe('2026-10-14T23:59:00+08:00');
    expect(when('後天下午兩點半集合')).toBe('2026-10-16T14:30:00+08:00');
    expect(when('3 天後交報告')).toBe('2026-10-17T23:59:00+08:00');
  });
  test('weekdays relative to this week', () => {
    expect(when('下週五 23:59 前上傳作業')).toBe('2026-10-23T23:59:00+08:00');
    expect(when('週五 23:59 截止的作業')).toBe('2026-10-16T23:59:00+08:00');
    expect(when('這週一的課改到週四下午三點半')).toBe('2026-10-15T15:30:00+08:00');
    expect(when('下下週二 14:10 期中發表')).toBe('2026-10-27T14:10:00+08:00');
    // later today is today; earlier today means next week
    expect(when('週三 14:00 office hour')).toBe('2026-10-14T14:00:00+08:00');
    expect(when('週三 9:00 office hour')).toBe('2026-10-21T09:00:00+08:00');
  });
  test('a bare afternoon hour without 下午 is the afternoon', () => {
    expect(when('10/21 2:10 上課')).toBe('2026-10-21T14:10:00+08:00');
    expect(when('10/21 08:10 上課')).toBe('2026-10-21T08:10:00+08:00');
    expect(when('10/21 9點上課')).toBe('2026-10-21T09:00:00+08:00');
    expect(when('10/21 2pm 上課')).toBe('2026-10-21T14:00:00+08:00');
  });
  test('midnight deadlines are the end of that day', () => {
    expect(when('10/28 晚上12點前繳交作業')).toBe('2026-10-28T23:59:00+08:00');
    expect(when('作業 10/28 24:00 截止')).toBe('2026-10-28T23:59:00+08:00');
  });
  test('ranges', () => {
    const r = p('11/14（六）13:00-17:00 期末展演彩排');
    expect(r.content.when).toEqual({ at: '2026-11-14T13:00:00+08:00', end: '2026-11-14T17:00:00+08:00', allDay: false });
    const r2 = p('下午2點到4點 工作坊，10/22');
    expect(r2.content.when?.at).toBe('2026-10-22T14:00:00+08:00');
    expect(r2.content.when?.end).toBe('2026-10-22T16:00:00+08:00');
  });
  test('semester weeks', () => {
    expect(when('第10週（三）期中發表')).toBe('2026-11-11T09:00:00+08:00');
    expect(p('第10週（三）期中發表').content.when?.allDay).toBe(true);
    expect(p('第10週（三）期中發表', { semesterStart: '' }).content.when).toBeNull();
  });
  test('dates without a year roll into next year once they are long past', () => {
    const dec = zoned(2026, 12, 20, 10, 0, TPE);
    expect(when('1/5 期末報告截止', { now: dec })).toBe('2027-01-05T23:59:00+08:00');
    expect(when('12/1 的上課錄影', { now: dec })).toBe('2026-12-01T09:00:00+08:00');
  });
  test('things that look like times or dates but are not', () => {
    expect(p('下週一定要交期中提案').content.when).toBeNull();
    expect(p('這週一起來討論吧').content.when).toBeNull();
    expect(p('有三點要注意').content.when).toBeNull();
    expect(p('第三點：記得點名').content.when).toBeNull();
    expect(p('需要三小時完成').content.when).toBeNull();
    expect(p('連結 https://example.com/2026/10/21/14:00 在這').content.when).toBeNull();
  });
  test('a weekday that does not match its date is flagged', () => {
    expect(p('10/21（二）上課').warnings).toEqual(['10/21 是星期三，但文字寫的是星期二，請確認日期。']);
    expect(p('10/21（三）上課').warnings).toEqual([]);
    expect(p('10/21 (週三) 上課').warnings).toEqual([]);
  });
  test('a time that has already passed is flagged', () => {
    expect(p('10/13 14:00 上課').warnings).toContain('文字裡的時間已經過了，請確認日期。');
  });
});

describe('content', () => {
  test('homework with a deadline, a submission place, a link and a warning', () => {
    const r = p('作業三：互動原型\n繳交期限：10/28 23:59\n上傳到 Moodle 作業區，檔名格式：組別_作業三.pdf\nhttps://moodle.ncku.edu.tw/mod/assign/view.php?id=123\n遲交一天扣 10 分');
    expect(r.content).toMatchObject({
      kind: 'homework',
      title: '作業三：互動原型',
      body: '上傳到 Moodle 作業區，檔名格式：組別_作業三.pdf',
      when: { at: '2026-10-28T23:59:00+08:00', allDay: false },
      place: { label: '繳交', value: 'Moodle 作業區' },
      links: [{ url: 'https://moodle.ncku.edu.tw/mod/assign/view.php?id=123', label: 'Moodle' }],
      notes: ['遲交一天扣 10 分'],
    });
    expect(r.primary?.role).toBe('deadline');
    expect(r.guessed.kind).toBe(false);
  });

  test('a class reminder: bracketed title, place, things to bring, a labelled link', () => {
    const r = p('【第7週上課提醒】\n10/21（三）下午 2:10 上課，地點改到設計館 B1 實驗室\n請各組帶筆電和期中提案的紙本\n簡報上傳：https://drive.google.com/xxx');
    expect(r.content).toMatchObject({
      kind: 'class',
      title: '第7週上課提醒',
      body: '',
      when: { at: '2026-10-21T14:10:00+08:00' },
      place: { label: '地點', value: '設計館 B1 實驗室' },
      bring: '筆電、期中提案的紙本',
      links: [{ url: 'https://drive.google.com/xxx', label: '簡報上傳' }],
    });
    expect(r.week).toBe(7);
  });

  test('a one-line sentence keeps its words and gets a title', () => {
    const r = p('明天早上10點在設計館301教室上課');
    expect(r.content.title).toBe('第 6 週上課提醒');
    expect(r.content.place).toEqual({ label: '地點', value: '設計館301教室' });
    expect(r.guessed.title).toBe(true);
  });

  test('titles from the item, the task, or the event', () => {
    expect(p('期中考 11/4 早上 9 點，範圍 Ch1-Ch6，可以帶一張 A4 小抄').content.title).toBe('期中考');
    expect(p('HW2 due 10/30 23:59 https://github.com/xxx').content.title).toBe('HW2');
    expect(p('請大家在 10/25 前填寫期末分組表單 https://forms.gle/abc').content.title).toBe('填寫期末分組表單');
    expect(p('11/14（六）13:00-17:00 期末展演彩排，在創意基地，全體都要到').content.title).toBe('期末展演彩排');
    expect(p('10/21（三）停課通知').content.title).toBe('停課通知');
  });

  test('kinds', () => {
    expect(p('期中考 11/4 早上 9 點').content.kind).toBe('exam');
    expect(p('下週二停課一次，補課時間另行通知').content.kind).toBe('notice');
    expect(p('講義上傳了，請自行下載 https://drive.google.com/drive/folders/abc').content.kind).toBe('material');
    expect(p('11/14 期末展演彩排').content.kind).toBe('event');
    expect(p('今晚 8 點 Discord 語音討論').guessed.kind).toBe(true);
  });

  test('days without a clock time', () => {
    const notice = p('下週二停課一次，補課時間另行通知');
    expect(notice.content.when).toEqual({ at: '2026-10-20T09:00:00+08:00', end: null, allDay: true });
    expect(notice.guessed.time).toBe(true);
    // a deadline without a time is the end of the day
    expect(p('10/25 前填寫表單').content.when).toEqual({ at: '2026-10-25T23:59:00+08:00', end: null, allDay: false });
  });

  test('@everyone becomes a mention, not text', () => {
    const r = p('@everyone 今晚 8 點 Discord 語音討論');
    expect(r.mention).toEqual({ type: 'everyone' });
    expect(r.content.title).toBe('Discord 語音討論');
    expect(r.content.when?.at).toBe('2026-10-14T20:00:00+08:00');
  });

  test('bullets and notes', () => {
    const r = p('第10週（三）期中發表\n每組 8 分鐘\n- 簡報 5 分鐘\n- QA 3 分鐘\n注意：超時會被打斷');
    expect(r.content).toMatchObject({ title: '期中發表', body: '每組 8 分鐘', bullets: ['簡報 5 分鐘', 'QA 3 分鐘'], notes: ['超時會被打斷'] });
  });

  test('online places come from meeting links', () => {
    const r = p('今晚 9 點線上討論 https://meet.google.com/abc-defg-hij');
    expect(r.content.place).toEqual({ label: '地點', value: '線上（Google Meet）' });
    expect(r.content.links[0].label).toBe('Google Meet');
  });

  test('empty and messy input never throws', () => {
    for (const s of ['', '   ', '\n\n', '!!!', 'https://x.y', '10/', '/10', '：：', '一二三四五六七八九十', '😀😀😀']) {
      expect(() => p(s)).not.toThrow();
    }
    expect(p('').content.title).toBe('課程公告');
  });

  test('times are listed in order with their roles', () => {
    const r = p('10/21 14:10 上課\n作業 10/28 23:59 前交');
    expect(r.times.map((t) => isoLocal(t.at, TPE))).toEqual(['2026-10-21T14:10:00+08:00', '2026-10-28T23:59:00+08:00']);
    expect(r.times.map((t) => t.role)).toEqual(['start', 'deadline']);
  });
});
