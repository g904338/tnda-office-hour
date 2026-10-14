// Discord-flavoured Markdown to HTML, for the live preview. Everything is
// escaped first; only the markup below is turned back into elements, and
// links only ever point at http(s) URLs.

import { discordTimestamp } from './time';

export interface MarkdownOptions {
  tz: string;
  now: number;
  /** names to show for <@&role> and <#channel> mentions */
  roles?: Record<string, string>;
  /** allow # headings and -# subtext (message content, not embed fields) */
  blocks?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Undo the escaping of a URL so it can be validated, then escape it for an attribute. */
function safeUrl(escaped: string): string | null {
  const raw = escaped.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(raw)) return null;
  return esc(raw);
}

function inline(src: string, opts: MarkdownOptions): string {
  // src is already HTML-escaped
  const keep: string[] = [];
  const hold = (html: string) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = src;

  // code spans first: nothing inside them is formatted
  s = s.replace(/``([^`]+?)``|`([^`\n]+?)`/g, (_, a, b) => hold(`<code>${a ?? b}</code>`));

  // masked links [label](url) and [label](<url>)
  s = s.replace(/\[([^\]\n]{1,200}?)\]\((?:&lt;)?(https?:\/\/[^\s)]+?)(?:&gt;)?\)/g, (all, label, url) => {
    const u = safeUrl(url);
    if (!u) return all;
    return hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${label.replace(/\\([[\]])/g, '$1')}</a>`);
  });
  // <https://…> (a link without a preview) and bare URLs
  s = s.replace(/&lt;(https?:\/\/[^\s]+?)&gt;/g, (all, url) => {
    const u = safeUrl(url);
    return u ? hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${url}</a>`) : all;
  });
  s = s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => {
    const u = safeUrl(url);
    return u ? hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${url}</a>`) : url;
  });

  // timestamps <t:1760000000:F>
  s = s.replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (_, n, style) =>
    hold(`<span class="dc-ts">${esc(discordTimestamp(Number(n), style ?? 'f', opts.tz, opts.now))}</span>`),
  );
  // mentions
  s = s.replace(/@(everyone|here)\b/g, (_, w) => hold(`<span class="dc-mention">@${w}</span>`));
  s = s.replace(/&lt;@&amp;(\d{15,22})&gt;/g, (_, id) => hold(`<span class="dc-mention">@${esc(opts.roles?.[id] ?? '身分組')}</span>`));
  s = s.replace(/&lt;#(\d{15,22})&gt;/g, (_, id) => hold(`<span class="dc-mention">#${esc(opts.roles?.[id] ?? '頻道')}</span>`));
  s = s.replace(/&lt;@!?(\d{15,22})&gt;/g, () => hold(`<span class="dc-mention">@成員</span>`));
  // custom emoji <:name:id>
  s = s.replace(/&lt;(a?):(\w{2,32}):(\d{15,22})&gt;/g, (_, a, name, id) =>
    hold(`<img class="dc-emoji" alt=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${a ? 'gif' : 'webp'}?size=48" />`),
  );

  // emphasis, innermost rules last
  s = s.replace(/\|\|(.+?)\|\|/g, '<span class="dc-spoiler">$1</span>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // (no lookbehind: older Safari would refuse to load the whole app)
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?!\s)([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  // \* escapes
  s = s.replace(/\\([*_~|`>#-])/g, '$1');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

export function renderMarkdown(text: string, opts: MarkdownOptions): string {
  const lines = esc(text.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] | null = null;
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote) out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
    quote = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ```code blocks```
    const fence = /^```(\w*)\s*$/.exec(line) ?? /^```(.*)$/.exec(line);
    if (fence) {
      flushList();
      flushQuote();
      const body: string[] = [];
      const inlineEnd = /^```(.*?)```\s*$/.exec(line);
      if (inlineEnd) {
        out.push(`<pre><code>${inlineEnd[1]}</code></pre>`);
        continue;
      }
      if (fence[1] && !/^\w*$/.test(fence[1])) body.push(fence[1]);
      let j = i + 1;
      while (j < lines.length && !/```\s*$/.test(lines[j])) body.push(lines[j++]);
      if (j < lines.length) body.push(lines[j].replace(/```\s*$/, ''));
      out.push(`<pre><code>${body.join('\n').replace(/\n$/, '')}</code></pre>`);
      i = j;
      continue;
    }
    // >>> quotes the rest of the message
    const big = /^&gt;&gt;&gt;\s(.*)$/.exec(line);
    if (big) {
      flushList();
      flushQuote();
      out.push(`<blockquote>${[big[1], ...lines.slice(i + 1)].map((l) => inline(l, opts)).join('<br>')}</blockquote>`);
      break;
    }
    const q = /^&gt;\s(.*)$/.exec(line) ?? (/^&gt;$/.test(line) ? ['', ''] : null);
    if (q) {
      flushList();
      (quote ??= []).push(inline(q[1], opts));
      continue;
    }
    flushQuote();
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    const oli = /^\s*\d{1,3}\.\s+(.*)$/.exec(line);
    if ((li && !/^-#\s/.test(line.trim())) || oli) {
      const type = oli ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      (list ??= { type, items: [] }).items.push(inline((li ?? oli)![1], opts));
      continue;
    }
    flushList();
    if (opts.blocks !== false) {
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        out.push(`<div class="dc-h${h[1].length}">${inline(h[2], opts)}</div>`);
        continue;
      }
      const sub = /^-#\s+(.*)$/.exec(line);
      if (sub) {
        out.push(`<div class="dc-sub">${inline(sub[1], opts)}</div>`);
        continue;
      }
    }
    out.push(line.trim() ? `<div class="dc-line">${inline(line, opts)}</div>` : '<div class="dc-gap"></div>');
  }
  flushList();
  flushQuote();
  return out.join('');
}
