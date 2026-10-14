// One post, opened from anywhere: what it looks like in Discord, where it
// went, what happened, and everything you can do with it.

import { useState } from 'preact/hooks';
import { go } from '../../app/router';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, copyText, Seg } from '../../ui/base';
import { app } from '../app/state';
import { effectiveTheme, theme } from '../app/theme';
import { kindStyle, messageLink, type Post } from '../core/model';
import { isEditable } from '../core/ops';
import { plainText } from '../core/render';
import { ruleLabel } from '../core/schedule';
import { fmtDateTime, fmtRelative, fromInputValue, toInputValue } from '../core/time';
import { DiscordPreview, type PreviewTheme } from '../ui/DiscordPreview';
import { ChannelChip, KindTag, StatusChip, useNow } from '../ui/parts';
import { duplicate, remove, removeSeries, reschedule, retract, sendNow, toDraft } from './actions';

export function openPost(id: string) {
  return openDialog(
    '貼文詳情',
    (close) => <PostDetail id={id} close={close} />,
    { wide: 'xwide' },
  );
}

function RescheduleInline({ post, done }: { post: Post; done: () => void }) {
  const tz = app.get().config!.timezone;
  const [v, setV] = useState(toInputValue(post.at ? Date.parse(post.at) : Date.now() + 3600_000, tz));
  const at = fromInputValue(v, tz);
  return (
    <div class="row wrap" style={{ gap: '8px' }}>
      <input class="input sm" style={{ width: 'auto' }} type="datetime-local" value={v} aria-label="新的發送時間" onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      <Btn
        size="sm"
        variant="primary"
        disabled={!at || at < Date.now() - 60_000}
        onClick={async () => {
          if (at && (await reschedule(post, at))) done();
        }}
      >
        改時間
      </Btn>
      <Btn size="sm" variant="ghost" onClick={done}>
        取消
      </Btn>
    </div>
  );
}

export function PostDetail({ id, close }: { id: string; close: () => void }) {
  const { posts, config } = app.use();
  const t = theme.use();
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>(effectiveTheme(t));
  const [moving, setMoving] = useState(false);
  const now = useNow(15000);
  const post = posts.find((p) => p.id === id);
  if (!post || !config) {
    return (
      <div class="stack">
        <h2>這則貼文已經不在了</h2>
        <p class="muted">可能剛被刪除，或在另一台裝置上被移除了。</p>
        <div class="actions">
          <Btn onClick={close}>關閉</Btn>
        </div>
      </div>
    );
  }
  const tz = config.timezone;
  const at = post.at ? Date.parse(post.at) : null;
  const k = kindStyle(config, post.content.kind);
  const firstChannel = config.channels.find((c) => c.id === post.channels[0]);
  const sent = post.deliveries.filter((d) => d.status === 'sent');
  const series = post.series ? posts.filter((p) => p.series?.id === post.series!.id).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')) : [];

  return (
    <div class="post-detail">
      <div class="pd-main stack">
        <div class="row between top">
          <div class="stack tight" style={{ minWidth: 0 }}>
            <div class="row wrap" style={{ gap: '6px' }}>
              <KindTag kind={post.content.kind} config={config} />
              <StatusChip status={post.status} />
              {post.request && (
                <span class="chip st-sending">
                  <Icon name="rotate" size={13} />
                  {post.request.type === 'delete' ? '撤回中' : '更新中'}
                </span>
              )}
            </div>
            <h2 class="title-m" style={{ overflowWrap: 'anywhere' }}>
              {post.content.title || k.headline}
            </h2>
          </div>
          <Btn variant="ghost" icon="x" aria-label="關閉" onClick={close} />
        </div>

        <dl class="kv pd-kv">
          <dt>{post.status === 'sent' || post.status === 'retracted' ? '發送時間' : '預定發送'}</dt>
          <dd>
            {post.sentAt ? (
              <>
                {fmtDateTime(Date.parse(post.sentAt), tz, now)} <span class="muted">（{fmtRelative(Date.parse(post.sentAt), now)}）</span>
              </>
            ) : at ? (
              <>
                {fmtDateTime(at, tz, now)} <span class="muted">（{fmtRelative(at, now)}）</span>
              </>
            ) : (
              <span class="muted">草稿，還沒排定時間</span>
            )}
          </dd>
          {post.content.when && (
            <>
              <dt>{k.whenLabel}</dt>
              <dd>
                {post.content.when.allDay ? fmtDateTime(Date.parse(post.content.when.at), tz, now).split(' ')[0] : fmtDateTime(Date.parse(post.content.when.at), tz, now)}
                {post.content.when.end && ` – ${fmtDateTime(Date.parse(post.content.when.end), tz, now).split(' ').pop()}`}
              </dd>
            </>
          )}
          <dt>頻道</dt>
          <dd class="stack tight">
            {post.channels.map((c) => {
              const d = post.deliveries.find((x) => x.channel === c);
              const link = d ? messageLink(d) : null;
              return (
                <div class="row wrap" key={c} style={{ gap: '8px' }}>
                  <ChannelChip id={c} channel={config.channels.find((x) => x.id === c)} status={d?.status} />
                  {d?.status === 'failed' && <span class="small" style={{ color: 'var(--danger)' }}>{d.error}</span>}
                  {link && app.get().backend?.kind !== 'demo' && (
                    <a class="small" href={link} target="_blank" rel="noopener noreferrer">
                      在 Discord 開啟
                    </a>
                  )}
                </div>
              );
            })}
            {!post.channels.length && <span class="muted">沒有選擇頻道</span>}
          </dd>
          {post.series && (
            <>
              <dt>同一系列</dt>
              <dd>
                <div class="series">
                  {series.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      class={`series-dot st-${p.status} ${p.id === post.id ? 'on' : ''}`}
                      title={`${p.at ? fmtDateTime(Date.parse(p.at), tz, now) : '草稿'} · ${p.rule ? ruleLabel(p.rule, tz, now) : ''}`}
                      onClick={() => {
                        close();
                        openPost(p.id);
                      }}
                    >
                      {p.at ? fmtDateTime(Date.parse(p.at), tz, now).replace(/（.）/, ' ') : '草稿'}
                    </button>
                  ))}
                </div>
              </dd>
            </>
          )}
        </dl>

        {moving && <RescheduleInline post={post} done={() => setMoving(false)} />}

        <div class="row wrap pd-actions">
          {isEditable(post) && (
            <Btn
              variant="primary"
              icon="edit"
              onClick={() => {
                close();
                go(`compose/${post.id}`);
              }}
            >
              編輯
            </Btn>
          )}
          {(post.status === 'scheduled' || post.status === 'draft' || post.status === 'missed') && (
            <Btn
              icon="send"
              variant="accent"
              onClick={async () => {
                if (await sendNow(post)) close();
              }}
            >
              立即發送
            </Btn>
          )}
          {post.status === 'failed' && (
            <Btn icon="rotate" variant="accent" onClick={() => sendNow(post)}>
              重送失敗的頻道
            </Btn>
          )}
          {(post.status === 'scheduled' || post.status === 'draft' || post.status === 'missed' || post.status === 'failed') && !moving && (
            <Btn icon="clock" onClick={() => setMoving(true)}>
              改時間
            </Btn>
          )}
          {(post.status === 'sent' || post.status === 'failed') && sent.length > 0 && (
            <>
              <Btn
                icon="edit"
                onClick={() => {
                  close();
                  go(`compose/${post.id}`);
                }}
              >
                修改已發送的訊息
              </Btn>
              <Btn icon="undo" variant="danger" disabled={Boolean(post.request)} onClick={() => retract(post)}>
                從 Discord 撤回
              </Btn>
            </>
          )}
          {post.status === 'scheduled' && (
            <Btn variant="ghost" icon="pause" onClick={() => toDraft(post)}>
              取消排程
            </Btn>
          )}
          <Btn variant="ghost" icon="copy" onClick={() => copyText(plainText({ content: post.content, style: post.style, mention: post.mention, config }), '已複製 Discord 格式文字，可以直接貼上')}>
            複製文字
          </Btn>
          <Btn
            variant="ghost"
            icon="layers"
            onClick={() => {
              close();
              duplicate(post);
            }}
          >
            複製一份
          </Btn>
          <Btn
            variant="ghost"
            icon="trash"
            class="danger"
            onClick={async () => {
              if (await remove(post)) close();
            }}
          >
            刪除
          </Btn>
          {post.series && (
            <Btn
              variant="ghost"
              icon="trash"
              class="danger"
              onClick={async () => {
                if (await removeSeries(post)) close();
              }}
            >
              刪除整個系列
            </Btn>
          )}
        </div>

        <div class="stack tight">
          <span class="eyebrow">紀錄</span>
          <ol class="log">
            {[...post.log].reverse().map((l, i) => (
              <li key={i} class={l.tone ?? ''}>
                <span class="mono small">{fmtDateTime(Date.parse(l.at), tz, now)}</span>
                <span>{l.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div class="pd-preview stack">
        <div class="row between">
          <span class="eyebrow">學生在 Discord 看到的</span>
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
        <DiscordPreview payload={post.payload} config={config} channel={firstChannel} theme={previewTheme} at={post.sentAt ? Date.parse(post.sentAt) : (at ?? now)} now={now} />
      </div>
    </div>
  );
}
