// What the message will look like in Discord: the same layout, colours and
// Markdown rules, timestamps shown the way a zh-TW Discord client shows
// them. Rendered from the exact payload the scheduler will send.

import { useMemo } from 'preact/hooks';
import type { Channel, Config, DiscordEmbed, DiscordPayload } from '../core/model';
import { renderMarkdown } from '../core/markdown';
import { calendarDays, fmtTime, wall } from '../core/time';
import { CueMark } from './parts';

export type PreviewTheme = 'dark' | 'light';

function md(text: string, tz: string, now: number, blocks = true) {
  return { __html: renderMarkdown(text, { tz, now, blocks }) };
}

function stamp(at: number, now: number, tz: string): string {
  const d = calendarDays(now, at, tz);
  if (d === 0) return `今天 ${fmtTime(at, tz)}`;
  if (d === -1) return `昨天 ${fmtTime(at, tz)}`;
  if (d === 1) return `明天 ${fmtTime(at, tz)}`;
  const w = wall(at, tz);
  return `${w.y}/${w.m}/${w.d} ${fmtTime(at, tz)}`;
}

/** Discord's rows: up to three inline fields share a row; others take the whole row. */
function fieldLayout(fields: NonNullable<DiscordEmbed['fields']>): string[] {
  const cols: string[] = [];
  let i = 0;
  while (i < fields.length) {
    if (!fields[i].inline) {
      cols.push('1 / 13');
      i++;
      continue;
    }
    let n = 0;
    while (i + n < fields.length && fields[i + n].inline && n < 3) n++;
    const span = 12 / n;
    for (let k = 0; k < n; k++) cols.push(`${1 + k * span} / ${1 + (k + 1) * span}`);
    i += n;
  }
  return cols;
}

function Embed({ e, tz, now }: { e: DiscordEmbed; tz: string; now: number }) {
  const color = e.color !== undefined ? `#${e.color.toString(16).padStart(6, '0')}` : 'var(--dc-embed-bar)';
  const cols = e.fields ? fieldLayout(e.fields) : [];
  return (
    <div class="dc-embed" style={{ '--bar': color } as any}>
      {e.author && <div class="dc-author" dangerouslySetInnerHTML={md(e.author.name, tz, now, false)} />}
      {e.title &&
        (e.url ? (
          <a class="dc-title" href={e.url} target="_blank" rel="noopener noreferrer" dangerouslySetInnerHTML={md(e.title, tz, now, false)} />
        ) : (
          <div class="dc-title" dangerouslySetInnerHTML={md(e.title, tz, now, false)} />
        ))}
      {e.description && <div class="dc-desc" dangerouslySetInnerHTML={md(e.description, tz, now)} />}
      {e.fields && e.fields.length > 0 && (
        <div class="dc-fields">
          {e.fields.map((f, i) => (
            <div class="dc-field" key={i} style={{ gridColumn: cols[i] }}>
              <div class="dc-fname" dangerouslySetInnerHTML={md(f.name, tz, now, false)} />
              <div class="dc-fvalue" dangerouslySetInnerHTML={md(f.value, tz, now, false)} />
            </div>
          ))}
        </div>
      )}
      {e.image && <img class="dc-image" src={e.image.url} alt="" loading="lazy" referrerpolicy="no-referrer" />}
      {e.footer && <div class="dc-footer">{e.footer.text}</div>}
    </div>
  );
}

export function DiscordPreview({
  payload,
  config,
  channel,
  theme = 'dark',
  at,
  now = Date.now(),
  compact,
}: {
  payload: DiscordPayload;
  config: Config;
  channel?: Channel;
  theme?: PreviewTheme;
  /** when the message is (or was) posted */
  at?: number;
  now?: number;
  compact?: boolean;
}) {
  const tz = config.timezone;
  const name = (channel?.username || payload.username || config.username || 'Cue').trim();
  const avatar = channel?.avatar || payload.avatar_url || config.avatar;
  const content = payload.content ?? '';
  const html = useMemo(() => (content ? renderMarkdown(content, { tz, now }) : ''), [content, tz, now]);
  return (
    <figure class={`dc dc-${theme} ${compact ? 'dc-compact' : ''}`} aria-label={`Discord 預覽：${payload.embeds?.[0]?.title ?? content.slice(0, 40)}`}>
      {!compact && (
        <div class="dc-head">
          <span class="dc-hash" aria-hidden="true">
            #
          </span>
          <span>{channel ? `${channel.emoji} ${channel.name}` : '頻道'}</span>
        </div>
      )}
      <div class="dc-msg">
        <div class="dc-avatar">{/^https:\/\//.test(avatar) ? <img src={avatar} alt="" referrerpolicy="no-referrer" /> : <CueMark size={40} />}</div>
        <div class="dc-body">
          <div class="dc-meta">
            <span class="dc-name">{name}</span>
            <span class="dc-app">APP</span>
            <span class="dc-time">{stamp(at ?? now, now, tz)}</span>
          </div>
          {html && <div class="dc-content" dangerouslySetInnerHTML={{ __html: html }} />}
          {(payload.embeds ?? []).map((e, i) => (
            <Embed key={i} e={e} tz={tz} now={now} />
          ))}
        </div>
      </div>
    </figure>
  );
}
