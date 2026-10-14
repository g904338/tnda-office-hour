// The front door: what Cue does, a live try-it-now, and the two ways in —
// the demo (nothing to set up) or connecting a GitHub repository.

import { useMemo, useState } from 'preact/hooks';
import { go, href } from '../../app/router';
import { Icon, type IconName } from '../../ui/icons';
import { Btn, Field } from '../../ui/base';
import { open, type GitHubSession } from '../app/state';
import { defaultConfig, kindStyle } from '../core/model';
import { parse } from '../core/parse';
import { renderPayload } from '../core/render';
import { fmtDateTime } from '../core/time';
import { GitHub, GitHubError, parseRepo, repoFromPagesUrl, tokenTemplateUrl } from '../data/github';
import { DiscordPreview } from '../ui/DiscordPreview';
import { Brand } from '../ui/parts';
import { samples } from '../ui/samples';

const TZ = 'Asia/Taipei';
const DEFAULT_REPO = 'g904338/tnda-office-hour';

const FEATURES: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'spark', title: '貼上就整理好', body: '自動找出日期、時間、地點、連結和注意事項，連「下週五晚上 12 點前」都看得懂。寫錯星期幾也會提醒你。' },
  { icon: 'hash', title: '一次發到多個頻道', body: '公告、作業、上課提醒各有各的頻道。勾選要發的頻道，Cue 分別送出、分別追蹤結果。' },
  { icon: 'bell', title: '一則公告，一串提醒', body: '作業公告今天發、截止前一晚再提醒、最後三小時再催一次。每週上課提醒設一次就整學期自動跑。' },
  { icon: 'calendar', title: '行事曆與發文紀錄', body: '所有發過、要發的公告一覽無遺。在行事曆上拖一下就能改發送日期。' },
  { icon: 'undo', title: '發錯了也能收回', body: '已經送出的訊息可以直接從 Discord 撤回，或改內容後同步更新。' },
  { icon: 'branch', title: '資料在你的 GitHub', body: '每一次修改都是一個 commit，自帶完整歷史。換電腦、用手機，資料都在。' },
  { icon: 'shield', title: 'Webhook 加密保存', body: 'Discord Webhook 網址在瀏覽器裡就加密，存進 GitHub Secrets，連公開 repo 也看不到。' },
  { icon: 'cloud', title: '全程免費、不用伺服器', body: 'GitHub Pages 放網站、GitHub Actions 準時發送。沒有月費，也沒有要維護的主機。' },
];

function TryIt() {
  const now = useMemo(() => Date.now(), []);
  const list = useMemo(() => samples(now, TZ), [now]);
  const [text, setText] = useState(list[0].text);
  const [picked, setPicked] = useState(list[0].id);
  const config = useMemo(() => ({ ...defaultConfig(), course: 'TN0006 跨域數位製作實務', footer: 'TN0006 跨域數位製作實務', username: '課程助教' }), []);
  const parsed = useMemo(() => parse(text, { now, tz: TZ }), [text, now]);
  const payload = useMemo(
    () => renderPayload({ content: parsed.content, style: 'embed', mention: parsed.mention ?? { type: 'none' }, config, label: null }),
    [parsed, config],
  );
  const k = kindStyle(config, parsed.content.kind);
  return (
    <div class="tryit">
      <div class="tryit-in">
        <div class="row between">
          <span class="eyebrow">你貼上的</span>
          <div class="row" role="group" aria-label="範例">
            {list.map((s) => (
              <button
                type="button"
                key={s.id}
                class="pill"
                aria-pressed={picked === s.id}
                onClick={() => {
                  setText(s.text);
                  setPicked(s.id);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          class="textarea"
          rows={6}
          value={text}
          aria-label="試著貼上一段公告"
          onInput={(e) => {
            setText((e.target as HTMLTextAreaElement).value);
            setPicked('');
          }}
        />
        <div class="found" aria-live="polite">
          <span class="kind-tag" style={{ '--k': k.color } as any}>
            {k.emoji} {k.label}
          </span>
          {parsed.content.when && (
            <span class="chip">
              <Icon name="clock" size={13} />
              {fmtDateTime(Date.parse(parsed.content.when.at), TZ, now)}
            </span>
          )}
          {parsed.content.place && (
            <span class="chip">
              <Icon name="pin" size={13} />
              {parsed.content.place.value}
            </span>
          )}
          {parsed.content.links.length > 0 && (
            <span class="chip">
              <Icon name="link" size={13} />
              {parsed.content.links.length} 個連結
            </span>
          )}
          {parsed.warnings.map((w) => (
            <span class="chip warn" key={w}>
              <Icon name="alert" size={13} />
              {w}
            </span>
          ))}
        </div>
      </div>
      <div class="tryit-arrow" aria-hidden="true">
        <Icon name="down" size={20} />
        Cue 整理成
      </div>
      <DiscordPreview payload={payload} config={config} theme="dark" channel={SAMPLE_CHANNEL} now={now} />
    </div>
  );
}

const SAMPLE_CHANNEL = {
  id: 'ch_demo',
  name: '作業繳交',
  emoji: '📝',
  color: '#f59e0b',
  note: '',
  secret: '',
  webhookSavedAt: null,
  webhookHint: '',
  username: '',
  avatar: '',
  mention: { type: 'none' as const },
  discord: null,
  test: null,
};

export function Welcome() {
  return (
    <div class="welcome-cue">
      <header class="topbar">
        <div class="topbar-inner" style={{ maxWidth: '1200px' }}>
          <Brand />
          <span class="grow" />
          <a class="btn sm ghost" href={href('connect')}>
            連接 GitHub
          </a>
          <Btn size="sm" variant="accent" icon="play" onClick={() => open({ mode: 'demo' })}>
            試用
          </Btn>
        </div>
      </header>

      <section class="hero-cue">
        <div class="hero-copy enter">
          <span class="eyebrow">給助教與老師的 Discord 公告排程</span>
          <h1 class="title-xl">
            公告，
            <br />
            準時登場。
          </h1>
          <p class="lead">把上課提醒、作業公告直接貼進來。Cue 會整理成 Discord 的格式，在你指定的時間送到對的頻道——你只要按一次「排程」。</p>
          <div class="row wrap">
            <Btn variant="accent" size="lg" icon="play" onClick={() => open({ mode: 'demo' })}>
              立即試用，不用註冊
            </Btn>
            <a class="btn lg" href={href('connect')}>
              <Icon name="branch" />
              連接 GitHub 正式使用
            </a>
          </div>
          <p class="small muted row wrap" style={{ gap: '14px' }}>
            <span class="row" style={{ gap: '6px' }}>
              <Icon name="check" size={15} />
              全程免費
            </span>
            <span class="row" style={{ gap: '6px' }}>
              <Icon name="check" size={15} />
              資料存在你的 GitHub
            </span>
            <span class="row" style={{ gap: '6px' }}>
              <Icon name="check" size={15} />
              Webhook 加密保存
            </span>
          </p>
        </div>
        <TryIt />
      </section>

      <section class="how">
        <h2 class="title-l">三個步驟，之後交給 Cue</h2>
        <ol class="steps">
          <li>
            <span class="n">1</span>
            <div>
              <b>貼上</b>
              <p>從 LINE、Email、教學平台複製過來的文字直接貼上，不用整理格式。</p>
            </div>
          </li>
          <li>
            <span class="n">2</span>
            <div>
              <b>確認</b>
              <p>Cue 抓出時間、地點、連結，排成 Discord 卡片。旁邊就是學生會看到的樣子。</p>
            </div>
          </li>
          <li>
            <span class="n">3</span>
            <div>
              <b>排程</b>
              <p>選頻道和提醒時間。時間一到，GitHub Actions 自動送出，結果記在發文紀錄裡。</p>
            </div>
          </li>
        </ol>
        <div class="arch" aria-label="架構：瀏覽器、GitHub、GitHub Actions、Discord">
          <div class="node">
            <Icon name="monitor" />
            <b>Cue 網頁</b>
            <span>GitHub Pages</span>
          </div>
          <div class="edge">
            <span>commit</span>
          </div>
          <div class="node">
            <Icon name="branch" />
            <b>你的 repository</b>
            <span>cue-data 分支 · Secrets</span>
          </div>
          <div class="edge">
            <span>每 5 分鐘</span>
          </div>
          <div class="node">
            <Icon name="clock" />
            <b>GitHub Actions</b>
            <span>雲端排程器</span>
          </div>
          <div class="edge">
            <span>Webhook</span>
          </div>
          <div class="node accent">
            <Icon name="chat" />
            <b>Discord</b>
            <span>各個頻道</span>
          </div>
        </div>
      </section>

      <section class="features">
        {FEATURES.map((f) => (
          <div class="feature" key={f.title}>
            <Icon name={f.icon} size={22} />
            <b>{f.title}</b>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section class="cta-end">
        <h2 class="title-l">下一則公告，交給 Cue。</h2>
        <div class="row wrap" style={{ justifyContent: 'center' }}>
          <Btn variant="accent" size="lg" icon="play" onClick={() => open({ mode: 'demo' })}>
            開始試用
          </Btn>
          <a class="btn lg" href={href('connect')}>
            連接 GitHub
          </a>
        </div>
      </section>

      <footer class="foot-cue">
        <span>Cue · TN0006 一場體驗如何發生：跨域數位製作實務</span>
        <a href="../">Office Hour 預約平台</a>
      </footer>
    </div>
  );
}

export function Connect() {
  const detected = repoFromPagesUrl(location.href);
  const [repo, setRepo] = useState(detected ? `${detected.owner}/${detected.repo}` : DEFAULT_REPO);
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const parsedRepo = parseRepo(repo);

  async function connect(e: Event) {
    e.preventDefault();
    if (!parsedRepo || !token.trim()) return;
    setBusy(true);
    setError(null);
    setNotes([]);
    const session: GitHubSession = { mode: 'github', ...parsedRepo, branch: 'cue-data', token: token.trim() };
    const gh = new GitHub(session.token, session);
    try {
      const info = await gh.repoInfo();
      const warn: string[] = [];
      if (info.permissions && !info.permissions.push) warn.push('你的帳號對這個 repository 沒有寫入權限。');
      try {
        await gh.listSecrets();
      } catch (x) {
        if (x instanceof GitHubError && x.code === 'forbidden') warn.push('權杖沒有 Secrets 權限：之後無法儲存 Discord Webhook。');
        else throw x;
      }
      if (warn.length) {
        setNotes(warn);
        setBusy(false);
        return;
      }
      await open(session);
      go('', { replace: true });
    } catch (x) {
      setError(x instanceof GitHubError && x.code === 'notfound' ? '找不到這個 repository，或權杖沒有被授權存取它（建立權杖時要在 Repository access 選它）。' : x instanceof Error ? x.message : String(x));
      setBusy(false);
    }
  }

  return (
    <div class="connect-wrap">
      <header class="topbar">
        <div class="topbar-inner" style={{ maxWidth: '1200px' }}>
          <a href={href('')} style={{ textDecoration: 'none', color: 'inherit' }}>
            <Brand />
          </a>
          <span class="grow" />
          <Btn size="sm" variant="ghost" icon="play" onClick={() => open({ mode: 'demo' })}>
            先用示範
          </Btn>
        </div>
      </header>
      <form class="card pad-l connect stack loose" onSubmit={connect}>
        <div class="stack tight">
          <span class="eyebrow">正式使用</span>
          <h1 class="title-l">連接你的 GitHub</h1>
          <p class="muted">Cue 沒有伺服器：資料存在你的 repository，排程交給 GitHub Actions。只需要一組權杖讓這個網頁代你存取。</p>
        </div>

        <ol class="connect-steps">
          <li>
            <Field label="Repository" help="放 Cue 程式碼的那一個，排程器也在這裡執行。" error={repo && !parsedRepo ? '格式是 帳號/名稱，例如 g904338/tnda-office-hour' : null}>
              <input class="input mono" value={repo} onInput={(e) => setRepo((e.target as HTMLInputElement).value)} autocomplete="off" spellcheck={false} />
            </Field>
          </li>
          <li class="stack">
            <div class="stack tight">
              <span class="title-s">建立存取權杖</span>
              <p class="small muted">按下面的按鈕，GitHub 會打開一張已經勾好權限的表單（Contents、Actions、Secrets 讀寫）。你只要：</p>
              <ol class="small muted mini-steps">
                <li>
                  在 <b>Repository access</b> 選「Only select repositories」，選 <code class="mono">{parsedRepo?.repo ?? 'repository'}</code>
                </li>
                <li>確認權限後按 <b>Generate token</b>，複製那串 github_pat_… 文字</li>
              </ol>
            </div>
            <a class="btn" href={tokenTemplateUrl(parsedRepo?.repo ?? 'repo')} target="_blank" rel="noopener noreferrer">
              <Icon name="key" />
              在 GitHub 建立權杖
              <Icon name="external" size={16} />
            </a>
          </li>
          <li>
            <Field label="貼上權杖" help="只存在這台裝置的瀏覽器。連上之後可以在設定裡用 QR code 把連線帶到手機。">
              <div class="row" style={{ gap: '6px' }}>
                {show ? (
                  <input class="input mono grow" type="text" aria-label="存取權杖" value={token} placeholder="github_pat_…" autocomplete="off" spellcheck={false} onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
                ) : (
                  <input class="input mono grow" type="password" aria-label="存取權杖" value={token} placeholder="github_pat_…" autocomplete="off" spellcheck={false} onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
                )}
                <Btn variant="ghost" icon="eye" aria-label={show ? '隱藏權杖' : '顯示權杖'} onClick={() => setShow(!show)} />
              </div>
            </Field>
          </li>
        </ol>

        {error && (
          <div class="notice warn" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}
        {notes.length > 0 && (
          <div class="notice warn" role="alert">
            <Icon name="alert" />
            <div class="stack tight">
              {notes.map((n) => (
                <span key={n}>{n}</span>
              ))}
              <span class="small">請重新建立一組權杖，或仍要繼續：</span>
              <div>
                <Btn
                  size="sm"
                  onClick={async () => {
                    await open({ mode: 'github', ...parsedRepo!, branch: 'cue-data', token: token.trim() });
                    go('', { replace: true });
                  }}
                >
                  仍然連接
                </Btn>
              </div>
            </div>
          </div>
        )}

        <div class="row between wrap">
          <span class="small muted row" style={{ gap: '6px' }}>
            <Icon name="lock" size={15} />
            權杖不會離開這台裝置，除了直接傳給 GitHub。
          </span>
          <Btn type="submit" variant="accent" size="lg" loading={busy} disabled={!parsedRepo || !token.trim()}>
            連接
          </Btn>
        </div>
      </form>
    </div>
  );
}
