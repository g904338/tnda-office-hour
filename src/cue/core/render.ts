// Dresses content up as a Discord message. Two looks: an embed card (a
// coloured bar, fields, the time as a live countdown) or plain Markdown
// that also works when pasted into Discord by hand.

import { hexToInt, kindStyle, LIMITS, type Config, type Content, type DiscordEmbed, type DiscordPayload, type Mention, type PostStyle } from './model';
import { DAY, wall } from './time';

export interface RenderInput {
  content: Content;
  style: PostStyle;
  mention: Mention;
  config: Pick<Config, 'timezone' | 'footer' | 'course' | 'username' | 'avatar' | 'kinds'>;
  /** a reminder's label, e.g. 明天截止 */
  label?: string | null;
}

export function mentionText(m: Mention): string {
  if (m.type === 'everyone') return '@everyone';
  if (m.type === 'here') return '@here';
  if (m.type === 'role' && /^\d{15,22}$/.test(m.id)) return `<@&${m.id}>`;
  return '';
}

export function allowedMentions(m: Mention): DiscordPayload['allowed_mentions'] {
  if (m.type === 'everyone' || m.type === 'here') return { parse: ['everyone'] };
  if (m.type === 'role' && /^\d{15,22}$/.test(m.id)) return { parse: [], roles: [m.id] };
  // nothing typed into a post may ping anyone by accident
  return { parse: [] };
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The time field's value: a date, or a date-time with a live countdown. */
export function whenValue(when: NonNullable<Content['when']>, tz: string, layout: 'embed' | 'text'): string {
  const a = unix(when.at);
  if (when.allDay) return `<t:${a}:D>`;
  let range = `<t:${a}:F>`;
  if (when.end) {
    const e = unix(when.end);
    const sameDay = wall(a * 1000, tz).d === wall(e * 1000, tz).d && e - a < DAY / 1000;
    range += ` – <t:${e}:${sameDay ? 't' : 'f'}>`;
  }
  return layout === 'embed' ? `${range}\n<t:${a}:R>` : `${range}（<t:${a}:R>）`;
}

function escapeLinkText(s: string): string {
  return s.replace(/([[\]])/g, '\\$1');
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function footerText(config: RenderInput['config']): string {
  return (config.footer || config.course || '').trim();
}

function descriptionOf(c: Content): string {
  const parts: string[] = [];
  if (c.body.trim()) parts.push(c.body.trim());
  if (c.bullets.length) parts.push(c.bullets.map((b) => `- ${b}`).join('\n'));
  if (c.notes.length) parts.push(c.notes.map((n) => `> ⚠️ ${n}`).join('\n'));
  return parts.join('\n\n');
}

export function renderPayload(input: RenderInput): DiscordPayload {
  const { content: c, config, mention, label } = input;
  const k = kindStyle(config, c.kind);
  const tz = config.timezone;
  const ping = mentionText(mention);
  const footer = footerText(config);
  const base: DiscordPayload = { allowed_mentions: allowedMentions(mention) };
  if (config.username.trim()) base.username = clip(config.username.trim(), LIMITS.username);
  if (/^https:\/\//.test(config.avatar)) base.avatar_url = config.avatar;
  const headline = `${k.emoji} ${k.headline}${label ? ` · ${label}` : ''}`;

  if (input.style === 'embed') {
    const fields: NonNullable<DiscordEmbed['fields']> = [];
    if (c.when) fields.push({ name: `⏰ ${k.whenLabel}`, value: whenValue(c.when, tz, 'embed'), inline: true });
    if (c.place?.value.trim()) fields.push({ name: c.place.label === '繳交' ? '📤 繳交' : '📍 地點', value: clip(c.place.value.trim(), LIMITS.fieldValue), inline: true });
    if (c.bring.trim()) fields.push({ name: '🎒 攜帶', value: clip(c.bring.trim(), LIMITS.fieldValue), inline: true });
    if (c.links.length) {
      fields.push({
        name: '🔗 連結',
        value: clip(c.links.map((l) => `[${escapeLinkText(l.label || '連結')}](${l.url})`).join('\n'), LIMITS.fieldValue),
        inline: false,
      });
    }
    const embed: DiscordEmbed = {
      author: { name: clip(headline, LIMITS.author) },
      title: clip(c.title.trim() || k.headline, LIMITS.title),
      color: hexToInt(k.color),
    };
    const description = descriptionOf(c);
    if (description) embed.description = clip(description, LIMITS.description);
    if (fields.length) embed.fields = fields;
    if (/^https:\/\//.test(c.image)) embed.image = { url: c.image };
    if (footer) embed.footer = { text: clip(footer, LIMITS.footer) };
    return { ...base, ...(ping ? { content: ping } : {}), embeds: [embed] };
  }

  const lines: string[] = [];
  if (ping) lines.push(ping);
  lines.push(`-# ${headline}`);
  lines.push(`## ${c.title.trim() || k.headline}`);
  const facts: string[] = [];
  if (c.when) facts.push(`⏰ **${k.whenLabel}**　${whenValue(c.when, tz, 'text')}`);
  if (c.place?.value.trim()) facts.push(`${c.place.label === '繳交' ? '📤 **繳交**' : '📍 **地點**'}　${c.place.value.trim()}`);
  if (c.bring.trim()) facts.push(`🎒 **攜帶**　${c.bring.trim()}`);
  if (facts.length) lines.push(facts.join('\n'));
  const description = descriptionOf(c);
  if (description) lines.push('', description);
  if (c.links.length) lines.push('', c.links.map((l) => `🔗 [${escapeLinkText(l.label || '連結')}](<${l.url}>)`).join('\n'));
  if (c.image && /^https:\/\//.test(c.image)) lines.push(c.image);
  if (footer) lines.push('', `-# ${footer}`);
  return { ...base, content: lines.join('\n').replace(/\n{3,}/g, '\n\n') };
}

/** The text a person can paste into Discord by hand (always Markdown). */
export function plainText(input: RenderInput): string {
  return renderPayload({ ...input, style: 'text' }).content ?? '';
}

export interface Problem {
  level: 'error' | 'warn';
  text: string;
}

/** Things Discord would reject, and things worth a second look. */
export function checkPayload(p: DiscordPayload): Problem[] {
  const out: Problem[] = [];
  const content = p.content ?? '';
  if (content.length > LIMITS.content) out.push({ level: 'error', text: `訊息有 ${content.length} 字，超過 Discord 的 ${LIMITS.content} 字上限。` });
  let total = 0;
  for (const e of p.embeds ?? []) {
    const len =
      (e.title?.length ?? 0) +
      (e.description?.length ?? 0) +
      (e.author?.name.length ?? 0) +
      (e.footer?.text.length ?? 0) +
      (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    total += len;
    if ((e.description?.length ?? 0) >= LIMITS.description) out.push({ level: 'warn', text: '內文太長，已截斷在 4096 字。' });
  }
  if (total > LIMITS.embedTotal) out.push({ level: 'error', text: `卡片總字數 ${total}，超過 Discord 的 ${LIMITS.embedTotal} 字上限。` });
  if (!content.trim() && !(p.embeds ?? []).length) out.push({ level: 'error', text: '訊息是空的。' });
  return out;
}
