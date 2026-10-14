// Paste → Cue organises it → adjust anything → pick channels and when →
// the preview shows exactly what each post will look like in Discord.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { go, href } from '../../app/router';
import { local } from '../../app/store';
import { Icon } from '../../ui/icons';
import { Btn, Field, Seg, Switch } from '../../ui/base';
import { toast } from '../../ui/toast';
import { kick, save } from '../app/state';
import { effectiveTheme, theme } from '../app/theme';
import { KIND_ORDER, kindStyle, LIMITS, newId, type Channel, type Config, type Content, type KindKey, type Link, type Mention, type Post, type PostStyle } from '../core/model';
import { addPosts, isEditable, makePost, mapPost, rerender, schedule as toSchedule, unschedule, labelOf } from '../core/ops';
import { parse, type ParseResult } from '../core/parse';
import { checkPayload, plainText, renderPayload } from '../core/render';
import { isQuietHour, plan, RULES, ruleLabel, ruleTime, type Repeat } from '../core/schedule';
import { DAY, dayKey, fmtDateTime, fromInputValue, isoLocal, toInputValue, wall, zoned } from '../core/time';
import { DiscordPreview, type PreviewTheme } from '../ui/DiscordPreview';
import { copyText } from '../../ui/base';
import { samples } from '../ui/samples';
import { useData, useNow } from '../ui/parts';
import { pushEdit } from './actions';
import { pendingDay, pendingText } from './bridge';

const KIND_CHANNEL_HINT: Record<KindKey, RegExp> = {
  class: /上課|課程|class|lecture/i,
  homework: /作業|繳交|hw|homework|assignment/i,
  exam: /考試|測驗|exam|公告|announce/i,
  event: /活動|展演|event|show/i,
  material: /講義|教材|資源|material|公告/i,
  notice: /公告|通知|announce|news|general/i,
};

function defaultChannels(kind: KindKey, channels: Channel[]): string[] {
  const remembered = local.get<string[]>(`cue:channels:${kind}`)?.filter((id) => channels.some((c) => c.id === id));
  if (remembered?.length) return remembered;
  const hit = channels.find((c) => KIND_CHANNEL_HINT[kind].test(`${c.name} ${c.note}`));
  return hit ? [hit.id] : channels[0] ? [channels[0].id] : [];
}

function defaultMention(channels: string[], all: Channel[]): Mention {
  const c = all.find((x) => x.id === channels[0]);
  return c?.mention ?? { type: 'none' };
}

interface Draft {
  source: string;
  content: Content;
  style: PostStyle;
  mention: Mention;
  channels: string[];
  rules: string[];
  repeat: Repeat | null;
  /** for an existing post: its single send time (null = draft) */
  at: number | null;
}

// ---------------------------------------------------------------------------
// small editors

function ListEditor({ label, items, onChange, placeholder, add }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string; add: string }) {
  return (
    <div class="field">
      <span class="label">
        <span>{label}</span>
      </span>
      <div class="list-edit">
        {items.map((v, i) => (
          <div class="row" key={i} style={{ gap: '6px' }}>
            <input
              class="input sm grow"
              value={v}
              aria-label={`${label} ${i + 1}`}
              onInput={(e) => onChange(items.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))}
            />
            <Btn size="sm" variant="ghost" icon="x" aria-label={`移除${label} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))} />
          </div>
        ))}
        <button type="button" class="add-row" onClick={() => onChange([...items, ''])}>
          <Icon name="plus" size={15} />
          {items.length ? add : placeholder}
        </button>
      </div>
    </div>
  );
}

function LinksEditor({ links, onChange }: { links: Link[]; onChange: (v: Link[]) => void }) {
  return (
    <div class="field">
      <span class="label">
        <span>連結</span>
      </span>
      <div class="list-edit">
        {links.map((l, i) => (
          <div class="link-edit" key={i}>
            <input class="input sm" value={l.label} placeholder="名稱" aria-label={`連結 ${i + 1} 名稱`} onInput={(e) => onChange(links.map((x, j) => (j === i ? { ...x, label: (e.target as HTMLInputElement).value } : x)))} />
            <input
              class="input sm mono"
              value={l.url}
              placeholder="https://…"
              aria-label={`連結 ${i + 1} 網址`}
              onInput={(e) => onChange(links.map((x, j) => (j === i ? { ...x, url: (e.target as HTMLInputElement).value.trim() } : x)))}
            />
            <Btn size="sm" variant="ghost" icon="x" aria-label={`移除連結 ${i + 1}`} onClick={() => onChange(links.filter((_, j) => j !== i))} />
          </div>
        ))}
        <button type="button" class="add-row" onClick={() => onChange([...links, { label: '', url: '' }])}>
          <Icon name="plus" size={15} />
          新增連結
        </button>
      </div>
    </div>
  );
}

function Step({ n, title, children, aside }: { n: number; title: string; children: ComponentChildren; aside?: ComponentChildren }) {
  return (
    <section class="card step">
      <header class="step-head">
        <span class="step-n" aria-hidden="true">
          {n}
        </span>
        <h2 class="title-s grow">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function ComposePage({ postId }: { postId: string | null }) {
  const { config, posts, backend } = useData();
  const tz = config.timezone;
  const now = useNow(30000);
  const existing = postId ? posts.find((p) => p.id === postId) ?? null : null;
  const sentAlready = Boolean(existing && existing.deliveries.some((d) => d.status === 'sent'));
  const editingSent = Boolean(existing && !isEditable(existing) && sentAlready);
  const examples = useMemo(() => samples(now, tz), []);

  const [draft, setDraft] = useState<Draft>(() => {
    if (existing) {
      return {
        source: existing.source,
        content: existing.content,
        style: existing.style,
        mention: existing.mention,
        channels: existing.channels,
        rules: [],
        repeat: null,
        at: existing.at ? Date.parse(existing.at) : null,
      };
    }
    const text = pendingText.get() ?? '';
    pendingText.set(null);
    const day = pendingDay.get();
    pendingDay.set(null);
    const base: Draft = {
      source: text,
      content: { kind: 'notice', title: '', body: '', when: null, place: null, bring: '', links: [], bullets: [], notes: [], image: '' },
      style: 'embed',
      mention: { type: 'none' },
      channels: defaultChannels('notice', config.channels),
      rules: ['now'],
      repeat: null,
      at: null,
    };
    if (day) {
      const [y, m, d] = day.split('-').map(Number);
      base.rules = [`at:${isoLocal(zoned(y, m, d, 20, 0, tz), tz)}`];
    }
    return text ? fromParse(base, parse(text, { now: Date.now(), tz, semesterStart: config.semesterStart }), config) : base;
  });
  const [parsed, setParsed] = useState<ParseResult | null>(() =>
    draft.source && !existing ? parse(draft.source, { now: Date.now(), tz, semesterStart: config.semesterStart }) : null,
  );
  // fields the person changed by hand are not overwritten by re-parsing
  const [touched, setTouched] = useState<Set<string>>(() => new Set(existing ? ['all'] : []));
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(0);
  const t = theme.use();
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>(effectiveTheme(t));
  const [more, setMore] = useState(false);
  const [customAt, setCustomAt] = useState(() => toInputValue(Date.now() + 2 * 3600_000 - ((Date.now() + 2 * 3600_000) % (30 * 60_000)), tz));
  const parseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!existing && !draft.source) sourceRef.current?.focus();
  }, []);

  function fromParse(d: Draft, r: ParseResult, cfg: Config, keep: Set<string> = new Set()): Draft {
    const c = r.content;
    const content: Content = { ...d.content };
    for (const key of Object.keys(c) as Array<keyof Content>) if (!keep.has(key)) (content as any)[key] = c[key];
    const kind = content.kind;
    const channels = keep.has('channels') ? d.channels : defaultChannels(kind, cfg.channels);
    let rules = keep.has('rules') ? d.rules : content.when ? kindStyle(cfg, kind).reminders : ['now'];
    // reminders that would all be in the past: announce it now instead
    if (!keep.has('rules') && rules[0] !== 'now') {
      const now = Date.now();
      const left = plan({ content, kind: kindStyle(cfg, kind), rules, repeat: d.repeat, now, tz: cfg.timezone, semesterStart: cfg.semesterStart }).posts;
      if (!left.length) rules = ['now'];
    }
    const mention = keep.has('mention') ? d.mention : (r.mention ?? defaultMention(channels, cfg.channels));
    return { ...d, content, channels, rules, mention };
  }

  // the latest values, for timers and for submitting right after typing
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const touchedRef = useRef(touched);
  touchedRef.current = touched;

  /** Organises `text` now and returns the draft that results. */
  function applyParse(text: string): Draft {
    const r = parse(text, { now: Date.now(), tz, semesterStart: config.semesterStart });
    setParsed(r);
    const base = { ...draftRef.current, source: text };
    if (touchedRef.current.has('all')) {
      setStale(true);
      return base;
    }
    const next = fromParse(base, r, config, touchedRef.current);
    draftRef.current = next;
    setDraft(next);
    setTab(0);
    return next;
  }

  function onSource(text: string) {
    setDraft((d) => ({ ...d, source: text }));
    draftRef.current = { ...draftRef.current, source: text };
    clearTimeout(parseTimer.current);
    parseTimer.current = setTimeout(() => {
      parseTimer.current = undefined;
      applyParse(text);
    }, 220);
  }

  /** A paste that has not been organised yet is organised before saving. */
  function flush(): Draft {
    if (parseTimer.current === undefined) return draftRef.current;
    clearTimeout(parseTimer.current);
    parseTimer.current = undefined;
    return applyParse(draftRef.current.source);
  }

  function reparse() {
    const r = parse(draft.source, { now: Date.now(), tz, semesterStart: config.semesterStart });
    setParsed(r);
    setTouched(new Set());
    setStale(false);
    setDraft((d) => fromParse(d, r, config));
    toast('已依照原文重新整理');
  }

  const setContent = (patch: Partial<Content>) => {
    setTouched((s) => new Set([...s, ...Object.keys(patch)]));
    setDraft((d) => ({ ...d, content: { ...d.content, ...patch } }));
  };
  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setTouched((s) => new Set([...s, key as string]));
    setDraft((d) => ({ ...d, [key]: value }));
  };

  // ---- the posts this will create
  const kind = kindStyle(config, draft.content.kind);
  const planned = useMemo(() => {
    if (existing) {
      const label = labelOf(existing);
      return { posts: [{ at: draft.at ?? now, rule: existing.rule ?? 'at', label, content: draft.content, occurrence: 1 }], skipped: [] };
    }
    return plan({ content: draft.content, kind, rules: draft.rules, repeat: draft.repeat, now, tz, semesterStart: config.semesterStart });
  }, [draft, now, existing?.id]);
  const shown = planned.posts[Math.min(tab, Math.max(0, planned.posts.length - 1))];
  const payload = useMemo(
    () => renderPayload({ content: shown?.content ?? draft.content, style: draft.style, mention: draft.mention, config, label: shown?.label ?? null }),
    [shown, draft.style, draft.mention, config],
  );
  const channel = config.channels.find((c) => c.id === draft.channels[0]);

  // ---- things worth a look before scheduling
  const problems = checkPayload(payload).map((p) => ({ ...p }));
  const notes: Array<{ level: 'error' | 'warn' | 'info'; text: string }> = [...problems];
  if (parsed) for (const w of parsed.warnings) notes.push({ level: 'warn', text: w });
  if (!draft.channels.length) notes.push({ level: 'error', text: '還沒有選擇要發到哪個頻道。' });
  for (const id of draft.channels) {
    const c = config.channels.find((x) => x.id === id);
    if (c && !c.webhookSavedAt) notes.push({ level: 'warn', text: `#${c.name} 還沒有設定 Webhook，到時候會發送失敗。` });
  }
  if (!editingSent && planned.posts.some((p) => p.rule !== 'now' && isQuietHour(p.at, tz))) notes.push({ level: 'warn', text: '有一則會在深夜到清晨之間發送，確定嗎？' });
  if (parsed?.guessed.time && draft.content.when && !touched.has('when'))
    notes.push({ level: 'info', text: `原文沒有寫幾點，先用 ${kind.key === 'homework' || parsed.primary?.role === 'deadline' ? '當天 23:59' : '整天'}，可以在下面修改。` });
  if (draft.mention.type === 'everyone' || draft.mention.type === 'here') notes.push({ level: 'info', text: `會標註 ${draft.mention.type === 'everyone' ? '@everyone，頻道裡的每個人' : '@here，目前在線上的人'}都會收到通知。` });
  const blocking = notes.some((n) => n.level === 'error');

  // ---- saving
  async function create(asDraft: boolean) {
    if (busy) return;
    const draft = flush();
    const nowMs = Date.now();
    const planned = existing
      ? { posts: [] as ReturnType<typeof plan>['posts'] }
      : plan({ content: draft.content, kind: kindStyle(config, draft.content.kind), rules: draft.rules, repeat: draft.repeat, now: nowMs, tz, semesterStart: config.semesterStart });
    if (!asDraft) {
      const first = planned.posts[0];
      const problem = !draft.channels.length && !editingSent
        ? '還沒有選擇要發到哪個頻道。'
        : checkPayload(renderPayload({ content: first?.content ?? draft.content, style: draft.style, mention: draft.mention, config, label: first?.label ?? null })).find((x) => x.level === 'error')?.text;
      if (problem) {
        toast(problem, { kind: 'error' });
        return;
      }
      if (!existing && !planned.posts.length) {
        toast('選擇的時間都已經過了，請挑別的時間。', { kind: 'error' });
        return;
      }
    }
    setBusy(true);
    local.set(`cue:channels:${draft.content.kind}`, draft.channels);
    try {
      if (existing) {
        if (editingSent) {
          const next: Post = rerender({ ...existing, content: draft.content, style: draft.style, mention: draft.mention }, config);
          if (await pushEdit(next)) go('posts');
          return;
        }
        const ok = await save(
          {
            message: `Cue：編輯「${draft.content.title}」`,
            posts: (p) =>
              mapPost(p, existing.id, (x) => {
                let y: Post = rerender({ ...x, content: draft.content, style: draft.style, mention: draft.mention, channels: draft.channels, source: draft.source }, config, labelOf(x));
                y = asDraft || draft.at === null ? (y.status === 'draft' ? y : unschedule(y, nowMs, tz)) : toSchedule(y, draft.at, nowMs, tz);
                return y;
              }),
          },
          { ok: asDraft || draft.at === null ? '已儲存草稿' : `已排程在 ${fmtDateTime(draft.at!, tz, nowMs)}` },
        );
        if (ok) go('posts');
        return;
      }
      const list = asDraft
        ? [makePost({ content: draft.content, style: draft.style, mention: draft.mention, channels: draft.channels, at: null, rule: null, label: null, series: null, source: draft.source }, config, nowMs)]
        : (() => {
            const series = planned.posts.length > 1 ? newId('s') : null;
            return planned.posts.map((p, i) =>
              makePost(
                {
                  content: p.content,
                  style: draft.style,
                  mention: draft.mention,
                  channels: draft.channels,
                  at: p.rule === 'now' ? nowMs : p.at,
                  rule: p.rule,
                  label: p.label,
                  series: series ? { id: series, index: i + 1, total: planned.posts.length } : null,
                  source: draft.source,
                },
                config,
                nowMs,
              ),
            );
          })();
      const immediate = !asDraft && list.some((p) => p.at && Date.parse(p.at) <= nowMs + 60_000);
      const ok = await save(
        { message: asDraft ? `Cue：草稿「${draft.content.title}」` : `Cue：排程「${draft.content.title}」${list.length > 1 ? `（${list.length} 則）` : ''}`, posts: (p) => addPosts(p, list) },
        { ok: asDraft ? '已存成草稿' : list.length > 1 ? `已排程 ${list.length} 則` : immediate ? '' : `已排程在 ${fmtDateTime(Date.parse(list[0].at!), tz, nowMs)}` },
      );
      if (!ok) return;
      if (immediate && (await kick('send-now'))) toast(backend?.kind === 'demo' ? '已交給模擬排程器，馬上「送出」。' : '已交給雲端排程器，大約 30 秒內送達 Discord。');
      go(asDraft ? 'posts/draft' : 'posts/scheduled');
    } finally {
      setBusy(false);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      create(false);
    }
  };

  const when = draft.content.when;
  const whenAt = when ? Date.parse(when.at) : null;
  const ruleChips = RULES.map((r) => {
    const at = ruleTime(r.id, whenAt, now, tz);
    let disabled: string | null = null;
    if (at === null) disabled = '需要先有時間';
    else if (r.id !== 'now' && at < now - 60_000) disabled = '已經過了';
    else if (r.id !== 'now' && whenAt !== null && at >= whenAt) disabled = '在活動之後';
    return { ...r, at, disabled };
  });
  const customRules = draft.rules.filter((r) => r.startsWith('at:'));
  const submitLabel = existing
    ? editingSent
      ? '更新 Discord 上的訊息'
      : draft.at === null
        ? '儲存草稿'
        : '儲存並排程'
    : planned.posts.length === 1 && planned.posts[0].rule === 'now'
      ? '立即發送'
      : `排程 ${planned.posts.length} 則`;

  return (
    <div class="cue-page compose-page" onKeyDown={onKey}>
      <header class="page-head">
        <div class="stack tight">
          <span class="eyebrow">{existing ? (editingSent ? '修改已發送的公告' : '編輯') : '撰寫公告'}</span>
          <h1 class="title-l">{existing ? draft.content.title || '（無標題）' : '貼上，就整理好'}</h1>
        </div>
        {existing && (
          <a class="btn ghost" href={href('posts')}>
            <Icon name="back" />
            回到紀錄
          </a>
        )}
      </header>

      {editingSent && (
        <div class="notice info">
          <Icon name="info" />
          <span>這則已經送到 Discord。儲存後排程器會把 Discord 上的訊息改成新的內容（頻道與發送時間不能再改）。</span>
        </div>
      )}

      <div class="compose">
        <div class="compose-form stack loose">
          {!editingSent && (
            <Step
              n={1}
              title="貼上原文"
              aside={
                !existing && (
                  <div class="row wrap examples" role="group" aria-label="範例">
                    <span class="small muted">範例</span>
                    {examples.map((s) => (
                      <button type="button" key={s.id} class="pill" onClick={() => onSource(s.text)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )
              }
            >
              <textarea
                ref={sourceRef}
                class="textarea source"
                rows={6}
                value={draft.source}
                aria-label="原文"
                placeholder={'把要公告的內容整段貼上，例如：\n作業三：互動原型\n繳交期限：下週五 23:59，上傳到 Moodle\n遲交一天扣 10 分'}
                onInput={(e) => onSource((e.target as HTMLTextAreaElement).value)}
              />
              {stale && (
                <div class="notice">
                  <Icon name="spark" />
                  <div class="row between wrap grow">
                    <span>原文改了，要用新的原文重新整理嗎？你手動改過的欄位會被覆蓋。</span>
                    <Btn size="sm" icon="rotate" onClick={reparse}>
                      重新整理
                    </Btn>
                  </div>
                </div>
              )}
              {parsed && !stale && draft.source.trim() && (
                <p class="small muted parsed-line">
                  <Icon name="spark" size={15} />
                  <span>
                  已自動整理：{kindStyle(config, parsed.content.kind).label}
                  {parsed.content.when ? ` · ${fmtDateTime(Date.parse(parsed.content.when.at), tz, now)}` : ''}
                  {parsed.content.place ? ` · ${parsed.content.place.value}` : ''}
                  {parsed.content.links.length ? ` · ${parsed.content.links.length} 個連結` : ''}
                  {parsed.content.notes.length ? ` · ${parsed.content.notes.length} 則注意事項` : ''}
                  </span>
                </p>
              )}
            </Step>
          )}

          <Step n={editingSent ? 1 : 2} title="確認內容">
            <div class="kinds" role="group" aria-label="公告類型">
              {KIND_ORDER.map((k) => {
                const s = kindStyle(config, k);
                return (
                  <button
                    type="button"
                    key={k}
                    class="kind-pick"
                    style={{ '--k': s.color } as any}
                    aria-pressed={draft.content.kind === k}
                    onClick={() => {
                      setContent({ kind: k });
                      if (!touched.has('rules') && !existing) setDraft((d) => ({ ...d, content: { ...d.content, kind: k }, rules: d.content.when ? kindStyle(config, k).reminders : ['now'] }));
                      if (!touched.has('channels') && !existing) setDraft((d) => ({ ...d, channels: defaultChannels(k, config.channels) }));
                    }}
                  >
                    <span aria-hidden="true">{s.emoji}</span>
                    {s.label}
                  </button>
                );
              })}
            </div>
            <Field label="標題" count={draft.content.title.length} max={LIMITS.title} help={draft.repeat ? '可以用 {週}、{n}、{日期}，每一則會換成那一次的週次、序號、日期。' : undefined}>
              <input class="input" value={draft.content.title} maxLength={LIMITS.title} placeholder={kind.headline} onInput={(e) => setContent({ title: (e.target as HTMLInputElement).value })} />
            </Field>
            <div class="when-edit">
              <Field label={kind.whenLabel} optional>
                <input
                  class="input"
                  type="datetime-local"
                  value={whenAt !== null ? toInputValue(whenAt, tz) : ''}
                  onInput={(e) => {
                    const v = fromInputValue((e.target as HTMLInputElement).value, tz);
                    setContent({ when: v === null ? null : { at: isoLocal(v, tz), end: when?.end ?? null, allDay: when?.allDay ?? false } });
                    if (!touched.has('rules') && !existing && v !== null && !when) setDraft((d) => ({ ...d, rules: kind.reminders }));
                  }}
                />
              </Field>
              {when && (
                <Field label="結束" optional>
                  <input
                    class="input"
                    type="time"
                    value={when.end ? toInputValue(Date.parse(when.end), tz).slice(11) : ''}
                    onInput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      const w = wall(whenAt!, tz);
                      const [h, m] = v.split(':').map(Number);
                      setContent({ when: { ...when, end: v ? isoLocal(zoned(w.y, w.m, w.d, h, m, tz), tz) : null } });
                    }}
                  />
                </Field>
              )}
              {when && (
                <div class="when-tools">
                  <Switch checked={Boolean(when.allDay)} label="整天" onChange={(v) => setContent({ when: { ...when, allDay: v } })} />
                  <Btn size="sm" variant="ghost" icon="x" onClick={() => setContent({ when: null })}>
                    清除時間
                  </Btn>
                </div>
              )}
            </div>
            <div class="grid-2">
              <Field label={draft.content.place?.label === '繳交' ? '繳交方式' : '地點'} optional>
                <div class="row" style={{ gap: '6px' }}>
                  <select
                    class="select sm"
                    style={{ width: '92px' }}
                    aria-label="地點或繳交"
                    value={draft.content.place?.label ?? '地點'}
                    onChange={(e) => setContent({ place: { label: (e.target as HTMLSelectElement).value, value: draft.content.place?.value ?? '' } })}
                  >
                    <option value="地點">地點</option>
                    <option value="繳交">繳交</option>
                  </select>
                  <input
                    class="input grow"
                    aria-label="地點內容"
                    value={draft.content.place?.value ?? ''}
                    placeholder="例如：設計學院 B1 創意基地"
                    onInput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      setContent({ place: v ? { label: draft.content.place?.label ?? '地點', value: v } : null });
                    }}
                  />
                </div>
              </Field>
              <Field label="攜帶" optional>
                <input class="input" value={draft.content.bring} placeholder="例如：筆電、學生證" onInput={(e) => setContent({ bring: (e.target as HTMLInputElement).value })} />
              </Field>
            </div>
            <Field label="內文" optional help="支援 Discord 格式：**粗體**、*斜體*、> 引用、- 清單。">
              <textarea class="textarea" rows={4} value={draft.content.body} onInput={(e) => setContent({ body: (e.target as HTMLTextAreaElement).value })} />
            </Field>
            <div class="grid-2">
              <ListEditor label="重點" items={draft.content.bullets} placeholder="新增重點條列" add="再加一點" onChange={(v) => setContent({ bullets: v })} />
              <ListEditor label="注意事項" items={draft.content.notes} placeholder="新增注意事項" add="再加一則" onChange={(v) => setContent({ notes: v })} />
            </div>
            <LinksEditor links={draft.content.links} onChange={(v) => setContent({ links: v })} />
            {more ? (
              <Field label="圖片網址" optional help="https 開頭的圖片，會顯示在卡片下方。">
                <input class="input mono" value={draft.content.image} placeholder="https://…" onInput={(e) => setContent({ image: (e.target as HTMLInputElement).value.trim() })} />
              </Field>
            ) : (
              <button type="button" class="link-btn small" onClick={() => setMore(true)}>
                加一張圖片
              </button>
            )}
          </Step>

          <Step n={editingSent ? 2 : 3} title={editingSent ? '樣式' : '發送設定'}>
            {!editingSent && (
              <div class="field">
                <span class="label">
                  <span>頻道</span>
                  <a class="small" href={href('channels')}>
                    管理頻道
                  </a>
                </span>
                {config.channels.length === 0 ? (
                  <div class="notice info">
                    <Icon name="hash" />
                    <span>
                      還沒有任何頻道。<a href={href('channels')}>新增一個 Discord 頻道</a>之後才能發送；現在可以先存成草稿。
                    </span>
                  </div>
                ) : (
                  <div class="ch-pick" role="group" aria-label="頻道">
                    {config.channels.map((c) => {
                      const on = draft.channels.includes(c.id);
                      return (
                        <button
                          type="button"
                          key={c.id}
                          class="ch-toggle"
                          style={{ '--c': c.color } as any}
                          aria-pressed={on}
                          onClick={() => setField('channels', on ? draft.channels.filter((x) => x !== c.id) : [...draft.channels, c.id])}
                        >
                          <span class="ch-emoji" aria-hidden="true">
                            {c.emoji}
                          </span>
                          <span class="grow">
                            <b>{c.name}</b>
                            {!c.webhookSavedAt && <small>未設定 Webhook</small>}
                          </span>
                          <span class="tick" aria-hidden="true">
                            <Icon name="check" size={14} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div class="grid-2">
              <div class="field">
                <span class="label">
                  <span>樣式</span>
                </span>
                <Seg<PostStyle>
                  label="樣式"
                  value={draft.style}
                  onChange={(v) => setField('style', v)}
                  options={[
                    { value: 'embed', label: '卡片', sub: '有色條與欄位' },
                    { value: 'text', label: '純文字', sub: '可直接複製貼上' },
                  ]}
                />
              </div>
              <div class="field">
                <span class="label">
                  <span>標註</span>
                </span>
                <Seg<Mention['type']>
                  label="標註"
                  value={draft.mention.type}
                  onChange={(v) => setField('mention', v === 'role' ? { type: 'role', id: '', name: '' } : ({ type: v } as Mention))}
                  options={[
                    { value: 'none', label: '不標註' },
                    { value: 'everyone', label: '@everyone' },
                    { value: 'here', label: '@here' },
                    { value: 'role', label: '身分組' },
                  ]}
                />
                {draft.mention.type === 'role' && (
                  <div class="row" style={{ gap: '6px', marginTop: '6px' }}>
                    <input
                      class="input sm"
                      placeholder="名稱，例如 學生"
                      aria-label="身分組名稱"
                      value={(draft.mention as any).name ?? ''}
                      onInput={(e) => setField('mention', { ...(draft.mention as any), type: 'role', name: (e.target as HTMLInputElement).value })}
                    />
                    <input
                      class="input sm mono"
                      placeholder="身分組 ID"
                      aria-label="身分組 ID"
                      value={(draft.mention as any).id ?? ''}
                      onInput={(e) => setField('mention', { ...(draft.mention as any), type: 'role', id: (e.target as HTMLInputElement).value.replace(/\D/g, '') })}
                    />
                  </div>
                )}
              </div>
            </div>

            {!editingSent &&
              (existing ? (
                <div class="field">
                  <span class="label">
                    <span>發送時間</span>
                  </span>
                  <div class="row wrap" style={{ gap: '8px' }}>
                    <input
                      class="input"
                      style={{ maxWidth: '260px' }}
                      type="datetime-local"
                      aria-label="發送時間"
                      value={draft.at !== null ? toInputValue(draft.at, tz) : ''}
                      onInput={(e) => setField('at', fromInputValue((e.target as HTMLInputElement).value, tz))}
                    />
                    {draft.at !== null && (
                      <Btn size="sm" variant="ghost" icon="pause" onClick={() => setField('at', null)}>
                        不排程（存成草稿）
                      </Btn>
                    )}
                  </div>
                </div>
              ) : (
                <div class="field">
                  <span class="label">
                    <span>什麼時候發</span>
                    <span class="small muted">可以選好幾個：一則公告、多次提醒</span>
                  </span>
                  <div class="rules" role="group" aria-label="發送時間">
                    {ruleChips.map((r) => {
                      const on = draft.rules.includes(r.id);
                      return (
                        <button
                          type="button"
                          key={r.id}
                          class="rule"
                          aria-pressed={on && !r.disabled}
                          disabled={Boolean(r.disabled) && !on}
                          title={r.disabled ?? undefined}
                          onClick={() => setField('rules', on ? draft.rules.filter((x) => x !== r.id) : [...draft.rules, r.id])}
                        >
                          <b>{r.label}</b>
                          <small>{r.disabled ? r.disabled : r.id === 'now' ? '按下就送' : r.at ? fmtDateTime(r.at, tz, now) : ''}</small>
                        </button>
                      );
                    })}
                    {customRules.map((r) => (
                      <button type="button" key={r} class="rule" aria-pressed="true" onClick={() => setField('rules', draft.rules.filter((x) => x !== r))}>
                        <b>{ruleLabel(r, tz, now)}</b>
                        <small>自訂 · 點一下移除</small>
                      </button>
                    ))}
                  </div>
                  <div class="row wrap" style={{ gap: '8px', marginTop: '4px' }}>
                    <input class="input sm" style={{ width: 'auto' }} type="datetime-local" aria-label="自訂發送時間" value={customAt} onInput={(e) => setCustomAt((e.target as HTMLInputElement).value)} />
                    <Btn
                      size="sm"
                      icon="plus"
                      onClick={() => {
                        const v = fromInputValue(customAt, tz);
                        if (v === null) return;
                        if (v < Date.now() - 60_000) {
                          toast('這個時間已經過了。', { kind: 'error' });
                          return;
                        }
                        const id = `at:${isoLocal(v, tz)}`;
                        if (!draft.rules.includes(id)) setField('rules', [...draft.rules, id]);
                      }}
                    >
                      加入自訂時間
                    </Btn>
                  </div>
                  {when && (
                    <div class="repeat">
                      <Switch
                        checked={Boolean(draft.repeat)}
                        label="每週重複（例如每週的上課提醒）"
                        onChange={(v) => setField('repeat', v ? { weeks: 1, until: dayKey(Date.parse(when.at) + 8 * 7 * DAY, tz) } : null)}
                      />
                      {draft.repeat && (
                        <div class="row wrap" style={{ gap: '8px' }}>
                          <select class="select sm" style={{ width: '120px' }} aria-label="重複頻率" value={draft.repeat.weeks} onChange={(e) => setField('repeat', { ...draft.repeat!, weeks: Number((e.target as HTMLSelectElement).value) as 1 | 2 })}>
                            <option value={1}>每週</option>
                            <option value={2}>每兩週</option>
                          </select>
                          <span class="small muted">直到</span>
                          <input class="input sm" style={{ width: 'auto' }} type="date" aria-label="重複到哪一天" value={draft.repeat.until} onInput={(e) => setField('repeat', { ...draft.repeat!, until: (e.target as HTMLInputElement).value })} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
          </Step>
        </div>

        <aside class="compose-preview">
          <div class="sticky-side stack">
            <div class="row between">
              <span class="eyebrow">Discord 預覽</span>
              <div class="row" style={{ gap: '6px' }}>
                <Btn size="sm" variant="ghost" icon="copy" onClick={() => copyText(plainText({ content: shown?.content ?? draft.content, style: draft.style, mention: draft.mention, config, label: shown?.label }), '已複製 Discord 格式文字')}>
                  複製
                </Btn>
                <Seg<PreviewTheme>
                  label="預覽主題"
                  value={previewTheme}
                  onChange={setPreviewTheme}
                  options={[
                    { value: 'dark', label: <><Icon name="moon" size={15} /><span class="sr-only">深色預覽</span></> },
                    { value: 'light', label: <><Icon name="sun" size={15} /><span class="sr-only">淺色預覽</span></> },
                  ]}
                />
              </div>
            </div>
            {!existing && planned.posts.length > 1 && (
              <div class="plan-tabs" role="tablist" aria-label="這次會建立的貼文">
                {planned.posts.slice(0, 8).map((p, i) => (
                  <button type="button" role="tab" key={i} aria-selected={i === Math.min(tab, planned.posts.length - 1)} onClick={() => setTab(i)}>
                    <b>{p.rule === 'now' ? '現在' : fmtDateTime(p.at, tz, now).replace(/（.）/, '')}</b>
                    <small>{p.label ?? (p.rule === 'now' ? '公告' : '提醒')}</small>
                  </button>
                ))}
                {planned.posts.length > 8 && <span class="small muted">+{planned.posts.length - 8}</span>}
              </div>
            )}
            <DiscordPreview payload={payload} config={config} channel={channel} theme={previewTheme} at={shown && shown.rule !== 'now' ? shown.at : now} now={now} />
            {notes.length > 0 && (
              <ul class="checks">
                {notes.map((n, i) => (
                  <li key={i} class={n.level}>
                    <Icon name={n.level === 'error' ? 'xCircle' : n.level === 'warn' ? 'alert' : 'info'} size={16} />
                    <span>{n.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <div class="submit-bar">
              {!existing && planned.posts.length > 0 && (
                <p class="small muted">
                  {planned.posts.length === 1 && planned.posts[0].rule === 'now'
                    ? `按下後馬上送到 ${draft.channels.length} 個頻道。`
                    : `將建立 ${planned.posts.length} 則：${planned.posts
                        .slice(0, 3)
                        .map((p) => (p.rule === 'now' ? '現在' : fmtDateTime(p.at, tz, now).replace(/（.）/, '')))
                        .join('、')}${planned.posts.length > 3 ? '…' : ''}`}
                </p>
              )}
              {!existing && planned.posts.length === 0 && <p class="small" style={{ color: 'var(--danger)' }}>選擇的時間都已經過了，請挑別的時間。</p>}
              <div class="row wrap">
                {!editingSent && (
                  <Btn variant="ghost" icon="file" disabled={busy} onClick={() => create(true)}>
                    存成草稿
                  </Btn>
                )}
                <span class="grow" />
                <Btn variant="accent" size="lg" icon={editingSent ? 'rotate' : 'send'} loading={busy} disabled={(!existing && planned.posts.length === 0) || blocking} onClick={() => create(false)}>
                  {submitLabel}
                </Btn>
              </div>
              <span class="tiny faint">
                <kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">Enter</kbd> 也可以送出
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
