// The cloud scheduler's health, everywhere it matters: is it installed, is
// it enabled, when did it last run, did that run go well.

import { useEffect } from 'preact/hooks';
import { store } from '../../app/store';
import { Icon } from '../../ui/icons';
import { Btn } from '../../ui/base';
import { toast } from '../../ui/toast';
import { app, errorText, kick } from '../app/state';
import type { Backend, SchedulerStatus } from '../data/backend';
import { fmtRelative } from '../core/time';
import { useNow } from '../ui/parts';

export const scheduler = store<{ value: SchedulerStatus | null; error: string | null; backend: Backend | null }>({ value: null, error: null, backend: null });

let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshScheduler() {
  const b = app.get().backend;
  if (!b) return;
  try {
    const value = await b.scheduler();
    scheduler.set({ value, error: null, backend: b });
  } catch (e) {
    scheduler.set({ value: null, error: errorText(e), backend: b });
  }
}

/** One poller per backend, shared by every component that shows the status. */
export function useScheduler() {
  const st = scheduler.use();
  const { backend } = app.use();
  useEffect(() => {
    if (!backend) return;
    if (scheduler.get().backend !== backend) {
      scheduler.set({ value: null, error: null, backend });
      refreshScheduler();
    }
    if (!timer) timer = setInterval(refreshScheduler, 60000);
  }, [backend]);
  return st.backend === backend ? st : { value: null, error: null, backend };
}

export function SchedulerMini() {
  const { value, error } = useScheduler();
  const now = useNow(30000);
  let tone = 'connecting';
  let text = '雲端排程器 · 檢查中';
  if (error) {
    tone = 'offline';
    text = '排程器狀態無法讀取';
  } else if (value && !value.installed) {
    tone = 'offline';
    text = '雲端排程器尚未安裝';
  } else if (value && !value.enabled) {
    tone = 'offline';
    text = '雲端排程器已停用';
  } else if (value?.lastRun) {
    tone = value.lastRun.ok === false ? 'offline' : '';
    text = value.lastRun.running ? '排程器執行中…' : `排程器 · ${fmtRelative(value.lastRun.at, now)}執行`;
  } else if (value) {
    tone = '';
    text = '雲端排程器待命中';
  }
  return (
    <a class={`live ${tone}`} href="#/settings" style={{ textDecoration: 'none' }} title="GitHub Actions 每 5 分鐘檢查一次要發的公告">
      <i aria-hidden="true" />
      {text}
    </a>
  );
}

export function SchedulerCard({ compact }: { compact?: boolean }) {
  const { value, error } = useScheduler();
  const { backend } = app.use();
  const now = useNow(15000);
  const demo = backend?.kind === 'demo';
  const run = value?.lastRun;
  let state: { icon: 'okCircle' | 'alert' | 'clock' | 'xCircle'; title: string; body: string; tone: string };
  if (error) state = { icon: 'alert', title: '讀不到排程器狀態', body: error, tone: 'warn' };
  else if (!value) state = { icon: 'clock', title: '檢查中…', body: '', tone: '' };
  else if (!value.installed)
    state = {
      icon: 'xCircle',
      title: '雲端排程器還沒安裝',
      body: '把 Cue 的程式碼合併到預設分支（main）後，GitHub Actions 會每 5 分鐘自動檢查並發送。在那之前排程會先存著。',
      tone: 'warn',
    };
  else if (!value.enabled)
    state = { icon: 'alert', title: '雲端排程器被停用了', body: 'GitHub 會停用 60 天沒有活動的排程。按「啟用」就能恢復。', tone: 'warn' };
  else if (run?.ok === false) state = { icon: 'alert', title: '上一次執行有失敗', body: '有公告沒送出去，請到「發文紀錄 → 需要處理」查看原因。', tone: 'warn' };
  else
    state = {
      icon: 'okCircle',
      title: demo ? '模擬排程器運作中' : '雲端排程器運作中',
      body: demo
        ? '示範模式用瀏覽器模擬 GitHub Actions：到了時間就「發送」，但不會真的送到 Discord。'
        : `GitHub Actions 每 5 分鐘檢查一次；快到時間的公告會等到那一分鐘才送出。${run ? `上次執行：${fmtRelative(run.at, now)}。` : ''}`,
      tone: 'ok',
    };
  return (
    <div class={`card sched ${compact ? 'tight' : ''}`}>
      <div class="row top" style={{ gap: '12px' }}>
        <span class={`sched-icon ${state.tone}`}>
          <Icon name={state.icon} size={20} />
        </span>
        <div class="stack tight grow">
          <div class="title-s">{state.title}</div>
          {state.body && <p class="small muted">{state.body}</p>}
          <div class="row wrap" style={{ marginTop: '4px' }}>
            {value?.installed && value.enabled && (
              <Btn
                size="sm"
                icon="play"
                onClick={async () => {
                  if (await kick('manual')) {
                    toast(demo ? '模擬排程器馬上執行。' : '已請 GitHub Actions 立刻執行，約 30 秒內完成。');
                    setTimeout(refreshScheduler, 4000);
                  }
                }}
              >
                立即執行一次
              </Btn>
            )}
            {value?.installed && !value.enabled && backend?.enableScheduler && (
              <Btn
                size="sm"
                variant="accent"
                icon="play"
                onClick={async () => {
                  try {
                    await backend.enableScheduler!();
                    toast('排程器已重新啟用。');
                    refreshScheduler();
                  } catch (e) {
                    toast(errorText(e), { kind: 'error' });
                  }
                }}
              >
                啟用
              </Btn>
            )}
            {!demo && (run?.url || value?.url) && (
              <a class="btn sm ghost" href={run?.url ?? value?.url} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={16} />
                執行紀錄
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
