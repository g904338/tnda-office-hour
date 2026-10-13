import { addMinutes, instant } from './time';

export interface CalEvent {
  uid: string;
  d: string;
  t: string;
  minutes: number;
  tz: string;
  title: string;
  location?: string;
  description?: string;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

/** RFC 5545 lines are folded at 75 octets. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > 74) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function icsText(events: CalEvent[], calName = 'Office Hour'): string {
  const now = stamp(Date.now());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tnda-office-hour//zh-TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calName)}`];
  for (const e of events) {
    const start = instant(e.d, e.t, e.tz);
    const end = instant(e.d, addMinutes(e.t, e.minutes), e.tz);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(e.title)}`,
      ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      `DESCRIPTION:${esc(e.title)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadIcs(name: string, events: CalEvent[], calName?: string) {
  download(name, icsText(events, calName), 'text/calendar;charset=utf-8');
}

/** CSV with a BOM so Excel opens Chinese text correctly. */
export function csvText(rows: Array<Record<string, unknown>>, columns: Array<[string, string]>): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    // neutralise spreadsheet formulas
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = columns.map(([, label]) => cell(label)).join(',');
  const body = rows.map((r) => columns.map(([k]) => cell(r[k])).join(','));
  return '\ufeff' + [head, ...body].join('\r\n') + '\r\n';
}
