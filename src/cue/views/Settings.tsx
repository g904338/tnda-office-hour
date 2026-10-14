// Settings: where the data lives, course details that appear on every
// post, how each kind of post looks, the scheduler, and backups.

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { go } from '../../app/router';
import { confirm, openDialog } from '../../ui/dialog';
import { Btn, CopyBtn, Field, QR, Seg } from '../../ui/base';
import { toast } from '../../ui/toast';
import { app, close, deviceLink, restartDemo, save, type GitHubSession } from '../app/state';
import { setTheme, theme, type ThemePref } from '../app/theme';
import { KIND_ORDER, KINDS, kindStyle, usernameProblem, type Config, type KindKey, type Posts } from '../core/model';
import { isEditable, readConfig, readPosts, rerender, toJson } from '../core/ops';
import { dayKey, isValidTimeZone, isoLocal, parseDayKey, wall, zoned } from '../core/time';
import { PageHead, useData } from '../ui/parts';
import { SchedulerCard } from './Scheduler';
import { PREVIEW } from '../app/env';

function Section({ id, title, sub, children }: { id: string; title: string; sub?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="card set-section" id={id} aria-labelledby={`${id}-h`}>
      <div class="stack tight">
        <h2 class="title-m" id={`${id}-h`}>
          {title}
        </h2>
        {sub && <p class="small muted">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

/** Saves config changes and re-renders posts that have not gone out yet, so they pick them up. */
function saveConfig(message: string, fn: (c: Config) => Config, ok: string) {
  const cfg = fn(app.get().config!);
  return save({
    message,
    config: fn,
    posts: (p: Posts) => ({ ...p, posts: p.posts.map((x) => (isEditable(x) ? rerender(x, cfg) : x)) }),
  }, { ok });
}

function DeviceDialog({ session, close: done }: { session: GitHubSession; close: () => void }) {
  const link = deviceLink(session);
  return (
    <div class="stack">
      <h2>在手機或另一台電腦使用</h2>
      <p class="muted small">用手機相機掃描，或把連結傳到你自己的另一台裝置。連結裡包含你的存取權杖，請不要傳給別人或貼到群組。</p>
      <div class="qr-box">
        <QR text={link} label="裝置連結 QR code" />
      </div>
      <div class="row wrap">
        <CopyBtn text={link} label="複製連結" done="已複製，請只傳給你自己" />
        <span class="grow" />
        <Btn onClick={done}>完成</Btn>
      </div>
    </div>
  );
}

function CourseForm() {
  const { config } = useData();
  const [c, setC] = useState(config);
  const set = (patch: Partial<Config>) => setC((x) => ({ ...x, ...patch }));
  const dirty = JSON.stringify(c) !== JSON.stringify(config);
  const startOk = !c.semesterStart || /^\d{4}-\d{2}-\d{2}$/.test(c.semesterStart);
  const startDow = c.semesterStart && startOk ? wall(zoned(parseDayKey(c.semesterStart).y, parseDayKey(c.semesterStart).m, parseDayKey(c.semesterStart).d, 12, 0, c.timezone), c.timezone).dow : 1;
  const tzOk = isValidTimeZone(c.timezone);
  const nameError = usernameProblem(c.username);
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tzOk || !startOk || nameError) return;
        saveConfig(
          'Cue：更新課程設定',
          (cfg) => ({
            ...cfg,
            course: c.course.trim(),
            footer: c.footer.trim(),
            semesterStart: c.semesterStart,
            timezone: c.timezone,
            username: c.username.trim(),
            avatar: c.avatar.trim(),
            updatedAt: isoLocal(Date.now(), c.timezone),
          }),
          '課程設定已更新，排程中的貼文也一起套用',
        );
      }}
    >
      <div class="grid-2">
        <Field label="課程名稱" optional>
          <input class="input" value={c.course} placeholder="例如：TN0006 跨域數位製作實務" onInput={(e) => set({ course: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label="卡片底部文字" optional help="顯示在每則公告的最下面；留空就用課程名稱。">
          <input class="input" value={c.footer} maxLength={200} onInput={(e) => set({ footer: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field
          label="學期第一週的星期一"
          optional
          help={startDow !== 1 ? '這天不是星期一，週次會以它所在的那一週為第 1 週。' : '設定後就能寫「第 8 週（二）」，標題也能用 {週}。'}
        >
          <input class="input" type="date" value={c.semesterStart} onInput={(e) => set({ semesterStart: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label="時區" error={tzOk ? null : '不認得這個時區名稱'} help="所有時間都以這個時區顯示與解讀。">
          <input class="input mono" value={c.timezone} list="tz-list" onInput={(e) => set({ timezone: (e.target as HTMLInputElement).value.trim() })} />
        </Field>
        <Field label="預設發文者名稱" optional error={nameError} help="Discord 上顯示的名字，頻道可以個別覆寫。">
          <input class="input" value={c.username} maxLength={80} placeholder="Webhook 本身的名字" onInput={(e) => set({ username: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label="預設頭像網址" optional>
          <input class="input mono" value={c.avatar} placeholder="https://…" onInput={(e) => set({ avatar: (e.target as HTMLInputElement).value })} />
        </Field>
      </div>
      <datalist id="tz-list">
        {['Asia/Taipei', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Shanghai', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'].map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <div class="row">
        <Btn type="submit" variant="primary" disabled={!dirty || !tzOk || !startOk || Boolean(nameError)}>
          儲存
        </Btn>
        {dirty && (
          <Btn variant="ghost" onClick={() => setC(config)}>
            還原
          </Btn>
        )}
      </div>
    </form>
  );
}

function KindsForm() {
  const { config } = useData();
  const [k, setK] = useState(() => Object.fromEntries(KIND_ORDER.map((key) => [key, { ...kindStyle(config, key) }])) as Record<KindKey, ReturnType<typeof kindStyle>>);
  const dirty = KIND_ORDER.some((key) => {
    const a = k[key];
    const b = kindStyle(config, key);
    return a.emoji !== b.emoji || a.color !== b.color || a.headline !== b.headline;
  });
  return (
    <div class="stack">
      <div class="kinds-table">
        {KIND_ORDER.map((key) => (
          <div class="kt-row" key={key}>
            <span class="kind-tag" style={{ '--k': k[key].color } as any}>
              {k[key].emoji} {KINDS[key].label}
            </span>
            <input class="input sm" aria-label={`${KINDS[key].label} 的圖示`} value={k[key].emoji} maxLength={4} onInput={(e) => setK((x) => ({ ...x, [key]: { ...x[key], emoji: (e.target as HTMLInputElement).value } }))} />
            <input class="input sm" aria-label={`${KINDS[key].label} 的標題列`} value={k[key].headline} maxLength={20} onInput={(e) => setK((x) => ({ ...x, [key]: { ...x[key], headline: (e.target as HTMLInputElement).value } }))} />
            <input class="color" type="color" aria-label={`${KINDS[key].label} 的顏色`} value={k[key].color} onInput={(e) => setK((x) => ({ ...x, [key]: { ...x[key], color: (e.target as HTMLInputElement).value } }))} />
          </div>
        ))}
      </div>
      <div class="row">
        <Btn
          variant="primary"
          disabled={!dirty}
          onClick={() =>
            saveConfig(
              'Cue：更新公告類型樣式',
              (cfg) => ({
                ...cfg,
                kinds: Object.fromEntries(
                  KIND_ORDER.map((key) => {
                    const d = KINDS[key];
                    const v = k[key];
                    const o: Record<string, string> = {};
                    if (v.emoji.trim() && v.emoji !== d.emoji) o.emoji = v.emoji.trim();
                    if (v.color !== d.color) o.color = v.color;
                    if (v.headline.trim() && v.headline !== d.headline) o.headline = v.headline.trim();
                    return [key, o];
                  }).filter(([, o]) => Object.keys(o as object).length),
                ),
              }),
              '樣式已更新',
            )
          }
        >
          儲存樣式
        </Btn>
        <Btn variant="ghost" onClick={() => setK(Object.fromEntries(KIND_ORDER.map((key) => [key, { ...KINDS[key] }])) as any)}>
          恢復預設
        </Btn>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { config, posts, session, backend } = useData();
  const t = theme.use();
  const tz = config.timezone;
  const demo = backend?.kind === 'demo';

  function exportData() {
    const blob = new Blob([toJson({ exportedAt: isoLocal(Date.now(), tz), config, posts: { version: 1, posts } })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cue-backup-${dayKey(Date.now(), tz)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        const cfg = readConfig(JSON.stringify(raw.config ?? {}), config);
        const ps = readPosts(JSON.stringify(raw.posts ?? { posts: [] }));
        const ok = await confirm({
          title: '用備份取代目前的資料？',
          body: `備份裡有 ${cfg.channels.length} 個頻道、${ps.posts.length} 則貼文。目前的資料會被覆蓋${demo ? '' : '（GitHub 上的歷史仍然保留，可以找回）'}。Webhook 不在備份裡，需要的話要重新貼上。`,
          ok: '取代',
          danger: true,
        });
        if (ok) save({ message: 'Cue：從備份還原', config: () => cfg, posts: () => ps }, { ok: '已從備份還原' });
      } catch {
        toast('讀不懂這個檔案，請選擇 Cue 匯出的 JSON 備份。', { kind: 'error' });
      }
    };
    input.click();
  }

  const gh = session?.mode === 'github' ? session : null;
  const repoUrl = gh ? `https://github.com/${gh.owner}/${gh.repo}` : '';

  return (
    <div class="cue-page narrow enter">
      <PageHead title="設定" />

      <Section id="where" title="資料存在哪裡" sub={demo ? '示範模式：資料只存在這個瀏覽器，排程器是模擬的。' : '資料在你的 GitHub repository；所有裝置用同一份。'}>
        {demo ? (
          <div class="row wrap">
            <Btn
              variant="accent"
              icon="branch"
              onClick={() => {
                if (!PREVIEW) close();
                go('connect');
              }}
            >
              連接 GitHub 正式使用
            </Btn>
            <Btn
              icon="rotate"
              onClick={async () => {
                if (await confirm({ title: '重設示範資料？', body: '回到一開始的示範內容。', ok: '重設' })) restartDemo();
              }}
            >
              重設示範資料
            </Btn>
          </div>
        ) : (
          gh && (
            <div class="stack">
              <dl class="kv">
                <dt>Repository</dt>
                <dd>
                  <a href={repoUrl} target="_blank" rel="noopener noreferrer" class="mono">
                    {gh.owner}/{gh.repo}
                  </a>
                </dd>
                <dt>資料分支</dt>
                <dd>
                  <a href={`${repoUrl}/tree/${gh.branch}`} target="_blank" rel="noopener noreferrer" class="mono">
                    {gh.branch}
                  </a>
                  {' · '}
                  <a href={`${repoUrl}/commits/${gh.branch}`} target="_blank" rel="noopener noreferrer">
                    修改歷史
                  </a>
                </dd>
                <dt>權杖</dt>
                <dd class="mono">
                  {gh.token.slice(0, 11)}…{gh.token.slice(-4)}
                </dd>
              </dl>
              <div class="row wrap">
                <Btn icon="phone" onClick={() => openDialog('在其他裝置使用', (c) => <DeviceDialog session={gh} close={() => c()} />)}>
                  帶到手機
                </Btn>
                <Btn
                  variant="ghost"
                  icon="logout"
                  onClick={async () => {
                    if (await confirm({ title: '在這台裝置中斷連線？', body: '會忘記這台裝置上的權杖，GitHub 上的資料不受影響。', ok: '中斷連線', danger: true })) close();
                  }}
                >
                  中斷連線
                </Btn>
              </div>
            </div>
          )
        )}
      </Section>

      <Section id="course" title="課程" sub="出現在每則公告上的資訊。">
        <CourseForm />
      </Section>

      <Section id="kinds" title="公告類型的樣式" sub="每種公告的圖示、顏色與卡片上方的標題列。">
        <KindsForm />
      </Section>

      <Section id="scheduler" title="雲端排程器" sub="GitHub Actions 每 5 分鐘檢查一次。快到時間的公告會等到那一分鐘才送出，所以通常誤差在 1 分鐘內；GitHub 很忙時偶爾會晚幾分鐘。">
        <SchedulerCard compact />
        <Field label="太晚就不要發" help="排程器如果停擺太久，超過這個時間的公告會標成「已錯過」而不是突然一起送出。">
          <select
            class="select"
            style={{ maxWidth: '240px' }}
            value={config.staleMinutes}
            onChange={(e) => {
              const v = Number((e.target as HTMLSelectElement).value);
              save({ message: 'Cue：更新錯過時間的門檻', config: (c) => ({ ...c, staleMinutes: v }) }, { ok: '已更新' });
            }}
          >
            {[60, 180, 360, 720, 1440, 4320].map((m) => (
              <option key={m} value={m}>
                {m < 1440 ? `晚超過 ${m / 60} 小時` : `晚超過 ${m / 1440} 天`}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section id="look" title="外觀">
        <div style={{ maxWidth: '360px' }}>
          <Seg<ThemePref>
            label="主題"
            value={t}
            onChange={setTheme}
            options={[
              { value: 'system', label: '跟隨系統' },
              { value: 'light', label: '淺色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </div>
      </Section>

      <Section id="data" title="備份" sub={`目前有 ${config.channels.length} 個頻道、${posts.length} 則貼文。備份檔不含 Webhook 網址。`}>
        <div class="row wrap">
          {!PREVIEW && (
            <Btn icon="download" onClick={exportData}>
              匯出 JSON
            </Btn>
          )}
          <Btn icon="upload" variant="ghost" onClick={importData}>
            從備份還原
          </Btn>
        </div>
      </Section>

      <p class="tiny faint" style={{ textAlign: 'center' }}>
        Cue · 和 {PREVIEW ? 'Office Hour' : <a href="../">Office Hour</a>} 一起為 TN0006 打造 · 全程免費、沒有伺服器
      </p>
    </div>
  );
}
