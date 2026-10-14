// Discord channels Cue can post to. Each one needs its webhook URL pasted
// once; the browser encrypts it straight into a repository secret, so it
// never appears in the repository, in Cue's data, or anywhere on screen again.

import { useEffect, useState } from 'preact/hooks';
import { href } from '../../app/router';
import { confirm, openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, Empty, Field, Menu, Seg } from '../../ui/base';
import { toast } from '../../ui/toast';
import { app, errorText, save } from '../app/state';
import { looksLikeChannelLink, newId, parseWebhookUrl, secretName, type Channel, type Mention } from '../core/model';
import { putChannel } from '../core/ops';
import { fmtDateTime, isoLocal } from '../core/time';
import { PageHead, useData, useNow } from '../ui/parts';

const COLORS = ['#5865f2', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#a855f7', '#0ea5e9', '#64748b'];
const EMOJIS = ['📢', '📚', '📝', '✏️', '🎬', '☕', '💬', '📎', '🎓', '🧪', '🗓️', '⭐'];

function blankChannel(): Channel {
  const id = newId('ch', 6);
  return {
    id,
    name: '',
    emoji: '💬',
    color: COLORS[0],
    note: '',
    secret: secretName(id),
    webhookSavedAt: null,
    webhookHint: '',
    username: '',
    avatar: '',
    mention: { type: 'none' },
    discord: null,
    test: null,
  };
}

function WebhookGuide() {
  return (
    <details class="guide">
      <summary>
        <Icon name="info" size={16} />
        怎麼拿到 Webhook 網址？（30 秒）
      </summary>
      <ol>
        <li>
          在 Discord 對頻道按右鍵（手機長按）→ <b>編輯頻道</b>
        </li>
        <li>
          <b>整合</b> → <b>Webhook</b> → <b>新 Webhook</b>
        </li>
        <li>名字可以取「Cue」，頭像隨意</li>
        <li>
          按 <b>複製 Webhook 網址</b>，貼到下面
        </li>
      </ol>
      <p class="small muted">需要「管理 Webhook」權限。網址長得像 https://discord.com/api/webhooks/1234…/abcd…</p>
    </details>
  );
}

function ChannelForm({ initial, close }: { initial: Channel | null; close: (v?: boolean) => void }) {
  const { backend, config } = app.get();
  const [c, setC] = useState<Channel>(initial ?? blankChannel());
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hook = url.trim() ? parseWebhookUrl(url) : null;
  const urlError = !url.trim()
    ? null
    : looksLikeChannelLink(url)
      ? '這是頻道連結，不是 Webhook 網址。請到頻道設定 → 整合 → Webhook 複製網址。'
      : !hook
        ? '看起來不是 Discord Webhook 網址（應該是 https://discord.com/api/webhooks/… 開頭）。'
        : null;
  const set = (patch: Partial<Channel>) => setC((x) => ({ ...x, ...patch }));
  const needsUrl = !initial || !initial.webhookSavedAt;
  const canSave = c.name.trim() && !urlError && (hook || !needsUrl || !url.trim());

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSave || !backend || !config) return;
    setBusy(true);
    setError(null);
    const now = Date.now();
    let next: Channel = { ...c, name: c.name.trim().replace(/^#/, ''), note: c.note.trim(), username: c.username.trim(), avatar: c.avatar.trim() };
    try {
      if (hook) {
        await backend.saveWebhook(next, hook.url);
        next = { ...next, webhookSavedAt: isoLocal(now, config.timezone), webhookHint: `…${hook.id.slice(-6)}`, test: null };
      }
      const ok = await save(
        { message: `Cue：${initial ? '更新' : '新增'}頻道 #${next.name}`, config: (cfg) => putChannel(cfg, next.id, next, now) },
        { ok: initial ? '頻道已更新' : hook ? `已新增 #${next.name}，可以按「傳送測試」確認` : `已新增 #${next.name}` },
      );
      if (ok) close(true);
    } catch (x) {
      setError(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="stack" onSubmit={submit}>
      <h2>{initial ? `編輯 #${initial.name}` : '新增 Discord 頻道'}</h2>
      <div class="ch-form-top">
        <Field label="頻道名稱" help="只是 Cue 裡顯示的名字，可以和 Discord 上的一樣。">
          <input class="input" value={c.name} placeholder="例如：作業繳交" maxLength={40} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} data-autofocus />
        </Field>
        <div class="field">
          <span class="label">
            <span>圖示</span>
          </span>
          <div class="emoji-pick" role="group" aria-label="圖示">
            {EMOJIS.map((em) => (
              <button type="button" key={em} aria-pressed={c.emoji === em} onClick={() => set({ emoji: em })}>
                {em}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div class="field">
        <span class="label">
          <span>顏色</span>
        </span>
        <div class="swatches" role="group" aria-label="顏色">
          {COLORS.map((col) => (
            <button type="button" key={col} aria-pressed={c.color === col} aria-label={col} style={{ background: col }} onClick={() => set({ color: col })} />
          ))}
        </div>
      </div>
      <Field label="Webhook 網址" optional={!needsUrl} help={initial?.webhookSavedAt ? `已設定（Webhook ${initial.webhookHint}）。要換新的才需要再貼。` : '只會加密存進 GitHub Secrets，之後任何地方都看不到。'} error={urlError}>
        <input class="input mono" value={url} placeholder="https://discord.com/api/webhooks/…" autocomplete="off" spellcheck={false} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      </Field>
      <WebhookGuide />
      <Field label="用途說明" optional>
        <input class="input" value={c.note} placeholder="例如：作業公告與截止提醒" maxLength={60} onInput={(e) => set({ note: (e.target as HTMLInputElement).value })} />
      </Field>
      <details class="guide">
        <summary>
          <Icon name="sliders" size={16} />
          進階：發文身分與預設標註
        </summary>
        <div class="stack" style={{ marginTop: '10px' }}>
          <Field label="發文者名稱" optional help={`留空就用「${config?.username || 'Webhook 本身的名字'}」。`}>
            <input class="input" value={c.username} maxLength={80} onInput={(e) => set({ username: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label="頭像網址" optional>
            <input class="input mono" value={c.avatar} placeholder="https://…" onInput={(e) => set({ avatar: (e.target as HTMLInputElement).value })} />
          </Field>
          <div class="field">
            <span class="label">
              <span>這個頻道預設標註</span>
            </span>
            <Seg<Mention['type']>
              label="預設標註"
              value={c.mention.type === 'role' ? 'none' : c.mention.type}
              onChange={(v) => set({ mention: { type: v } as Mention })}
              options={[
                { value: 'none', label: '不標註' },
                { value: 'everyone', label: '@everyone' },
                { value: 'here', label: '@here' },
              ]}
            />
          </div>
        </div>
      </details>
      {error && (
        <div class="notice warn" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
      <div class="actions">
        <Btn onClick={() => close()}>取消</Btn>
        <Btn type="submit" variant="primary" loading={busy} disabled={!canSave}>
          {initial ? '儲存' : '新增頻道'}
        </Btn>
      </div>
    </form>
  );
}

export function editChannel(c: Channel | null) {
  return openDialog(c ? `編輯 #${c.name}` : '新增頻道', (close) => <ChannelForm initial={c} close={close} />, { wide: 'wide' });
}

function ChannelCard({ c, stored, testing, onTest }: { c: Channel; stored: Set<string> | null; testing: boolean; onTest: () => void }) {
  const { posts, config, backend } = useData();
  const now = useNow(30000);
  const sent = posts.filter((p) => p.deliveries.some((d) => d.channel === c.id && d.status === 'sent')).length;
  const queued = posts.filter((p) => p.status === 'scheduled' && p.channels.includes(c.id)).length;
  const missingSecret = Boolean(c.webhookSavedAt && stored && !stored.has(c.secret.toUpperCase()));
  let state: { cls: string; text: string; icon: 'okCircle' | 'alert' | 'clock' | 'xCircle' };
  if (testing) state = { cls: 'testing', text: '測試中…', icon: 'clock' };
  else if (!c.webhookSavedAt) state = { cls: 'off', text: '尚未設定 Webhook', icon: 'xCircle' };
  else if (missingSecret) state = { cls: 'bad', text: 'GitHub 上找不到 Webhook', icon: 'alert' };
  else if (c.test?.ok === false) state = { cls: 'bad', text: '上次測試失敗', icon: 'alert' };
  else if (c.test?.ok) state = { cls: 'ok', text: '已連線', icon: 'okCircle' };
  else state = { cls: 'ok', text: '已設定 Webhook', icon: 'okCircle' };

  return (
    <article class="ch-card" style={{ '--c': c.color } as any}>
      <header class="row top between">
        <div class="row" style={{ gap: '12px', minWidth: 0 }}>
          <span class="ch-icon" aria-hidden="true">
            {c.emoji}
          </span>
          <div class="stack" style={{ gap: '0', minWidth: 0 }}>
            <h3 class="title-s nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              # {c.name}
            </h3>
            <span class="small muted">{c.note || '　'}</span>
          </div>
        </div>
        <Menu label={`#${c.name} 的更多動作`} trigger={<Icon name="more" />}>
          {(close) => (
            <>
              <button type="button" class="mi" role="menuitem" onClick={() => (close(), editChannel(c))}>
                <Icon name="edit" size={16} />
                編輯
              </button>
              <button
                type="button"
                class="mi danger"
                role="menuitem"
                onClick={async () => {
                  close();
                  const ok = await confirm({
                    title: `刪除 #${c.name}？`,
                    body: `${queued ? `還有 ${queued} 則排程要發到這裡，它們會發送失敗。` : ''}Cue 會一併刪除 GitHub 上的 Webhook 密鑰；Discord 上的 Webhook 不受影響。`,
                    ok: '刪除頻道',
                    danger: true,
                  });
                  if (!ok || !backend) return;
                  try {
                    await backend.deleteWebhook(c);
                  } catch (e) {
                    toast(errorText(e), { kind: 'error' });
                    return;
                  }
                  save({ message: `Cue：刪除頻道 #${c.name}`, config: (cfg) => putChannel(cfg, c.id, null, Date.now()) }, { ok: `已刪除 #${c.name}` });
                }}
              >
                <Icon name="trash" size={16} />
                刪除頻道
              </button>
            </>
          )}
        </Menu>
      </header>
      <div class={`ch-state ${state.cls}`}>
        <Icon name={state.icon} size={16} />
        <span class="grow">{state.text}</span>
        {c.webhookHint && <span class="mono tiny faint">Webhook {c.webhookHint}</span>}
      </div>
      {c.test && !testing && (
        <p class="tiny muted">
          {c.test.ok ? '測試訊息已送達' : `測試失敗：${c.test.error}`} · {fmtDateTime(Date.parse(c.test.at), config.timezone, now)}
        </p>
      )}
      <dl class="ch-stats">
        <div>
          <dt>已送出</dt>
          <dd class="mono">{sent}</dd>
        </div>
        <div>
          <dt>排程中</dt>
          <dd class="mono">{queued}</dd>
        </div>
        <div>
          <dt>標註</dt>
          <dd>{c.mention.type === 'none' ? '—' : c.mention.type === 'everyone' ? '@everyone' : c.mention.type === 'here' ? '@here' : '身分組'}</dd>
        </div>
      </dl>
      <div class="row wrap">
        {c.webhookSavedAt ? (
          <Btn size="sm" icon="send" onClick={onTest} loading={testing}>
            傳送測試
          </Btn>
        ) : (
          <Btn size="sm" variant="accent" icon="link" onClick={() => editChannel(c)}>
            貼上 Webhook
          </Btn>
        )}
        {c.discord?.channel && c.discord.guild && backend?.kind !== 'demo' && (
          <a class="btn sm ghost" href={`https://discord.com/channels/${c.discord.guild}/${c.discord.channel}`} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={16} />
            在 Discord 開啟
          </a>
        )}
      </div>
    </article>
  );
}

export function ChannelsPage() {
  const { config, backend } = useData();
  const [stored, setStored] = useState<Set<string> | null>(null);
  const [testing, setTesting] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!backend) return;
    backend
      .webhooks()
      .then(setStored)
      .catch(() => setStored(null));
  }, [backend, config.channels.length]);

  // a test finished when the scheduler wrote its request id back
  useEffect(() => {
    for (const [id, req] of Object.entries(testing)) {
      const c = config.channels.find((x) => x.id === id);
      if (c?.test?.id === req) {
        toast(c.test.ok ? `#${c.name} 收到測試訊息了，去 Discord 看看！` : `#${c.name} 測試失敗：${c.test.error}`, { kind: c.test.ok ? 'info' : 'error', ms: 7000 });
        setTesting((t) => {
          const n = { ...t };
          delete n[id];
          return n;
        });
      }
    }
  }, [config, testing]);

  async function test(c: Channel) {
    if (!backend) return;
    const req = newId('t', 6);
    setTesting((t) => ({ ...t, [c.id]: req }));
    try {
      await backend.testChannel(c, req);
      if (backend.kind === 'github') toast('已請 GitHub Actions 送出測試訊息，大約 30 秒。');
    } catch (e) {
      toast(errorText(e), { kind: 'error' });
      setTesting((t) => {
        const n = { ...t };
        delete n[c.id];
        return n;
      });
    }
  }

  return (
    <div class="cue-page enter">
      <PageHead title="頻道" sub="每個 Discord 頻道貼一次 Webhook 網址，之後就能排程發送。網址加密保存在 GitHub Secrets。">
        <Btn variant="accent" icon="plus" onClick={() => editChannel(null)}>
          新增頻道
        </Btn>
      </PageHead>

      {config.channels.length === 0 ? (
        <div class="card pad-l stack" style={{ maxWidth: '640px' }}>
          <Empty icon="hash" title="還沒有頻道">
            新增第一個 Discord 頻道：取個名字、貼上它的 Webhook 網址就好。
          </Empty>
          <WebhookGuide />
          <div>
            <Btn variant="accent" icon="plus" onClick={() => editChannel(null)}>
              新增頻道
            </Btn>
          </div>
        </div>
      ) : (
        <div class="ch-grid">
          {config.channels.map((c) => (
            <ChannelCard key={c.id} c={c} stored={stored} testing={Boolean(testing[c.id])} onTest={() => test(c)} />
          ))}
          <button type="button" class="ch-card add" onClick={() => editChannel(null)}>
            <Icon name="plus" size={22} />
            新增頻道
          </button>
        </div>
      )}

      <section class="card sunk stack tight" style={{ maxWidth: '760px' }}>
        <span class="title-s row" style={{ gap: '8px' }}>
          <Icon name="shield" size={18} />
          Webhook 網址存在哪裡？
        </span>
        <p class="small muted">
          瀏覽器拿到網址後，立刻用 repository 的公開金鑰加密（libsodium sealed box），存成 GitHub Actions secret
          <code class="mono"> CUE_WEBHOOK_…</code>。只有排程器在發送的那一刻能解開；repository、資料分支、這個網站都不會留下明文。
          {backend?.kind === 'demo' && ' 示範模式不會儲存任何網址。'}
        </p>
        <a class="small" href={href('settings')}>
          其他設定
        </a>
      </section>
    </div>
  );
}
