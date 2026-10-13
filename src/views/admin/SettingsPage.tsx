import { useEffect, useState } from 'preact/hooks';
import type { AdminConfig, Settings } from '../../api/types';
import { useApi, useBusy, useLive } from '../../app/hooks';
import { minutesText } from '../../lib/format';
import { ask, confirm } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, Field, Loading, Switch, copyText } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';
import { inviteLink, prettyCode, rotateFlow } from './People';

export function SettingsPage() {
  const { data: cfg, error, reload } = useLive<AdminConfig>('oh_admin_config', {});
  if (!cfg) return error ? <ErrorState onRetry={reload} /> : <Loading />;
  return <SettingsView cfg={cfg} reload={reload} />;
}

function SettingsView({ cfg, reload }: { cfg: AdminConfig; reload: () => void }) {
  const { call } = useApi();
  const { busy, run } = useBusy();
  const [s, setS] = useState<Settings>(cfg.settings);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => setS(cfg.settings), [JSON.stringify(cfg.settings)]);
  const dirty = JSON.stringify(s) !== JSON.stringify(cfg.settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const r = await run('settings', () => call('oh_admin_save', { p_kind: 'settings', p: s }), { ok: '設定已儲存，所有人的畫面會立刻更新。' });
    if (r) reload();
  };

  const num = (k: 'lead_days' | 'week_cap' | 'day_cap' | 'cancel_hours', label: string, min: number, max: number, help: string) => (
    <Field label={label} help={help}>
      <input
        class="input mono"
        type="number"
        min={min}
        max={max}
        value={s[k]}
        onInput={(e) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) set(k, Math.max(min, Math.min(max, Math.round(v))));
        }}
      />
    </Field>
  );

  return (
    <main class="page narrow enter">
      <div class="stack tight">
        <p class="eyebrow">設定</p>
        <h1 class="title-l">課程與規則</h1>
      </div>

      <form
        class="stack loose"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section class="card pad-l stack">
          <h2 class="title-s">課程資訊</h2>
          <div class="row top wrap">
            <div style={{ width: '140px' }}>
              <Field label="課號">
                <input class="input mono" value={s.course_code} maxLength={20} onInput={(e) => set('course_code', (e.target as HTMLInputElement).value)} />
              </Field>
            </div>
            <div class="grow" style={{ minWidth: '220px' }}>
              <Field label="課名">
                <input class="input" value={s.course_title} maxLength={80} onInput={(e) => set('course_title', (e.target as HTMLInputElement).value)} />
              </Field>
            </div>
          </div>
          <div class="row top wrap">
            <div class="grow" style={{ minWidth: '180px' }}>
              <Field label="老師的稱呼" help="顯示給學生看，例如「叁式 PM」、「業師」。">
                <input class="input" value={s.host_label} maxLength={20} onInput={(e) => set('host_label', (e.target as HTMLInputElement).value)} />
              </Field>
            </div>
            <div class="grow" style={{ minWidth: '180px' }}>
              <Field label="地點">
                <input class="input" value={s.location} maxLength={60} onInput={(e) => set('location', (e.target as HTMLInputElement).value)} />
              </Field>
            </div>
          </div>
          <Field label="給學生的公告" optional help="會顯示在學生首頁最上方，例如期中週暫停、換地點。" count={s.notice.length} max={500}>
            <textarea class="textarea" value={s.notice} maxLength={500} rows={3} onInput={(e) => set('notice', (e.target as HTMLTextAreaElement).value)} />
          </Field>
        </section>

        <section class="card pad-l stack">
          <h2 class="title-s">預約規則</h2>
          <div class="row top wrap">
            <div class="grow" style={{ minWidth: '200px' }}>
              {num('week_cap', '每組每週上限（格）', 1, 8, `目前 = ${minutesText(s.week_cap * s.slot_minutes)}`)}
            </div>
            <div class="grow" style={{ minWidth: '200px' }}>
              {num('day_cap', '每組每天上限（格）', 1, 8, `目前 = ${minutesText(s.day_cap * s.slot_minutes)}`)}
            </div>
          </div>
          <div class="row top wrap">
            <div class="grow" style={{ minWidth: '200px' }}>
              {num('lead_days', '預約截止（天前）', 0, 60, '學生最晚要在當天的幾天前勾選。')}
            </div>
            <div class="grow" style={{ minWidth: '200px' }}>
              {num('cancel_hours', '學生可取消（小時前）', 0, 336, '超過這個時間，只能請助教取消。')}
            </div>
          </div>
          <Switch checked={s.show_teacher_names} onChange={(v) => set('show_teacher_names', v)} label={`讓學生看到是哪位${s.host_label}`} />
          <p class="tiny muted">每格固定 {s.slot_minutes} 分鐘。規則只影響之後的操作；已經排定的場次不會變動。</p>
        </section>

        <div class="row" style={{ position: 'sticky', bottom: '16px', justifyContent: 'flex-end' }}>
          {dirty && (
            <Btn variant="ghost" onClick={() => setS(cfg.settings)}>
              還原
            </Btn>
          )}
          <Btn type="submit" variant="primary" size="lg" icon="check" disabled={!dirty} loading={busy === 'settings'}>
            儲存設定
          </Btn>
        </div>
      </form>

      <section class="section" aria-labelledby="s-admins">
        <div class="section-head">
          <h2 id="s-admins">助教帳號</h2>
          <Btn
            size="sm"
            icon="plus"
            onClick={async () => {
              const name = await ask({ title: '新增助教', label: '名字', maxLength: 40, ok: '新增', body: '會產生一組新的助教代碼，請私下交給對方。' });
              if (!name) return;
              await run('admin', () => call('oh_admin_save', { p_kind: 'admin', p: { name } }), { ok: '已新增助教。' });
              reload();
            }}
          >
            新增助教
          </Btn>
        </div>
        <div class="notice warn">
          <Icon name="alert" />
          <span class="small">助教代碼等同管理權限，請不要貼到公開頻道。有疑慮時可以隨時更換。</span>
        </div>
        <div class="list">
          {cfg.admins.map((a) => (
            <div class="li" key={a.id} style={{ flexWrap: 'wrap' }}>
              <div class="grow stack" style={{ gap: '0px', minWidth: '140px' }}>
                <b>
                  {a.name} {a.me && <span class="chip">你</span>}
                </b>
                <span class="tiny muted">{a.devices} 台裝置登入中</span>
              </div>
              <span class="mono small" style={{ letterSpacing: '0.08em' }}>
                {shown === a.id ? prettyCode(a.code) : '••••-••••-••••'}
              </span>
              <Btn size="sm" variant="ghost" onClick={() => setShown(shown === a.id ? null : a.id)}>
                {shown === a.id ? '隱藏' : '顯示'}
              </Btn>
              <Btn size="sm" icon="copy" onClick={() => copyText(inviteLink(a.code), '已複製登入連結')}>
                登入連結
              </Btn>
              <Btn
                size="sm"
                variant="ghost"
                icon="rotate"
                aria-label="更換代碼"
                onClick={async () => {
                  await rotateFlow('admin', a.me ? '你自己' : a.name, run, call, a.id);
                  reload();
                }}
              />
              {!a.me && (
                <Btn
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label="刪除助教"
                  onClick={async () => {
                    if (!(await confirm({ title: `刪除助教「${a.name}」？`, body: '對方的所有裝置會立刻登出。', ok: '刪除', danger: true }))) return;
                    await run('del', () => call('oh_admin_delete', { p_kind: 'admin', p_id: a.id }), { ok: '已刪除。' });
                    reload();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
