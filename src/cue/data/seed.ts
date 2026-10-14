// Demo data: one semester of TN0006 in full swing, built relative to "now"
// so the demo always has posts that went out this morning, reminders
// queued for tonight, a recurring class reminder, a failure to look at and
// a draft — every state the app can show.

import { defaultConfig, emptyContent, newId, secretName, type Channel, type Config, type Content, type Post, type Posts } from '../core/model';
import { addLog, makePost } from '../core/ops';
import { addDays, DAY, HOUR, isoLocal, MINUTE, startOfDay, startOfWeek, wall, zoned } from '../core/time';
import { plan } from '../core/schedule';
import { kindStyle } from '../core/model';

const TZ = 'Asia/Taipei';

function channel(id: string, name: string, emoji: string, color: string, note: string, extra: Partial<Channel> = {}): Channel {
  return {
    id,
    name,
    emoji,
    color,
    note,
    secret: secretName(id),
    webhookSavedAt: '2026-09-01T10:00:00+08:00',
    webhookHint: `…${String([...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1000000, 7)).padStart(6, '4')}`,
    username: '',
    avatar: '',
    mention: { type: 'none' },
    discord: { name: 'Cue', channel: '1290000000000000000', guild: '1280000000000000000' },
    test: null,
    ...extra,
  };
}

export function demoConfig(now: number): Config {
  const monday = startOfWeek(now, TZ);
  // put "now" in week 7 of the semester
  const semesterStart = isoLocal(monday - 6 * 7 * DAY, TZ).slice(0, 10);
  return {
    ...defaultConfig(isoLocal(now, TZ)),
    course: 'TN0006 一場體驗如何發生：跨域數位製作實務',
    footer: 'TN0006 跨域數位製作實務 · 由 Cue 排程發送',
    semesterStart,
    username: '課程助教',
    channels: [
      channel('ch_news', '公告', '📢', '#5865f2', '全班必看的課程公告', { mention: { type: 'everyone' } }),
      channel('ch_class', '上課提醒', '📚', '#10b981', '每週上課前一晚自動提醒'),
      channel('ch_hw', '作業繳交', '📝', '#f59e0b', '作業公告與截止提醒'),
      channel('ch_oh', 'office-hour', '☕', '#a855f7', 'Office Hour 時段與異動', {
        test: { id: 't_seed', at: isoLocal(now - 20 * 3600_000, TZ), ok: false, error: 'Webhook 已被刪除或網址錯誤，請到頻道設定重新貼上 Webhook（Discord 10015）' },
      }),
      channel('ch_show', '期末展演', '🎬', '#ec4899', '期末展演籌備與彩排'),
    ],
  };
}

interface SeedItem {
  content: Content;
  channels: string[];
  rules: string[];
  repeat?: { weeks: 1 | 2; until: string };
  style?: 'embed' | 'text';
  mention?: Post['mention'];
  source: string;
  /** pretend it was composed this long before now */
  createdAgo: number;
}

const at = (ms: number) => isoLocal(ms, TZ);

export function demoPosts(config: Config, now: number): Posts {
  const today = startOfDay(now, TZ);
  const monday = startOfWeek(now, TZ);
  const dayAt = (base: number, days: number, h: number, m = 0) => {
    const x = wall(base, TZ);
    return zoned(x.y, x.m, x.d + days, h, m, TZ);
  };
  // the class meets on Tuesdays 14:10
  const lastTue = dayAt(monday, -6, 14, 10);
  const term = semesterEnd(config, monday);

  const items: SeedItem[] = [
    {
      // weekly class reminders: the past ones went out, the coming ones wait
      content: {
        ...emptyContent('class'),
        title: '第 {週} 週上課提醒',
        body: '這週進入「體驗原型」單元，請各組先在 Miro 貼上上週的訪談洞察。',
        when: { at: at(dayAt(monday, -13, 14, 10)), end: at(dayAt(monday, -13, 17, 0)), allDay: false },
        place: { label: '地點', value: '設計學院 B1 創意基地' },
        bring: '筆電、上週的訪談紀錄',
        links: [{ url: 'https://miro.com/app/board/demo-tn0006=/', label: 'Miro 白板' }],
      },
      channels: ['ch_class'],
      rules: ['d1@20:00'],
      repeat: { weeks: 1, until: term },
      source: '第 {週} 週上課提醒\n每週二下午 2:10 在設計學院 B1 創意基地\n請帶筆電、上週的訪談紀錄',
      createdAgo: 16 * DAY,
    },
    {
      content: {
        ...emptyContent('homework'),
        title: '作業二：使用者旅程地圖',
        body: '以小組為單位，畫出一位真實使用者從「聽說」到「再次參加」的完整旅程。',
        when: { at: at(dayAt(today, -2, 23, 59)), end: null, allDay: false },
        place: { label: '繳交', value: 'Moodle 作業區' },
        links: [{ url: 'https://moodle.example.edu/mod/assign/view.php?id=2002', label: '作業說明' }],
        notes: ['遲交一天扣 10 分，最多扣到 50 分'],
      },
      channels: ['ch_hw'],
      rules: ['at:' + at(dayAt(today, -9, 9, 0)), 'd1@20:00', 'm180'],
      source: '作業二：使用者旅程地圖\n繳交期限：' + fmt(dayAt(today, -2, 23, 59)) + ' 23:59\n上傳到 Moodle 作業區\n遲交一天扣 10 分',
      createdAgo: 9 * DAY + HOUR,
    },
    {
      content: {
        ...emptyContent('material'),
        title: '第 6 週講義與錄影',
        body: '上週「服務藍圖」的投影片和課堂錄影都放在雲端資料夾了，請自行下載。',
        links: [
          { url: 'https://drive.google.com/drive/folders/demo-w6', label: '講義資料夾' },
          { url: 'https://www.youtube.com/watch?v=demo-w6', label: '課堂錄影' },
        ],
      },
      channels: ['ch_news'],
      rules: ['at:' + at(lastTue + 5 * HOUR)],
      style: 'text',
      source: '第 6 週講義與錄影\nhttps://drive.google.com/drive/folders/demo-w6',
      createdAgo: 6 * DAY,
    },
    {
      content: {
        ...emptyContent('notice'),
        title: '本週 Office Hour 時段調整',
        body: '週四下午改到 15:30–17:30，想約的組別請到 Office Hour 平台重新勾選。',
        when: { at: at(dayAt(monday, 3, 15, 30)), end: at(dayAt(monday, 3, 17, 30)), allDay: false },
        links: [{ url: 'https://g904338.github.io/tnda-office-hour/', label: 'Office Hour 預約平台' }],
      },
      channels: ['ch_oh'],
      rules: ['at:' + at(dayAt(today, -1, 12, 0))],
      source: '本週 Office Hour 時段調整',
      createdAgo: DAY + 2 * HOUR,
    },
    {
      content: {
        ...emptyContent('homework'),
        title: '作業三：互動原型',
        body: '用 Figma 或實體材料做出可以被測試的原型，並附上一頁測試計畫。',
        when: { at: at(dayAt(today, 7, 23, 59)), end: null, allDay: false },
        place: { label: '繳交', value: 'Moodle 作業區' },
        links: [
          { url: 'https://moodle.example.edu/mod/assign/view.php?id=2003', label: '作業說明' },
          { url: 'https://www.figma.com/community/file/demo', label: 'Figma 範本' },
        ],
        bullets: ['原型檔案或照片', '一頁測試計畫（PDF）', '組員分工表'],
        notes: ['檔名格式：組別_作業三.pdf'],
      },
      channels: ['ch_hw', 'ch_news'],
      rules: ['at:' + at(today + 9 * HOUR + 5 * MINUTE), 'd3@20:00', 'd1@20:00', 'm180'],
      mention: { type: 'everyone' },
      source: '作業三：互動原型\n繳交期限：' + fmt(dayAt(today, 7, 23, 59)) + ' 23:59\n- 原型檔案或照片\n- 一頁測試計畫（PDF）\n- 組員分工表\n檔名格式：組別_作業三.pdf',
      createdAgo: 3 * HOUR,
    },
    {
      content: {
        ...emptyContent('exam'),
        title: '期中筆試',
        body: '範圍是第 1–8 週的課堂內容與指定閱讀，題型為簡答與情境題。',
        when: { at: at(dayAt(monday, 15, 9, 10)), end: at(dayAt(monday, 15, 11, 0)), allDay: false },
        place: { label: '地點', value: '設計學院 3F 301 教室' },
        bring: '學生證、黑色原子筆',
        notes: ['可以帶一張 A4 手寫小抄'],
      },
      channels: ['ch_news'],
      rules: ['d7@20:00', 'd1@20:00'],
      source: '期中筆試\n範圍第 1–8 週\n地點：設計學院 3F 301 教室',
      createdAgo: 2 * DAY,
    },
    {
      content: {
        ...emptyContent('event'),
        title: '期末展演彩排',
        body: '各組 15 分鐘走位與技術測試，順序會在前一天公布。',
        when: { at: at(dayAt(monday, 33, 13, 0)), end: at(dayAt(monday, 33, 17, 0)), allDay: false },
        place: { label: '地點', value: '城市創意基地 2F 黑盒子劇場' },
        bring: '所有展演用的器材與延長線',
      },
      channels: ['ch_show'],
      rules: ['d3@20:00', 'd1@20:00', 'm60'],
      source: '期末展演彩排',
      createdAgo: 4 * DAY,
    },
  ];

  const posts: Post[] = [];
  for (const item of items) {
    const seriesId = newId('s');
    // plan as if from the start of time, so nothing counts as "already past"
    const { posts: planned } = plan({ content: item.content, kind: kindStyle(config, item.content.kind), rules: item.rules, repeat: item.repeat ?? null, now: 0, tz: TZ, semesterStart: config.semesterStart });
    const created = Math.min(now - item.createdAgo, (planned[0]?.at ?? now) - 30 * MINUTE);
    planned.forEach((pl, i) => {
      let p = makePost(
        {
          content: pl.content,
          style: item.style ?? 'embed',
          mention: item.mention ?? { type: 'none' },
          channels: item.channels,
          at: pl.at,
          rule: pl.rule,
          label: pl.label,
          series: planned.length > 1 ? { id: seriesId, index: i + 1, total: planned.length } : null,
          source: item.source,
        },
        config,
        created,
      );
      if (pl.at <= now) p = sentAs(p, config, pl.at + 20_000 + ((i * 7919) % 40_000));
      posts.push(p);
    });
  }

  // the Office Hour notice went to a channel whose webhook was deleted
  const oh = posts.find((p) => p.content.title === '本週 Office Hour 時段調整');
  if (oh) {
    const stamp = oh.sentAt!;
    oh.status = 'failed';
    oh.sentAt = null;
    oh.deliveries = [{ channel: 'ch_oh', status: 'failed', error: 'Webhook 已被刪除或網址錯誤，請到頻道設定重新貼上 Webhook（Discord 10015）', at: stamp }];
    oh.log = [oh.log[0], { at: stamp, text: '#office-hour 發送失敗：Webhook 已被刪除或網址錯誤（Discord 10015）', tone: 'error' }];
  }

  // something retracted, and a draft
  const lecture = posts.find((p) => p.content.kind === 'material');
  if (lecture) {
    const extra = makePost(
      {
        content: { ...emptyContent('notice'), title: '（誤發）第 6 週講義連結', body: '連結貼錯了，請以下一則為準。' },
        style: 'text',
        mention: { type: 'none' },
        channels: ['ch_news'],
        at: Date.parse(lecture.at!) - 10 * MINUTE,
        rule: null,
        label: null,
        series: null,
        source: '',
      },
      config,
      Date.parse(lecture.at!) - 12 * MINUTE,
    );
    let r = sentAs(extra, config, Date.parse(lecture.at!) - 9 * MINUTE);
    r = { ...r, status: 'retracted', deliveries: r.deliveries.map((d) => ({ ...d, status: 'deleted' as const })) };
    posts.push(addLog(r, '已從 Discord 撤回', at(Date.parse(lecture.at!) - 5 * MINUTE), 'ok'));
  }
  posts.push(
    makePost(
      {
        content: {
          ...emptyContent('homework'),
          title: '填寫期末分組與題目表單',
          body: '請各組組長填寫，一組填一次即可。',
          when: { at: at(dayAt(today, 11, 23, 59)), end: null, allDay: false },
          links: [{ url: 'https://forms.gle/demo-final-groups', label: 'Google 表單' }],
        },
        style: 'embed',
        mention: { type: 'none' },
        channels: ['ch_news'],
        at: null,
        rule: null,
        label: null,
        series: null,
        source: '請各組在 ' + fmt(dayAt(today, 11, 0, 0)) + ' 前填寫期末分組表單 https://forms.gle/demo-final-groups',
      },
      config,
      now - 40 * MINUTE,
    ),
  );
  return { version: 1, posts };
}

function sentAs(p: Post, config: Config, when: number): Post {
  const stamp = at(when);
  let n = 0;
  const sent: Post = {
    ...p,
    status: 'sent',
    sentAt: stamp,
    updatedAt: stamp,
    deliveries: p.channels.map((c) => ({
      channel: c,
      status: 'sent' as const,
      messageId: String(1300000000000000000n + BigInt(Math.floor(when / 1000)) * 1000n + BigInt(++n)),
      discordChannel: '1290000000000000000',
      guild: '1280000000000000000',
      at: stamp,
    })),
  };
  return p.channels.reduce((acc, c) => addLog(acc, `已送到 #${config.channels.find((x) => x.id === c)?.name ?? c}`, stamp, 'ok'), sent);
}

function fmt(ms: number): string {
  const w = wall(ms, TZ);
  return `${w.m}/${w.d}`;
}

/** The last day of class: 18 weeks after the semester starts. */
function semesterEnd(config: Config, fallbackMonday: number): string {
  const s = config.semesterStart ? Date.parse(`${config.semesterStart}T12:00:00+08:00`) : fallbackMonday;
  return isoLocal(addDays(s, 18 * 7 - 1, TZ), TZ).slice(0, 10);
}
