// Example announcements, written relative to today so their dates and
// weekdays are always right (the parser flags mismatched weekdays).

import { DOW_ZH, wall, zoned } from '../core/time';

export interface Sample {
  id: string;
  label: string;
  text: string;
}

export function samples(now: number, tz: string): Sample[] {
  const w = wall(now, tz);
  const day = (offset: number) => {
    const x = wall(zoned(w.y, w.m, w.d + offset, 12, 0, tz), tz);
    return `${x.m}/${x.d}（${DOW_ZH[x.dow]}）`;
  };
  // the next weekday `dow` at least `min` days away
  const next = (dow: number, min = 1) => {
    let off = min;
    while (wall(zoned(w.y, w.m, w.d + off, 12, 0, tz), tz).dow !== dow) off++;
    return off;
  };
  const tue = next(2);
  const fri = next(5, 3);
  const exam = next(3, 9);
  const show = next(6, 20);
  return [
    {
      id: 'homework',
      label: '作業',
      text: `作業三：互動原型\n繳交期限：${day(fri)} 23:59\n上傳到 Moodle 作業區，檔名格式：組別_作業三.pdf\n作業說明：https://moodle.example.edu/mod/assign/view.php?id=2003\n遲交一天扣 10 分`,
    },
    {
      id: 'class',
      label: '上課',
      text: `${day(tue)}下午 2:10 上課，地點改到設計學院 B1 創意基地\n請各組帶筆電和上週的訪談紀錄\n簡報：https://docs.google.com/presentation/d/demo`,
    },
    {
      id: 'exam',
      label: '考試',
      text: `【期中筆試】\n${day(exam)} 早上 9:10–11:00，地點：設計學院 3F 301 教室\n範圍是第 1–8 週的課堂內容\n- 題型：簡答與情境題\n- 可以帶一張 A4 手寫小抄\n記得帶學生證`,
    },
    {
      id: 'event',
      label: '活動',
      text: `@everyone ${day(show)} 13:00-17:00 期末展演彩排，在城市創意基地 2F 黑盒子劇場\n各組 15 分鐘走位與技術測試，請帶所有展演用的器材`,
    },
    {
      id: 'notice',
      label: '公告',
      text: `下週二停課一次，補課時間另行通知\n這週的 Office Hour 照常`,
    },
  ];
}
