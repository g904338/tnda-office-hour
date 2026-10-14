import { describe, expect, test } from 'vitest';
import { defaultConfig, emptyContent, type Content } from '../../src/cue/core/model';
import { renderMarkdown } from '../../src/cue/core/markdown';
import { checkPayload, plainText, renderPayload } from '../../src/cue/core/render';
import { reminderLabel, plan, ruleTime, occurrences, fillTokens } from '../../src/cue/core/schedule';
import { KINDS } from '../../src/cue/core/model';
import { isoLocal, zoned } from '../../src/cue/core/time';

const TPE = 'Asia/Taipei';
const now = zoned(2026, 10, 14, 10, 0, TPE);
const config = { ...defaultConfig(), course: 'TN0006 跨域數位製作實務', username: 'Cue 小幫手' };
const hw: Content = {
  ...emptyContent('homework'),
  title: '作業三：互動原型',
  body: '檔名格式：組別_作業三.pdf',
  when: { at: '2026-10-28T23:59:00+08:00', end: null, allDay: false },
  place: { label: '繳交', value: 'Moodle 作業區' },
  links: [{ url: 'https://moodle.example.edu/a?id=1&b=2', label: '作業說明 [PDF]' }],
  notes: ['遲交一天扣 10 分'],
};
const unix = Date.parse('2026-10-28T23:59:00+08:00') / 1000;

describe('render', () => {
  test('embed card', () => {
    const p = renderPayload({ content: hw, style: 'embed', mention: { type: 'everyone' }, config, label: '明天截止' });
    expect(p.content).toBe('@everyone');
    expect(p.allowed_mentions).toEqual({ parse: ['everyone'] });
    expect(p.username).toBe('Cue 小幫手');
    const e = p.embeds![0];
    expect(e.author?.name).toBe('📝 作業提醒 · 明天截止');
    expect(e.title).toBe('作業三：互動原型');
    expect(e.color).toBe(0xf59e0b);
    expect(e.description).toBe('檔名格式：組別_作業三.pdf\n\n> ⚠️ 遲交一天扣 10 分');
    expect(e.fields).toEqual([
      { name: '⏰ 截止時間', value: `<t:${unix}:F>\n<t:${unix}:R>`, inline: true },
      { name: '📤 繳交', value: 'Moodle 作業區', inline: true },
      { name: '🔗 連結', value: '[作業說明 \\[PDF\\]](https://moodle.example.edu/a?id=1&b=2)', inline: false },
    ]);
    expect(e.footer?.text).toBe('TN0006 跨域數位製作實務');
    expect(checkPayload(p)).toEqual([]);
  });

  test('plain Markdown for pasting by hand', () => {
    const text = plainText({ content: hw, style: 'embed', mention: { type: 'none' }, config });
    expect(text).toBe(
      [
        '-# 📝 作業提醒',
        '## 作業三：互動原型',
        `⏰ **截止時間**　<t:${unix}:F>（<t:${unix}:R>）`,
        '📤 **繳交**　Moodle 作業區',
        '',
        '檔名格式：組別_作業三.pdf',
        '',
        '> ⚠️ 遲交一天扣 10 分',
        '',
        '🔗 [作業說明 \\[PDF\\]](<https://moodle.example.edu/a?id=1&b=2>)',
        '',
        '-# TN0006 跨域數位製作實務',
      ].join('\n'),
    );
  });

  test('no mention means nobody can be pinged by accident', () => {
    const p = renderPayload({ content: { ...hw, body: '@everyone 交作業' }, style: 'text', mention: { type: 'none' }, config });
    expect(p.allowed_mentions).toEqual({ parse: [] });
  });

  test('role mentions', () => {
    const p = renderPayload({ content: hw, style: 'embed', mention: { type: 'role', id: '123456789012345678', name: '學生' }, config });
    expect(p.content).toBe('<@&123456789012345678>');
    expect(p.allowed_mentions).toEqual({ parse: [], roles: ['123456789012345678'] });
  });

  test('all-day and ranged times', () => {
    const day = renderPayload({ content: { ...hw, when: { at: '2026-10-20T09:00:00+08:00', end: null, allDay: true } }, style: 'embed', mention: { type: 'none' }, config });
    expect(day.embeds![0].fields![0].value).toBe(`<t:${Date.parse('2026-10-20T09:00:00+08:00') / 1000}:D>`);
    const range = renderPayload({
      content: { ...hw, when: { at: '2026-11-14T13:00:00+08:00', end: '2026-11-14T17:00:00+08:00', allDay: false } },
      style: 'embed',
      mention: { type: 'none' },
      config,
    });
    const a = Date.parse('2026-11-14T13:00:00+08:00') / 1000;
    expect(range.embeds![0].fields![0].value).toBe(`<t:${a}:F> – <t:${a + 4 * 3600}:t>\n<t:${a}:R>`);
  });

  test('limits are enforced and reported', () => {
    const long = renderPayload({ content: { ...hw, body: 'x'.repeat(5000) }, style: 'text', mention: { type: 'none' }, config });
    expect(checkPayload(long)[0].level).toBe('error');
    const card = renderPayload({ content: { ...hw, title: 't'.repeat(400), body: 'x'.repeat(5000) }, style: 'embed', mention: { type: 'none' }, config });
    expect(card.embeds![0].title!.length).toBe(256);
    expect(card.embeds![0].description!.length).toBe(4096);
  });
});

describe('markdown preview', () => {
  const o = { tz: TPE, now };
  test('escapes HTML and only links http(s)', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.b/c?d=1&e=2)', o);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://a.b/c?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">ok</a>');
  });
  test('Discord markup', () => {
    const html = renderMarkdown(`## 標題\n-# 小字\n**粗** *斜* __底__ ~~刪~~ ||雷|| \`code\`\n> 引用\n- 一\n- 二\n<t:${unix}:F> @everyone`, o);
    expect(html).toContain('<div class="dc-h2">標題</div>');
    expect(html).toContain('<div class="dc-sub">小字</div>');
    expect(html).toContain('<strong>粗</strong> <em>斜</em> <u>底</u> <s>刪</s> <span class="dc-spoiler">雷</span> <code>code</code>');
    expect(html).toContain('<blockquote>引用</blockquote>');
    expect(html).toContain('<ul><li>一</li><li>二</li></ul>');
    expect(html).toContain('2026年10月28日星期三 23:59');
    expect(html).toContain('<span class="dc-mention">@everyone</span>');
  });
  test('code is left alone', () => {
    expect(renderMarkdown('`**not bold**`', o)).toContain('<code>**not bold**</code>');
    expect(renderMarkdown('```\n**x**\n```', o)).toContain('<pre><code>**x**</code></pre>');
  });
  test('links without a preview', () => {
    expect(renderMarkdown('[講義](<https://x.y/z>)', o)).toContain('<a href="https://x.y/z" target="_blank" rel="noopener noreferrer">講義</a>');
  });
});

describe('schedule', () => {
  const event = Date.parse('2026-10-28T23:59:00+08:00');
  test('rule times', () => {
    expect(ruleTime('now', event, now, TPE)).toBe(now);
    expect(isoLocal(ruleTime('d1@20:00', event, now, TPE)!, TPE)).toBe('2026-10-27T20:00:00+08:00');
    expect(isoLocal(ruleTime('m180', event, now, TPE)!, TPE)).toBe('2026-10-28T20:59:00+08:00');
    expect(ruleTime('d1@20:00', null, now, TPE)).toBeNull();
    expect(isoLocal(ruleTime('at:2026-10-20T08:00:00+08:00', null, now, TPE)!, TPE)).toBe('2026-10-20T08:00:00+08:00');
  });
  test('labels say how far away the event is', () => {
    const k = KINDS.homework;
    expect(reminderLabel(k, Date.parse('2026-10-27T20:00:00+08:00'), event, TPE)).toBe('明天截止');
    expect(reminderLabel(k, Date.parse('2026-10-28T20:59:00+08:00'), event, TPE)).toBe('剩 3 小時');
    expect(reminderLabel(k, Date.parse('2026-10-28T23:29:00+08:00'), event, TPE)).toBe('剩 30 分鐘');
    expect(reminderLabel(k, Date.parse('2026-10-21T20:00:00+08:00'), event, TPE)).toBe('7 天後截止');
    expect(reminderLabel(KINDS.class, Date.parse('2026-10-21T13:40:00+08:00'), Date.parse('2026-10-21T14:10:00+08:00'), TPE)).toBe('30 分鐘後上課');
  });
  test('one paste, three posts', () => {
    const { posts, skipped } = plan({ content: hw, kind: KINDS.homework, rules: ['now', 'd1@20:00', 'm180'], repeat: null, now, tz: TPE });
    expect(posts.map((x) => [isoLocal(x.at, TPE), x.label])).toEqual([
      ['2026-10-14T10:00:00+08:00', null],
      ['2026-10-27T20:00:00+08:00', '明天截止'],
      ['2026-10-28T20:59:00+08:00', '剩 3 小時'],
    ]);
    expect(skipped).toEqual([]);
  });
  test('rules in the past or after the event are skipped', () => {
    const soon = { ...hw, when: { at: '2026-10-14T12:00:00+08:00', end: null, allDay: false } };
    const { posts, skipped } = plan({ content: soon, kind: KINDS.homework, rules: ['d1@20:00', 'm180', 'm60'], repeat: null, now, tz: TPE });
    expect(posts.map((x) => isoLocal(x.at, TPE))).toEqual(['2026-10-14T11:00:00+08:00']);
    expect(skipped.map((s) => s.reason)).toEqual(['past', 'past']);
  });
  test('weekly repeats with week numbers', () => {
    const cls: Content = { ...emptyContent('class'), title: '第 {週} 週上課提醒', when: { at: '2026-10-20T14:10:00+08:00', end: null, allDay: false } };
    const occ = occurrences(Date.parse(cls.when!.at), { weeks: 1, until: '2026-11-03' }, TPE);
    expect(occ.map((x) => isoLocal(x, TPE))).toEqual(['2026-10-20T14:10:00+08:00', '2026-10-27T14:10:00+08:00', '2026-11-03T14:10:00+08:00']);
    const { posts } = plan({ content: cls, kind: KINDS.class, rules: ['d1@20:00'], repeat: { weeks: 1, until: '2026-11-03' }, now, tz: TPE, semesterStart: '2026-09-07' });
    expect(posts.map((x) => [isoLocal(x.at, TPE), x.content.title, x.content.when!.at])).toEqual([
      ['2026-10-19T20:00:00+08:00', '第 7 週上課提醒', '2026-10-20T14:10:00+08:00'],
      ['2026-10-26T20:00:00+08:00', '第 8 週上課提醒', '2026-10-27T14:10:00+08:00'],
      ['2026-11-02T20:00:00+08:00', '第 9 週上課提醒', '2026-11-03T14:10:00+08:00'],
    ]);
    expect(fillTokens('第 {n} 次 {日期}', { n: 2, week: null, at: Date.parse('2026-10-27T14:10:00+08:00'), tz: TPE })).toBe('第 2 次 10/27');
  });
});
