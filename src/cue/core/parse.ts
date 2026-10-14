// Turns whatever a TA pastes — "作業三 下週五 23:59 前上傳到 Moodle" — into
// structured content: what kind of post it is, a title, the time it is
// about, where, what to bring, links, bullet points and warnings.
//
// It is plain pattern matching tuned for how Taiwanese classes write
// announcements, so it runs instantly, offline and for free, and it never
// invents anything that was not in the text.

import { emptyContent, KINDS, type Content, type KindKey, type Link, type Mention, type Place } from './model';
import { DAY, isoLocal, parseDayKey, startOfWeek, wall, zoned } from './time';

export interface ParseOptions {
  now: number;
  tz: string;
  /** 'YYYY-MM-DD', Monday of week 1 */
  semesterStart?: string;
}

export interface FoundTime {
  at: number;
  end: number | null;
  hasTime: boolean;
  text: string;
  start: number;
  stop: number;
  line: number;
  role: 'deadline' | 'start' | 'other';
  score: number;
}

export interface ParseResult {
  content: Content;
  mention: Mention | null;
  times: FoundTime[];
  primary: FoundTime | null;
  /** the kind was a weak guess; the time had no clock time and got a default */
  guessed: { kind: boolean; time: boolean; title: boolean };
  scores: Record<KindKey, number>;
  /** semester week of the primary time, when a semester start is set */
  week: number | null;
  /** e.g. the weekday written next to a date does not match it */
  warnings: string[];
}

const DOW_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

// ---------------------------------------------------------------------------
// text helpers

/** Full-width ASCII to half-width, ideographic space to space. Same length. */
export function normalize(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}

const CN: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** '23', '二十三', '廿三', '十', '兩' → number (up to 99). */
export function cnNumber(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const x = t.replace(/^廿/, '二十').replace(/^卅/, '三十');
  if (x === '十') return 10;
  const m = /^([一二兩两三四五六七八九])?十([一二三四五六七八九])?$/.exec(x);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  if (x.length === 1 && x in CN) return CN[x];
  return null;
}

const NUM = '(\\d{1,2}|[零〇一二兩两三四五六七八九十廿卅]{1,3})';
const WEEKDAY_CH: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
// 週一 but not 這週一起 / 下週一定
const WD = '(一(?![起定直樣般下些點共切同致齊再次份律整天週周])|[二三四五六日天])';

interface Span {
  start: number;
  stop: number;
}

const overlaps = (a: Span, b: Span) => a.start < b.stop && b.start < a.stop;

function lineOf(lineStarts: number[], pos: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// dates

type DateSpec =
  | { type: 'ymd'; y: number | null; m: number; d: number }
  | { type: 'rel'; days: number }
  | { type: 'weekday'; dow: number; pre: 'next2' | 'next' | 'this' | 'last' | null }
  | { type: 'week'; n: number; dow: number | null };

interface DateHit extends Span {
  spec: DateSpec;
  /** the weekday written next to the date, e.g. （二） */
  stated: number | null;
  /** 今晚, 明早… also say which part of the day */
  period: string | null;
  text: string;
}

const WEEKDAY_IN_PARENS = new RegExp(`^\\s*[(\\[【]\\s*(?:週|周|星期|禮拜|礼拜)?\\s*${WD}\\s*[)\\]】]`);
const WEEKDAY_AFTER_WEEK = new RegExp(`^\\s*(?:[(\\[【]\\s*(?:週|周|星期|禮拜|礼拜)?\\s*${WD}\\s*[)\\]】]|(?:週|周|星期|禮拜|礼拜)\\s*${WD})`);

function findDates(t: string, taken: Span[]): DateHit[] {
  const hits: DateHit[] = [];
  const add = (start: number, stop: number, spec: DateSpec, period: string | null = null) => {
    const span = { start, stop };
    if (taken.some((x) => overlaps(x, span)) || hits.some((h) => overlaps(h, span))) return;
    // a weekday in parentheses right after a date belongs to it: 10/21（二）
    let stated: number | null = null;
    if (spec.type === 'ymd' || spec.type === 'rel') {
      const tail = WEEKDAY_IN_PARENS.exec(t.slice(stop));
      if (tail) {
        stop += tail[0].length;
        stated = WEEKDAY_CH[tail[1]];
      }
    }
    hits.push({ start, stop, spec, period, stated, text: t.slice(start, stop) });
  };
  let m: RegExpExecArray | null;

  // 2026/10/21, 2026-10-21, 2026年10月21日
  const full = /(20\d{2})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*[日號号]?/g;
  while ((m = full.exec(t))) {
    const mo = +m[2];
    const d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) add(m.index, m.index + m[0].length, { type: 'ymd', y: +m[1], m: mo, d });
  }

  // 10月21日, 十月二十一號
  const cjk = new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日號号]?`, 'g');
  while ((m = cjk.exec(t))) {
    const mo = cnNumber(m[1]);
    const d = cnNumber(m[2]);
    if (mo && d && mo <= 12 && d <= 31) add(m.index, m.index + m[0].length, { type: 'ymd', y: null, m: mo, d });
  }

  // 10/21 (not inside 2026/10/21, a version number or a longer number)
  const slash = /(\d{1,2})\s*\/\s*(\d{1,2})/g;
  while ((m = slash.exec(t))) {
    const before = t[m.index - 1] ?? '';
    const after = t[m.index + m[0].length] ?? '';
    if (/[\d/.]/.test(before) || /[\d/]/.test(after)) continue;
    const mo = +m[1];
    const d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) add(m.index, m.index + m[0].length, { type: 'ymd', y: null, m: mo, d });
  }

  // 今天 明天 後天 大後天 今晚 明早…
  const REL: Record<string, number> = { 大後天: 3, 後天: 2, 明天: 1, 明日: 1, 明晚: 1, 明早: 1, 今天: 0, 今日: 0, 今晚: 0, 今早: 0, 今夜: 0, 昨天: -1, 昨日: -1 };
  const rel = /(大後天|後天|明天|明日|明晚|明早|今天|今日|今晚|今早|今夜|昨天|昨日)/g;
  while ((m = rel.exec(t))) {
    const w = m[1];
    const period = /晚|夜/.test(w) ? '晚上' : /早/.test(w) ? '早上' : null;
    add(m.index, m.index + m[0].length, { type: 'rel', days: REL[w] }, period);
  }

  // 第 8 週（二）, 第八週週二
  const week = new RegExp(`第\\s*${NUM}\\s*(?:週|周)`, 'g');
  while ((m = week.exec(t))) {
    const n = cnNumber(m[1]);
    if (!n || n > 30) continue;
    let stop = m.index + m[0].length;
    let dow: number | null = null;
    const tail = WEEKDAY_AFTER_WEEK.exec(t.slice(stop));
    if (tail) {
      dow = WEEKDAY_CH[tail[1] ?? tail[2]];
      stop += tail[0].length;
    }
    add(m.index, stop, { type: 'week', n, dow });
  }

  // 下週五, 這個星期三, 禮拜天
  const wd = new RegExp(`(下下(?:個)?|下(?:個)?|這(?:個)?|本|上(?:個)?)?\\s*(?:週|周|星期|禮拜|礼拜)\\s*${WD}`, 'g');
  while ((m = wd.exec(t))) {
    const p = m[1] ?? '';
    const pre = p.startsWith('下下') ? 'next2' : p.startsWith('下') ? 'next' : p.startsWith('這') || p === '本' ? 'this' : p.startsWith('上') ? 'last' : null;
    add(m.index, m.index + m[0].length, { type: 'weekday', dow: WEEKDAY_CH[m[2]], pre });
  }

  // 3 天後, 兩週後
  const later = new RegExp(`${NUM}\\s*(?:個)?\\s*(天|日|週|周|星期|禮拜)\\s*(?:後|之後)`, 'g');
  while ((m = later.exec(t))) {
    const n = cnNumber(m[1]);
    if (n === null || n > 60) continue;
    add(m.index, m.index + m[0].length, { type: 'rel', days: /天|日/.test(m[2]) ? n : n * 7 });
  }

  return hits.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// times

interface TimeHit extends Span {
  h: number;
  min: number;
  /** the hour is settled (下午, pm, 14:00, 08:00) and must not be guessed */
  fixed: boolean;
  text: string;
  end: { h: number; min: number } | null;
}

const PERIODS = ['凌晨', '清晨', '一早', '早上', '上午', '中午', '下午', '傍晚', '晚上', '半夜', '午夜', '夜間', '夜裡', '今晚', '明晚', '今早', '明早', '晚', '早', '午'];

function periodBefore(t: string, start: number): { word: string; at: number } | null {
  let i = start;
  while (i > 0 && /[ \t]/.test(t[i - 1])) i--;
  for (const p of PERIODS) {
    if (t.slice(i - p.length, i) === p) return { word: p, at: i - p.length };
  }
  return null;
}

function periodOutsideDates(t: string, start: number, dates: DateHit[]) {
  const p = periodBefore(t, start);
  if (p && dates.some((d) => overlaps(d, { start: p.at, stop: p.at + p.word.length }))) return null;
  return p;
}

/** Applies 下午 / 晚上 / 早上 to a 12-hour clock value. */
function applyPeriod(h: number, period: string | null): { h: number; fixed: boolean } {
  if (!period) return { h, fixed: h > 12 || h === 0 };
  if (/半夜|午夜/.test(period)) return { h: h === 12 ? 24 : h, fixed: true };
  // 晚上 12 點 is the end of the day, not noon
  if (/晚|夜/.test(period) && h === 12) return { h: 24, fixed: true };
  if (/下午|傍晚|晚|夜/.test(period)) return { h: h < 12 ? h + 12 : h, fixed: true };
  if (/中午|午/.test(period)) return { h: h <= 3 ? h + 12 : h, fixed: true };
  // 凌晨 清晨 早上 上午
  return { h: h === 12 ? 0 : h, fixed: true };
}

const DOT_AFTER_REJECT = /^[名數数子擊击選选開开閱阅讚赞亮滴心綴缀菜火燃頭头播單单出]/;
const DOT_BEFORE_REJECT = /[第有下這这幾几些重共]$/;
const TIME_CONTEXT_AFTER = /^\s*(?:前|以前|之前|開始|开始|截止|到|至|~|-|–|—|上課|上课|集合|整|準時|准时|見|见|左右|報到|报到|起|舉行|举行)/;

function findTimes(t: string, taken: Span[], dates: DateHit[]): TimeHit[] {
  const hits: TimeHit[] = [];
  const free = (s: Span) => !taken.some((x) => overlaps(x, s)) && !hits.some((h) => overlaps(h, s)) && !dates.some((d) => overlaps(d, s));
  let m: RegExpExecArray | null;

  // 14:10, 2:10 pm
  const colon = /(\d{1,2})\s*:\s*(\d{2})(?:\s*(am|pm|a\.m\.|p\.m\.))?/gi;
  while ((m = colon.exec(t))) {
    const before = t[m.index - 1] ?? '';
    const after = t[m.index + m[0].length] ?? '';
    if (/[\d:]/.test(before) || /\d/.test(after)) continue;
    let h = +m[1];
    const min = +m[2];
    if (h > 24 || min > 59) continue;
    const span = { start: m.index, stop: m.index + m[0].length };
    if (!free(span)) continue;
    const suffix = m[3]?.toLowerCase().replace(/\./g, '');
    // 08:00 and 14:00 are written on a 24-hour clock
    let fixed = h > 12 || h === 0 || (m[1].length === 2 && m[1][0] === '0');
    if (suffix) {
      h = suffix === 'pm' ? (h < 12 ? h + 12 : h) : h === 12 ? 0 : h;
      fixed = true;
    } else {
      const p = periodOutsideDates(t, m.index, dates);
      if (p) {
        const r = applyPeriod(h, p.word);
        h = r.h;
        fixed = true;
        span.start = p.at;
      }
    }
    hits.push({ ...span, h, min, fixed, text: t.slice(span.start, span.stop), end: null });
  }

  // 2pm
  const ampm = /(\d{1,2})\s*(am|pm)\b/gi;
  while ((m = ampm.exec(t))) {
    let h = +m[1];
    if (h < 1 || h > 12) continue;
    const span = { start: m.index, stop: m.index + m[0].length };
    if (!free(span)) continue;
    h = m[2].toLowerCase() === 'pm' ? (h < 12 ? h + 12 : h) : h === 12 ? 0 : h;
    hits.push({ ...span, h, min: 0, fixed: true, text: m[0], end: null });
  }

  // 下午兩點半, 9點30分, 十點
  const dot = new RegExp(`${NUM}\\s*(點|点|時|时)(?:鐘|钟)?(?:\\s*(\\d{1,2}|[零〇一二三四五六七八九十]{1,3})\\s*分|\\s*(半)|\\s*(一刻|三刻))?`, 'g');
  while ((m = dot.exec(t))) {
    const h0 = cnNumber(m[1]);
    if (h0 === null || h0 > 24) continue;
    const start = m.index;
    const stop = m.index + m[0].length;
    const before = t.slice(Math.max(0, start - 2), start);
    const after = t.slice(stop);
    const minutes = m[3] ?? m[4] ?? m[5];
    if (DOT_BEFORE_REJECT.test(before)) continue;
    // 時 is also "hour" and "when" (三小時, 時間): take it only with minutes
    if (/[時时]/.test(m[2]) && !m[3] && !m[4]) continue;
    if (!minutes && DOT_AFTER_REJECT.test(after)) continue;
    const span = { start, stop };
    if (!free(span)) continue;
    const p = periodOutsideDates(t, start, dates);
    const nearDate = dates.some((d) => d.stop <= start && start - d.stop <= 8 && !/[\n。]/.test(t.slice(d.stop, start)));
    const evidence = p || minutes || nearDate || TIME_CONTEXT_AFTER.test(after) || /^\d+$/.test(m[1]);
    if (!evidence) continue;
    let min = 0;
    if (m[3]) min = cnNumber(m[3]) ?? 0;
    else if (m[4]) min = 30;
    else if (m[5]) min = m[5] === '一刻' ? 15 : 45;
    if (min > 59) continue;
    const r = applyPeriod(h0, p?.word ?? null);
    if (p) span.start = p.at;
    hits.push({ ...span, h: r.h, min, fixed: Boolean(p) || r.fixed, text: t.slice(span.start, span.stop), end: null });
  }

  hits.sort((a, b) => a.start - b.start);

  // ranges: 14:00-16:00, 下午2點到4點
  const out: TimeHit[] = [];
  for (let i = 0; i < hits.length; i++) {
    const a = hits[i];
    const b = hits[i + 1];
    if (b && /^\s*(?:-|–|—|~|～|到|至)\s*$/.test(t.slice(a.stop, b.start))) {
      let bh = b.h;
      if (!b.fixed && a.h >= 12 && bh < 12) bh += 12;
      out.push({ ...a, stop: b.stop, text: t.slice(a.start, b.stop), end: { h: bh, min: b.min } });
      i++;
    } else {
      out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolving dates against "now"

type Ymd = { y: number; m: number; d: number };

function resolveDate(spec: DateSpec, opts: ParseOptions): Ymd | null {
  const now = wall(opts.now, opts.tz);
  const today = Date.UTC(now.y, now.m - 1, now.d);
  const fromUtc = (ms: number): Ymd => {
    const x = new Date(ms);
    return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
  };
  switch (spec.type) {
    case 'ymd': {
      if (spec.y) return { y: spec.y, m: spec.m, d: spec.d };
      // no year: the nearest one that is not long past
      let y = now.y;
      if (Date.UTC(y, spec.m - 1, spec.d) < today - 60 * DAY) y += 1;
      return { y, m: spec.m, d: spec.d };
    }
    case 'rel':
      return fromUtc(today + spec.days * DAY);
    case 'weekday': {
      const monday = today - (now.dow - 1) * DAY;
      if (spec.pre === 'this') return fromUtc(monday + (spec.dow - 1) * DAY);
      if (spec.pre === 'next') return fromUtc(monday + (7 + spec.dow - 1) * DAY);
      if (spec.pre === 'next2') return fromUtc(monday + (14 + spec.dow - 1) * DAY);
      if (spec.pre === 'last') return fromUtc(monday + (-7 + spec.dow - 1) * DAY);
      // a bare 週五 means the coming one
      return fromUtc(today + ((spec.dow - now.dow + 7) % 7) * DAY);
    }
    case 'week': {
      if (!opts.semesterStart || !/^\d{4}-\d{2}-\d{2}$/.test(opts.semesterStart)) return null;
      const s = parseDayKey(opts.semesterStart);
      return fromUtc(Date.UTC(s.y, s.m - 1, s.d) + ((spec.n - 1) * 7 + ((spec.dow ?? 1) - 1)) * DAY);
    }
  }
}

/** Semester week number of a day, or null. */
export function semesterWeek(ms: number, semesterStart: string | undefined, tz: string): number | null {
  if (!semesterStart || !/^\d{4}-\d{2}-\d{2}$/.test(semesterStart)) return null;
  const s = parseDayKey(semesterStart);
  const first = startOfWeek(zoned(s.y, s.m, s.d, 12, 0, tz), tz);
  const n = Math.round((startOfWeek(ms, tz) - first) / (7 * DAY)) + 1;
  return n >= 1 && n <= 60 ? n : null;
}

// ---------------------------------------------------------------------------
// kinds

const KIND_WORDS: Record<KindKey, Array<[RegExp, number]>> = {
  exam: [
    [/期中考|期末考|小考|隨堂考|段考|模擬考|筆試|口試|期中測驗|期末測驗/g, 6],
    [/考試|測驗|quiz|midterm|final exam|exam/gi, 5],
    [/考(?!慮|量|察|核|驗|古)/g, 1],
    [/考試範圍|小抄|題型|考場|開書|閉書|應考/g, 2],
  ],
  homework: [
    [/作業|hw\s*#?\d|homework|assignment/gi, 5],
    [/繳交|提交|上傳|交件|截止|期限|deadline|due/gi, 3],
    [/遲交|補交|作品集|心得|報告|提案/g, 2],
  ],
  class: [
    [/上課|下課|課堂|lecture/gi, 4],
    [/點名|補課|調課|線上課|實體課|請假|課程內容|本週課程|今天的課/g, 2],
    [/教室/g, 1],
  ],
  event: [
    [/講座|演講|工作坊|workshop|分享會|說明會|展演|展覽|成果展|發表會|期中發表|期末發表|彩排|參訪|比賽|競賽|活動|聚餐|迎新|派對|典禮|開幕/gi, 4],
    [/報名|入場|嘉賓|講者|名額/g, 2],
  ],
  material: [
    [/講義|投影片|簡報檔|slides?\b|教材|錄影|課程影片|教學資源|參考資料|閱讀資料|延伸閱讀|reading/gi, 4],
    [/下載|雲端|資料夾|檔案/g, 1],
  ],
  notice: [[/公告|通知|宣布|注意|重要|異動|更改|變更|取消|停課|延後|提前|調整/g, 3]],
};

function scoreKinds(t: string, title: string): Record<KindKey, number> {
  const scores: Record<KindKey, number> = { class: 0, homework: 0, exam: 0, event: 0, material: 0, notice: 0 };
  for (const k of Object.keys(KIND_WORDS) as KindKey[]) {
    for (const [re, w] of KIND_WORDS[k]) {
      scores[k] += Math.min(t.match(re)?.length ?? 0, 2) * w;
      // the first line usually says what the post is: it counts again
      scores[k] += Math.min(title.match(re)?.length ?? 0, 1) * w;
    }
  }
  // 停課 is news about a class, not a reminder to attend one
  if (/停課|取消上課|不上課/.test(t)) scores.notice += 4;
  return scores;
}

// ---------------------------------------------------------------------------
// links and places

const URL_SOURCE = String.raw`https?:\/\/[^\s<>"'()（）「」『』【】，。、；！？]+`;

const DOMAINS: Array<[RegExp, string]> = [
  [/docs\.google\.com\/forms|forms\.gle/, 'Google 表單'],
  [/docs\.google\.com\/presentation/, 'Google 簡報'],
  [/docs\.google\.com\/spreadsheets/, 'Google 試算表'],
  [/docs\.google\.com\/document/, 'Google 文件'],
  [/drive\.google\.com/, 'Google 雲端硬碟'],
  [/meet\.google\.com/, 'Google Meet'],
  [/calendar\.google\.com/, 'Google 日曆'],
  [/classroom\.google\.com/, 'Google Classroom'],
  [/zoom\.us/, 'Zoom'],
  [/teams\.(?:microsoft|live)\.com/, 'Microsoft Teams'],
  [/moodle/, 'Moodle'],
  [/youtube\.com|youtu\.be/, 'YouTube'],
  [/github\.com/, 'GitHub'],
  [/figma\.com/, 'Figma'],
  [/notion\.so|notion\.site/, 'Notion'],
  [/hackmd\.io/, 'HackMD'],
  [/canva\.com/, 'Canva'],
  [/miro\.com/, 'Miro'],
  [/discord\.(?:com|gg)/, 'Discord'],
  [/dropbox\.com/, 'Dropbox'],
  [/onedrive|sharepoint\.com|1drv\.ms/, 'OneDrive'],
  [/slido\.com|sli\.do/, 'Slido'],
  [/kahoot/, 'Kahoot!'],
  [/instagram\.com/, 'Instagram'],
  [/facebook\.com|fb\.me/, 'Facebook'],
];

export function linkLabel(url: string): string {
  for (const [re, label] of DOMAINS) if (re.test(url)) return label;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '連結';
  }
}

const ONLINE_LINK = /meet\.google\.com|zoom\.us|teams\.(?:microsoft|live)\.com|webex\.com/;
const PLACE_LABELED =
  /(上課地點|集合地點|地點|教室|場地|位置|地址|會議室|location|venue|room)\s*(?::|改到|改在|換到|移到|改為|在|為|是)\s*([^\n，。；;,!！]{2,40})/i;
const PLACE_INLINE = /(?:在|於|到)\s*([^\s，。；;,!！、]{1,8}(?:\s?[A-Za-z]?\d{0,4}\s?[^\s，。；;,!！、]{0,6})?)/g;
const PLACE_WORD = /館|樓|室|廳|中心|基地|大樓|學院|lab\b|教室|空間|劇場|棚|廣場|咖啡|圖書|\d{3}/i;
const SUBMIT = /(?:上傳|繳交|提交|交)\s*(?:到|至|在)\s*([^\s，。；;,!！、\n][^，。；;,!！、\n]{0,18})/;
const PLACE_STOP = /(上課|集合|舉行|見面|開會|進行|報到|討論|彩排|考試|上台|發表|一起|喔|哦|唷|囉|呦|啦|吧)$/;

function cleanPlace(v: string): string {
  let s = v.trim().replace(/[，。；;,!！]+$/, '');
  for (let i = 0; i < 3 && PLACE_STOP.test(s); i++) s = s.replace(PLACE_STOP, '').trim();
  return s;
}

// ---------------------------------------------------------------------------
// lines

const BULLET = /^\s*(?:[-*•·‧▪●○◦]|\d{1,2}[.)、](?!\d)|[①-⑳]|\(\d{1,2}\)|[一二三四五六七八九十][、.])\s*(.+)$/;
const NOTE_START = /^\s*(?:注意|提醒|備註|備注|ps|p\.s\.|※|⚠️?|❗|！|!)\s*[:：]?\s*/i;
const NOTE_WORDS = /遲交|扣分|不接受|不收|務必|一定要|請勿|切勿|不要|禁止|不得|嚴禁|逾期|不予|記得|別忘|請注意/;
const FIELD_LABEL =
  /^\s*(?:[⏰📅🕒📍🔗🎒📤]\s*)?(?:時間|日期|上課時間|活動時間|考試時間|截止時間|截止日期|繳交期限|繳交時間|期限|截止|deadline|due|地點|教室|上課地點|集合地點|場地|連結|網址|link|攜帶|準備物品|繳交方式|繳交)\s*[:：]/i;
const FILLER =
  /[\s:：,，。.;；、!！?？()（）[\]【】「」『』\-–—~～*_>#|/]|之?前|以前|為止|截止|期限|繳交|時間|日期|地點|改到|改在|換到|改為|教室|連結|網址|攜帶|準備|請|記得|在|到|於|是|為|的|喔|哦|囉|唷|上傳|提交|當天|開始/g;

const BRING_LABELED = /(?:攜帶|準備物品|需攜帶|要帶的東西|攜帶物品)\s*[:：]\s*([^\n]{2,60})/;
const BRING_INLINE =
  /(?:請|記得|務必|需要|要|需)\s*(?:各組|大家|同學|每人|每組|每位同學|各位)?\s*(?:都)?\s*(?:記得)?\s*(?:攜帶|帶|準備)(?!領|來|去|動|著|入|回|走)\s*([^\n，。；;!！]{2,40})/;

function cleanBring(v: string): string {
  return v
    .trim()
    .replace(/(?:來|過來|到教室|到場|上課|喔|哦|囉|唷|呦)+$/, '')
    .replace(/\s*(?:和|跟|與|及|以及)\s*/g, '、')
    .replace(/[，。；;!！]+$/, '')
    .trim();
}

const EVENT_ITEM = /([\p{Script=Han}A-Za-z0-9]{0,6}(?:彩排|講座|演講|工作坊|分享會|說明會|展演|展覽|成果展|發表會|參訪|比賽|競賽|聚餐|迎新|典禮))/u;

const TITLE_ITEM =
  /(期中報告|期末報告|期末專題|期中提案|期末提案|期中考|期末考|小考|作業|hw|homework|lab|實驗|報告|專題|提案|測驗|quiz|作品)(\s*(?:#|第)?\s*[0-9一二三四五六七八九十]+(?![\d/月:.\-]))?(?:\s*[:：]\s*([^\n，。;；!！]{2,24}))?/i;
// "10/25 前填寫期末分組表單" → 填寫期末分組表單
const TASK_AFTER_DEADLINE = /(?:前|之前|以前)\s*((?:填寫|繳交|上傳|完成|提交|報名|回覆|寄出|寄|交|確認|登記|選)[^\n，。；;!！]{1,16})/;
const SENTENCE_START = /^(?:在|於|到|要|請|會|將|有|把|讓|記得|是|就|都|也|還)/;

function stripDecor(s: string): string {
  return s
    .replace(/^[\s#>*_~]+/, '')
    .replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '')
    .replace(/^[【[「『]\s*/, '')
    .replace(/\s*[】\]」』]\s*$/, '')
    .replace(/(\*\*|__|~~)/g, '')
    .trim();
}

function withDefaultTime(dayStart: number, kind: KindKey, tz: string): number {
  const [h, min] = KINDS[kind].defaultTime.split(':').map(Number);
  const w = wall(dayStart, tz);
  return zoned(w.y, w.m, w.d, h, min, tz);
}

// ---------------------------------------------------------------------------

export function parse(raw: string, opts: ParseOptions): ParseResult {
  const original = raw.replace(/\r\n?/g, '\n');
  const t = normalize(original);
  const tz = opts.tz;
  const lineStarts = [0];
  for (let i = 0; i < t.length; i++) if (t[i] === '\n') lineStarts.push(i + 1);
  const lines = original.split('\n');
  const nLines = t.split('\n');
  let m: RegExpExecArray | null;

  // links first: nothing inside a URL is a date or a time
  const urls: Array<Span & { url: string; line: number }> = [];
  const urlRe = new RegExp(URL_SOURCE, 'g');
  while ((m = urlRe.exec(t))) {
    const url = original.slice(m.index, m.index + m[0].length).replace(/[.,;:!?)\]}>'"]+$/, '');
    urls.push({ start: m.index, stop: m.index + url.length, url, line: lineOf(lineStarts, m.index) });
  }

  // @everyone / @here
  let mention: Mention | null = null;
  const mentionSpans: Span[] = [];
  const mentionRe = /@(everyone|here|全體|所有人)/gi;
  while ((m = mentionRe.exec(t))) {
    const w = m[1].toLowerCase();
    if (!mention || mention.type !== 'everyone') mention = w === 'here' ? { type: 'here' } : { type: 'everyone' };
    mentionSpans.push({ start: m.index, stop: m.index + m[0].length });
  }

  const dates = findDates(t, urls);
  const times = findTimes(t, urls, dates);

  // ---- bind each time to its date
  const found: FoundTime[] = [];
  const usedDates = new Set<DateHit>();
  const at = (date: Ymd, h: number, min: number) =>
    // 24:00 and 晚上 12 點 deadlines mean the end of that day
    h >= 24 ? zoned(date.y, date.m, date.d, 23, 59, tz) : zoned(date.y, date.m, date.d, h, min, tz);
  for (const tm of times) {
    const line = lineOf(lineStarts, tm.start);
    const sameLine = dates.filter((d) => lineOf(lineStarts, d.start) === line);
    // nearest date before it on its line, then right after it, then any earlier date
    let date = sameLine.filter((d) => d.stop <= tm.start).pop();
    if (!date) date = sameLine.find((d) => d.start >= tm.stop && d.start - tm.stop <= 10);
    if (!date) date = dates.filter((d) => d.stop <= tm.start).pop();
    let h = tm.h;
    let ymd: Ymd | null = null;
    if (date) {
      usedDates.add(date);
      ymd = resolveDate(date.spec, opts);
      if (date.period && !tm.fixed) {
        h = applyPeriod(h, date.period).h;
      }
    }
    const floating = !ymd;
    if (!ymd) {
      const w = wall(opts.now, tz);
      ymd = { y: w.y, m: w.m, d: w.d };
    }
    // a bare 2:10 during the school day is the afternoon
    const settled = tm.fixed || Boolean(date?.period);
    if (!settled && h >= 1 && h <= 6) h += 12;
    let ms = at(ymd, h, tm.min);
    if (floating && ms < opts.now) ms += DAY;
    if (date?.spec.type === 'weekday' && date.spec.pre === null && ms < opts.now - 60_000) ms += 7 * DAY;
    let end: number | null = null;
    if (tm.end) {
      let eh = tm.end.h;
      if (!settled && eh >= 1 && eh <= 6 && h >= 12) eh += 12;
      end = at(ymd, eh, tm.end.min);
      if (floating && end < opts.now) end += DAY;
      if (date?.spec.type === 'weekday' && date.spec.pre === null && ms - end > DAY) end += 7 * DAY;
      if (end <= ms) end = null;
    }
    const joined = date && lineOf(lineStarts, date.start) === line;
    const start = joined && date!.start < tm.start ? date!.start : tm.start;
    const stop = joined && date!.stop > tm.stop ? date!.stop : tm.stop;
    found.push({ at: ms, end, hasTime: true, text: t.slice(start, stop).trim(), start, stop, line, role: 'other', score: 0 });
  }
  for (const d of dates) {
    if (usedDates.has(d)) continue;
    const ymd = resolveDate(d.spec, opts);
    if (!ymd) continue;
    let ms = zoned(ymd.y, ymd.m, ymd.d, 0, 0, tz);
    if (d.spec.type === 'weekday' && d.spec.pre === null && ms < opts.now - DAY) ms += 7 * DAY;
    found.push({ at: ms, end: null, hasTime: false, text: d.text.trim(), start: d.start, stop: d.stop, line: lineOf(lineStarts, d.start), role: 'other', score: 0 });
  }
  // date ranges: 11/15 ~ 11/16
  found.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < found.length; i++) {
    const a = found[i];
    const b = found[i + 1];
    if (!a.end && /^\s*(?:-|–|—|~|～|到|至)\s*$/.test(t.slice(a.stop, b.start)) && b.at > a.at) {
      a.end = b.hasTime ? b.at : b.at + DAY - 60_000;
      a.stop = b.stop;
      a.text = t.slice(a.start, b.stop).trim();
      found.splice(i + 1, 1);
    }
  }

  // ---- roles and the primary time
  for (const f of found) {
    const before = t.slice(Math.max(lineStarts[f.line], f.start - 12), f.start);
    const after = t.slice(f.stop, f.stop + 6);
    if (/截止|期限|deadline|due|繳交|交件|上傳|提交/i.test(before) || /^\s*(?:前|以前|之前|截止|為止)/.test(after)) {
      f.role = 'deadline';
      f.score += 4;
    } else if (/上課|開始|集合|考試|舉行|報到|開會|活動|時間|日期|於|在|演講|彩排/.test(before + after)) {
      f.role = 'start';
      f.score += 3;
    }
    if (f.hasTime) f.score += 1;
    if (f.line <= 1) f.score += 1;
    if ((f.end ?? f.at + (f.hasTime ? 0 : DAY)) < opts.now - 3_600_000) f.score -= 6;
  }
  const primary = [...found].sort((a, b) => b.score - a.score || a.start - b.start)[0] ?? null;

  // ---- kind
  const scores = scoreKinds(t, nLines.find((l) => l.trim()) ?? '');
  if (primary?.role === 'deadline') scores.homework += 3;
  let kind: KindKey = 'notice';
  let best = 0;
  for (const k of ['exam', 'homework', 'event', 'class', 'material', 'notice'] as KindKey[]) {
    if (scores[k] > best) {
      best = scores[k];
      kind = k;
    }
  }

  // spans whose information now lives in a field
  const consumed: Span[] = [...urls, ...mentionSpans, ...found.map((f) => ({ start: f.start, stop: f.stop }))];
  const consume = (line: number, a: number, b: number) => consumed.push({ start: lineStarts[line] + a, stop: lineStarts[line] + b });
  const groupText = (line: number, mm: RegExpExecArray, g: string) => {
    const stop = mm.index + mm[0].length;
    return lines[line].slice(stop - g.length, stop);
  };

  // ---- place
  let place: Place | null = null;
  for (let i = 0; i < nLines.length && !place; i++) {
    const pm = PLACE_LABELED.exec(nLines[i]);
    if (!pm) continue;
    const v = cleanPlace(groupText(i, pm, pm[2]));
    if (v.length >= 2 && !/^https?:/.test(v)) {
      place = { label: '地點', value: v };
      consume(i, pm.index, pm.index + pm[0].length);
    }
  }
  for (let i = 0; i < nLines.length && !place; i++) {
    const re = new RegExp(PLACE_INLINE.source, 'g');
    let pm: RegExpExecArray | null;
    while ((pm = re.exec(nLines[i]))) {
      const v = cleanPlace(groupText(i, pm, pm[1]));
      if (v.length >= 2 && PLACE_WORD.test(v) && !/https?:/.test(v)) {
        place = { label: '地點', value: v };
        consume(i, pm.index, pm.index + pm[0].length);
        break;
      }
    }
  }
  if (!place && (kind === 'homework' || primary?.role === 'deadline')) {
    for (let i = 0; i < nLines.length && !place; i++) {
      const sm = SUBMIT.exec(nLines[i]);
      if (!sm) continue;
      const v = cleanPlace(groupText(i, sm, sm[1])).replace(/(?:前|之前|以前)$/, '');
      if (v.length >= 2 && !/https?:/.test(v)) {
        place = { label: '繳交', value: v };
        consume(i, sm.index, sm.index + sm[0].length);
      }
    }
  }
  if (!place) {
    const online = urls.find((u) => ONLINE_LINK.test(u.url));
    if (online) place = { label: '地點', value: `線上（${linkLabel(online.url)}）` };
    else if (/線上上課|線上進行|視訊|遠距|google meet|zoom|teams/i.test(t)) place = { label: '地點', value: '線上' };
  }

  // ---- bring
  let bring = '';
  for (let i = 0; i < nLines.length && !bring; i++) {
    const bm = BRING_LABELED.exec(nLines[i]) ?? BRING_INLINE.exec(nLines[i]);
    if (!bm) continue;
    const v = cleanBring(groupText(i, bm, bm[1]));
    if (v.length >= 2) {
      bring = v;
      consume(i, bm.index, bm.index + bm[0].length);
    }
  }

  // ---- links, named by an explicit label ("簡報：https://…") or by their site
  const links: Link[] = [];
  const linkCuts: Span[] = [];
  for (const u of urls) {
    if (links.some((l) => l.url === u.url)) continue;
    const seg = original.slice(lineStarts[u.line], u.start).split(/[，。；;、]/).pop() ?? '';
    const labelled = /(?:[:：]|→|➡️?|👉)\s*$/.test(seg);
    let label = labelled ? stripDecor(seg.replace(/(?:[:：]|→|➡️?|👉)\s*$/, '').trim()).replace(/^(?:連結|網址|link|url)$/i, '') : '';
    const fallback = linkLabel(u.url);
    if (!label || label.length > 16 || /^\d+$/.test(label)) label = fallback;
    links.push({ url: u.url, label });
    const cut = { start: label === fallback ? u.start : u.start - seg.length, stop: u.stop };
    linkCuts.push(cut);
    consumed.push(cut);
  }

  // ---- title
  let titleLine = -1;
  let title = '';
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx >= 0) {
    const from = lineStarts[firstIdx];
    const l0 = lines[firstIdx];
    // the first line without links and mentions
    let bare = '';
    for (let c = 0; c < l0.length; c++) {
      const pos = from + c;
      bare += urls.some((u) => pos >= u.start && pos < u.stop) || mentionSpans.some((x) => pos >= x.start && pos < x.stop) ? ' ' : l0[c];
    }
    const bracketed = /^[#\s]*[\p{Extended_Pictographic}\uFE0F\s]*[【[「『]/u.test(bare) || /^\s*#{1,3}\s/.test(bare);
    const sentence = /[。！!?？,，;；]/.test(normalize(bare).trim().replace(/[!！]+$/, ''));
    const spans = found.filter((f) => f.line === firstIdx).sort((a, b) => a.start - b.start);
    let cand = '';
    if (bracketed) {
      cand = stripDecor(bare);
    } else if (!sentence && normalize(bare).trim().length <= 32) {
      if (!spans.length) {
        cand = stripDecor(bare);
      } else if (!bare.slice(0, spans[0].start - from).trim()) {
        // the line opens with its date: "10/21（二）停課通知" → 停課通知
        let k = 0;
        while (k + 1 < spans.length && !bare.slice(spans[k].stop - from, spans[k + 1].start - from).trim()) k++;
        const rest = stripDecor(bare.slice(spans[k].stop - from).replace(/^[\s,，:：\-–]+/, ''));
        const more = spans.slice(k + 1).length > 0 || (place && rest.includes(place.value));
        if (rest.length >= 3 && !more && !SENTENCE_START.test(rest)) cand = rest;
      }
    }
    if (cand.length >= 2) {
      title = cand.slice(0, 80);
      titleLine = firstIdx;
    }
  }
  let titleGuessed = false;
  if (!title) {
    const im = TITLE_ITEM.exec(t);
    if (im && (kind === 'homework' || kind === 'exam')) {
      const head = original.slice(im.index, im.index + im[1].length + (im[2]?.length ?? 0)).trim();
      const sub = im[3] ? `：${original.slice(im.index + im[0].length - im[3].length, im.index + im[0].length).trim()}` : '';
      title = `${head}${sub}`;
    }
    const task = !title && primary?.role === 'deadline' ? TASK_AFTER_DEADLINE.exec(t.slice(primary.stop, primary.stop + 24)) : null;
    if (task) {
      const from = primary!.stop + task.index + task[0].length - task[1].length;
      title = original.slice(from, primary!.stop + task.index + task[0].length).split(/\s*https?:/)[0].trim();
    }
    const em = !title && kind === 'event' ? EVENT_ITEM.exec(original) : null;
    if (em && em[1].length >= 2) title = em[1];
    if (!title) {
      title = KINDS[kind].headline;
      titleGuessed = true;
    }
  }

  // ---- the remaining lines: body, bullets and notes
  const bullets: string[] = [];
  const notes: string[] = [];
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === titleLine) continue;
    const l = lines[i];
    const n = nLines[i];
    if (!l.trim()) {
      if (body.length && body[body.length - 1] !== '') body.push('');
      continue;
    }
    const span = { start: lineStarts[i], stop: lineStarts[i] + n.length };
    const touched = consumed.some((s) => overlaps(s, span));
    if (touched) {
      // what is left of the line once fields, dates and links are taken out
      let residue = '';
      for (let c = 0; c < n.length; c++) {
        const pos = lineStarts[i] + c;
        if (!consumed.some((s) => pos >= s.start && pos < s.stop)) residue += n[c];
      }
      residue = residue.replace(FILLER, '');
      if (residue.length <= 2 || (FIELD_LABEL.test(n) && residue.length <= 4)) continue;
    }
    // links live in their own field
    let keep = l;
    for (const c of linkCuts.filter((c) => c.start >= span.start && c.start < span.stop).sort((a, b) => b.start - a.start)) {
      keep = keep.slice(0, c.start - span.start) + keep.slice(c.stop - span.start);
    }
    keep = keep
      .replace(/@(?:everyone|here|全體|所有人)\s*/gi, '')
      .replace(/[\s:：]+$/, '')
      .trim();
    if (!keep || keep.replace(FILLER, '').length <= 1) continue;
    const b = BULLET.exec(keep);
    if (b) {
      bullets.push(b[1].trim());
      continue;
    }
    if (NOTE_START.test(keep) || NOTE_WORDS.test(keep)) {
      const note = keep.replace(NOTE_START, '').trim();
      if (note) notes.push(note);
      continue;
    }
    body.push(keep);
  }
  while (body.length && body[body.length - 1] === '') body.pop();

  // ---- when
  let when: Content['when'] = null;
  if (primary) {
    // a deadline with no clock time is the end of that day; other days are all-day
    const allDay = !primary.hasTime && kind !== 'homework' && primary.role !== 'deadline';
    const ms = primary.hasTime ? primary.at : withDefaultTime(primary.at, primary.role === 'deadline' ? 'homework' : kind, tz);
    when = { at: isoLocal(ms, tz), end: primary.end ? isoLocal(primary.end, tz) : null, allDay };
  }

  const week = primary ? semesterWeek(primary.at, opts.semesterStart, tz) : null;
  if (titleGuessed && week && kind === 'class') title = `第 ${week} 週${KINDS[kind].headline}`;

  // ---- things worth a second look before posting
  const warnings: string[] = [];
  for (const d of dates) {
    if (!d.stated || d.spec.type !== 'ymd') continue;
    const ymd = resolveDate(d.spec, opts);
    if (!ymd) continue;
    const actual = wall(zoned(ymd.y, ymd.m, ymd.d, 12, 0, tz), tz).dow;
    if (actual !== d.stated) {
      warnings.push(`${ymd.m}/${ymd.d} 是星期${DOW_NAMES[actual]}，但文字寫的是星期${DOW_NAMES[d.stated]}，請確認日期。`);
    }
  }
  if (primary && (primary.end ?? primary.at) < opts.now && primary.hasTime) warnings.push('文字裡的時間已經過了，請確認日期。');

  return {
    content: { ...emptyContent(kind), title, body: body.join('\n'), when, place, bring, links, bullets, notes },
    mention,
    times: found.sort((a, b) => a.at - b.at),
    primary,
    guessed: { kind: best < 4, time: Boolean(primary && !primary.hasTime), title: titleGuessed },
    scores,
    week,
    warnings,
  };
}
