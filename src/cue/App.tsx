import type { ComponentChildren } from 'preact';
import { useEffect, useErrorBoundary } from 'preact/hooks';
import { go, href, route } from '../app/router';
import { closeAllDialogs, Dialogs } from '../ui/dialog';
import { Icon, type IconName } from '../ui/icons';
import { Btn, Loading } from '../ui/base';
import { toast, Toasts } from '../ui/toast';
import { app, close, errorText, initialize, open, readDeviceLink, restartDemo } from './app/state';
import { Brand, SyncBadge } from './ui/parts';
import { CalendarPage } from './views/Calendar';
import { ChannelsPage } from './views/Channels';
import { ComposePage } from './views/Compose';
import { Overview } from './views/Overview';
import { PostsPage } from './views/Posts';
import { SettingsPage } from './views/Settings';
import { Connect, Welcome } from './views/Welcome';
import { SchedulerMini } from './views/Scheduler';
import { useShortcuts } from './ui/shortcuts';

const NAV: Array<{ id: string; label: string; icon: IconName }> = [
  { id: '', label: '總覽', icon: 'home' },
  { id: 'posts', label: '發文紀錄', icon: 'list' },
  { id: 'calendar', label: '行事曆', icon: 'calendar' },
  { id: 'channels', label: '頻道', icon: 'hash' },
  { id: 'settings', label: '設定', icon: 'settings' },
];
const TABS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: '', label: '總覽', icon: 'home' },
  { id: 'posts', label: '紀錄', icon: 'list' },
  { id: 'compose', label: '撰寫', icon: 'plus' },
  { id: 'calendar', label: '行事曆', icon: 'calendar' },
  { id: 'channels', label: '頻道', icon: 'hash' },
];

/** A bug in one screen should never leave a blank page. */
function Guard({ children, reset }: { children: ComponentChildren; reset: string }) {
  const [error, retry] = useErrorBoundary((e) => console.error(e));
  useEffect(() => {
    if (error) retry();
  }, [reset]);
  if (!error) return <>{children}</>;
  return (
    <div class="center-screen">
      <div class="stack" style={{ justifyItems: 'center', maxWidth: '380px' }}>
        <p class="title-m">這個畫面出了點問題</p>
        <p class="small muted">資料都還在。重新整理通常就能解決。</p>
        <div class="row">
          <Btn variant="primary" icon="rotate" onClick={() => location.reload()}>
            重新整理
          </Btn>
          <Btn onClick={() => retry()}>再試一次</Btn>
        </div>
      </div>
    </div>
  );
}

function DemoBanner() {
  return (
    <div class="cue-banner" role="region" aria-label="示範模式">
      <Icon name="play" size={14} />
      <span class="grow">
        示範模式<span class="hide-s"> · 資料只存在這個瀏覽器，不會真的送到 Discord</span>
      </span>
      <button type="button" class="btn sm" onClick={restartDemo}>
        重設
      </button>
      <a class="btn sm solid" href={href('connect')} onClick={() => close()}>
        正式使用
      </a>
    </div>
  );
}

function Shell({ r }: { r: string[] }) {
  const { posts, backend } = app.use();
  const section = ['compose', 'posts', 'calendar', 'channels', 'settings'].includes(r[0]) ? r[0] : '';
  const attention = posts.filter((p) => p.status === 'failed' || p.status === 'missed').length;
  useShortcuts();

  let body;
  switch (section) {
    case 'compose':
      body = <ComposePage key={r[1] ?? 'new'} postId={r[1] ?? null} />;
      break;
    case 'posts':
      body = <PostsPage filter={r[1] ?? null} />;
      break;
    case 'calendar':
      body = <CalendarPage month={r[1] ?? null} />;
      break;
    case 'channels':
      body = <ChannelsPage />;
      break;
    case 'settings':
      body = <SettingsPage />;
      break;
    default:
      body = <Overview />;
  }

  return (
    <>
      {backend?.kind === 'demo' && <DemoBanner />}
      <div class="cue-shell">
        <aside class="cue-side" aria-label="主選單">
          <a href={href('')} style={{ textDecoration: 'none', color: 'inherit' }}>
            <Brand />
          </a>
          <a class={`btn accent block compose-btn`} href={href('compose')} aria-current={section === 'compose' ? 'page' : undefined}>
            <Icon name="pen" />
            撰寫公告
          </a>
          <nav>
            {NAV.map((n) => (
              <a key={n.id} class="nav-a" href={href(n.id)} aria-current={section === n.id ? 'page' : undefined}>
                <Icon name={n.icon} />
                {n.label}
                {n.id === 'posts' && attention > 0 && (
                  <span class="count" title={`${attention} 則需要處理`}>
                    {attention}
                  </span>
                )}
              </a>
            ))}
          </nav>
          <div class="foot">
            <SchedulerMini />
            <SyncBadge />
            {backend?.kind === 'github' && (
              <a class="where" href={`https://github.com/${backend.label}`} target="_blank" rel="noopener noreferrer">
                <Icon name="branch" size={15} />
                <span>{backend.label}</span>
              </a>
            )}
          </div>
        </aside>
        <div class="cue-main">
          <header class="topbar cue-top">
            <div class="topbar-inner">
              <a href={href('')} style={{ textDecoration: 'none', color: 'inherit' }}>
                <Brand />
              </a>
              <span class="grow" />
              <SyncBadge />
              <a class="btn ghost icon" href={href('settings')} aria-label="設定" aria-current={section === 'settings' ? 'page' : undefined}>
                <Icon name="settings" />
              </a>
            </div>
          </header>
          <main id="main">{body}</main>
        </div>
        <nav class="cue-tabs" aria-label="主選單">
          {TABS.map((t) => (
            <a key={t.id} href={href(t.id)} class={t.id === 'compose' ? 'plus' : ''} aria-current={section === t.id ? 'page' : undefined} aria-label={t.id === 'compose' ? t.label : undefined}>
              {t.id === 'compose' ? (
                <span class="fab">
                  <Icon name="plus" size={24} />
                </span>
              ) : (
                <Icon name={t.icon} size={22} />
              )}
              {t.id !== 'compose' && <span>{t.label}</span>}
              {t.id === 'posts' && attention > 0 && <span class="count">{attention}</span>}
            </a>
          ))}
        </nav>
      </div>
    </>
  );
}

function InitData() {
  const { session } = app.use();
  if (!session || session.mode !== 'github') return null;
  return (
    <div class="center-screen">
      <div class="card pad-l stack" style={{ maxWidth: '520px', textAlign: 'left' }}>
        <Brand sub={`${session.owner}/${session.repo}`} />
        <h1 class="title-m">建立 Cue 的資料分支</h1>
        <p class="muted">
          Cue 會在這個 repository 新增一個叫 <code class="mono">{session.branch}</code> 的分支，存放頻道設定與所有貼文（兩個 JSON 檔）。之後每一次修改都是一個 commit，所以它也是完整的發文紀錄。
        </p>
        <p class="small muted">不會動到任何現有的分支或檔案。</p>
        <div class="row wrap">
          <Btn
            variant="accent"
            icon="branch"
            onClick={async (e) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.disabled = true;
              try {
                await initialize();
                toast('資料分支建立好了，接著新增第一個頻道吧。');
                go('channels');
              } catch (err) {
                toast(errorText(err), { kind: 'error' });
                b.disabled = false;
              }
            }}
          >
            建立資料分支
          </Btn>
          <Btn variant="ghost" onClick={() => close()}>
            換一個 repository
          </Btn>
        </div>
      </div>
    </div>
  );
}

function ConnectError() {
  const { error, session } = app.use();
  return (
    <div class="center-screen">
      <div class="card pad-l stack" style={{ maxWidth: '500px', textAlign: 'left' }}>
        <Brand sub={session && session.mode === 'github' ? `${session.owner}/${session.repo}` : undefined} />
        <h1 class="title-m">連不上資料</h1>
        <p class="muted">{error}</p>
        <div class="row wrap">
          <Btn variant="primary" icon="rotate" onClick={() => session && open(session)}>
            再試一次
          </Btn>
          <Btn
            icon="key"
            onClick={() => {
              close();
              go('connect');
            }}
          >
            重新連線
          </Btn>
          <Btn variant="ghost" icon="play" onClick={() => open({ mode: 'demo' })}>
            先用示範模式
          </Btn>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const st = app.use();
  const r = route.use();

  // a dialog belongs to the page it was opened on
  useEffect(() => closeAllDialogs(), [r.join('/')]);

  // a device link: #/link/<payload>
  useEffect(() => {
    if (r[0] !== 'link' || !r[1]) return;
    const s = readDeviceLink(r[1]);
    go('', { replace: true });
    if (!s) {
      toast('這個連結無效或已損毀。', { kind: 'error' });
      return;
    }
    open(s).then(() => {
      if (app.get().phase === 'ready') toast(`這台裝置已連上 ${s.owner}/${s.repo}`);
    });
  }, [r[0], r[1]]);

  // #/demo opens the sandbox directly (for judges and screenshots)
  useEffect(() => {
    if (r[0] === 'demo' && st.session?.mode !== 'demo') {
      go('', { replace: true });
      open({ mode: 'demo' });
    }
  }, [r[0]]);

  let body;
  if (st.phase === 'ready') body = <Shell r={r} />;
  else if (st.phase === 'loading') body = <Loading label="正在載入資料…" />;
  else if (st.phase === 'needs-init') body = <InitData />;
  else if (st.phase === 'error') body = <ConnectError />;
  else if (r[0] === 'connect') body = <Connect />;
  else body = <Welcome />;

  return (
    <>
      <Guard reset={r.join('/') + st.phase}>{body}</Guard>
      <Toasts />
      <Dialogs />
    </>
  );
}
