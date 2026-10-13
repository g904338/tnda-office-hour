import type { AdminConfig, ConfigGroup, ConfigTeacher } from '../../api/types';
import { useApi, useBusy, useLive, useTick } from '../../app/hooks';
import { agoText } from '../../lib/time';
import { ask, confirm, openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icons';
import { Btn, CopyBtn, Empty, Loading, Menu, QR, Switch, copyText } from '../../ui/kit';
import { ErrorState } from '../student/StudentApp';
import { siteUrl } from './common';

export const inviteLink = (code: string) => `${siteUrl()}#/join/${code}`;
export const prettyCode = (code: string) => code.replace(/(.{4})(?=.)/g, '$1-');

function useConfig() {
  return useLive<AdminConfig>('oh_admin_config', {});
}

async function rotateFlow(kind: 'group' | 'teacher' | 'admin', label: string, run: ReturnType<typeof useBusy>['run'], call: ReturnType<typeof useApi>['call'], id: number) {
  const choice = await openDialog<'keep' | 'revoke'>('更換代碼', (close) => (
    <>
      <h2>更換{label}的代碼？</h2>
      <p class="muted small">舊代碼和舊的邀請連結會立刻失效。已經登入的裝置要不要一起登出？</p>
      <div class="actions">
        <button type="button" class="btn" onClick={() => close()}>
          取消
        </button>
        <button type="button" class="btn" onClick={() => close('keep')}>
          更換，保留已登入裝置
        </button>
        <button type="button" class="btn danger" onClick={() => close('revoke')}>
          更換並全部登出
        </button>
      </div>
    </>
  ));
  if (!choice) return null;
  return run('rotate', () => call<{ code: string; revoked: number }>('oh_admin_rotate', { p_kind: kind, p_id: id, p_revoke: choice === 'revoke' }), {
    ok: choice === 'revoke' ? '已更換代碼，並登出所有裝置。' : '已更換代碼。',
  });
}

export function GroupsPage() {
  const { data: cfg, error, reload } = useConfig();
  const { call } = useApi();
  const { busy, run } = useBusy();
  const now = useTick();
  if (!cfg) return error ? <ErrorState onRetry={reload} /> : <Loading />;

  const save = async (p: Record<string, unknown>, ok?: string) => {
    const r = await run('save', () => call('oh_admin_save', { p_kind: 'group', p }), { ok });
    reload();
    return r;
  };

  const add = async () => {
    const name = await ask({ title: '新增小組', label: '組名', placeholder: '可以之後再改', optional: true, maxLength: 40, ok: '新增' });
    if (name === null) return;
    await save({ name }, '已新增小組。');
  };

  const wall = () =>
    openDialog(
      '所有小組的邀請 QR Code',
      (close) => (
        <>
          <div class="row between no-print">
            <h2>邀請 QR Code</h2>
            <div class="row">
              <Btn icon="print" onClick={() => window.print()}>
                列印
              </Btn>
              <Btn variant="primary" onClick={() => close()}>
                關閉
              </Btn>
            </div>
          </div>
          <p class="muted small no-print">可以直接投影在教室，各組用手機掃描自己的 QR Code 加入。</p>
          <div class="qr-wall">
            {cfg.groups
              .filter((g) => g.active)
              .map((g) => (
                <div class="card" key={g.id}>
                  <div class="row" style={{ justifyContent: 'center' }}>
                    <span class="gno">{g.no}</span>
                    <b>{g.name || `第 ${g.no} 組`}</b>
                  </div>
                  <QR text={inviteLink(g.code)} label={`第 ${g.no} 組邀請 QR Code`} />
                  <span class="mono" style={{ letterSpacing: '0.1em' }}>
                    {prettyCode(g.code)}
                  </span>
                </div>
              ))}
          </div>
        </>
      ),
      { wide: 'xwide' },
    );

  return (
    <main class="page enter">
      <div class="row between wrap">
        <div class="stack tight">
          <p class="eyebrow">小組與邀請</p>
          <h1 class="title-l">{cfg.groups.length} 個小組</h1>
          <p class="muted small" style={{ maxWidth: 560 }}>
            每組一個邀請代碼。把邀請連結貼到各組的 Discord，同學點開、輸入名字就能加入，整組共用同一份預約。
          </p>
        </div>
        <div class="row wrap">
          <Btn icon="qr" onClick={wall}>
            投影邀請 QR
          </Btn>
          <Btn variant="primary" icon="plus" loading={busy === 'save'} onClick={add}>
            新增小組
          </Btn>
        </div>
      </div>
      <div class="qr-wall" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {cfg.groups.map((g) => (
          <GroupCard key={g.id} g={g} now={now} save={save} reload={reload} />
        ))}
      </div>
    </main>
  );
}

function GroupCard({ g, now, save, reload }: { g: ConfigGroup; now: number; save: (p: Record<string, unknown>, ok?: string) => Promise<unknown>; reload: () => void }) {
  const { call } = useApi();
  const { run } = useBusy();
  const link = inviteLink(g.code);
  return (
    <div class="card stack" style={{ textAlign: 'left', opacity: g.active ? 1 : 0.6 }}>
      <div class="row between">
        <span class="row" style={{ gap: 10 }}>
          <span class="gno lg">{g.no}</span>
          <b>{g.name || <span class="muted">未命名</span>}</b>
        </span>
        <Menu label={`第 ${g.no} 組選單`} trigger={<Icon name="more" />}>
          {(close) => (
            <>
              <button
                type="button"
                class="mi"
                role="menuitem"
                onClick={async () => {
                  close();
                  const name = await ask({ title: `第 ${g.no} 組的組名`, label: '組名', initial: g.name, optional: true, maxLength: 40, ok: '儲存' });
                  if (name !== null) save({ id: g.id, name }, '已更新。');
                }}
              >
                <Icon name="edit" /> 修改組名
              </button>
              <button
                type="button"
                class="mi"
                role="menuitem"
                onClick={async () => {
                  close();
                  const v = await ask({ title: '修改組別編號', label: '編號（1–999）', initial: String(g.no), maxLength: 3, ok: '儲存' });
                  if (v === null) return;
                  const n = Number(v);
                  if (!Number.isInteger(n) || n < 1 || n > 999) return;
                  save({ id: g.id, no: n }, '已更新編號。');
                }}
              >
                <Icon name="layers" /> 修改編號
              </button>
              <button
                type="button"
                class="mi"
                role="menuitem"
                onClick={async () => {
                  close();
                  await rotateFlow('group', `第 ${g.no} 組`, run, call, g.id);
                  reload();
                }}
              >
                <Icon name="rotate" /> 更換邀請代碼
              </button>
              {!g.used && (
                <button
                  type="button"
                  class="mi danger"
                  role="menuitem"
                  onClick={async () => {
                    close();
                    if (!(await confirm({ title: `刪除第 ${g.no} 組？`, body: '這組還沒有任何預約紀錄，刪除後無法復原。', ok: '刪除', danger: true }))) return;
                    await run('del', () => call('oh_admin_delete', { p_kind: 'group', p_id: g.id }), { ok: '已刪除。' });
                    reload();
                  }}
                >
                  <Icon name="trash" /> 刪除小組
                </button>
              )}
            </>
          )}
        </Menu>
      </div>
      <div class="card sunk tight row between wrap">
        <span class="mono" style={{ fontSize: 17, letterSpacing: '0.1em', fontWeight: 500 }}>
          {prettyCode(g.code)}
        </span>
        <span class="row">
          <Btn size="sm" icon="copy" onClick={() => copyText(link, '已複製邀請連結')}>
            邀請連結
          </Btn>
          <Btn
            size="sm"
            icon="qr"
            aria-label="顯示 QR Code"
            onClick={() =>
              openDialog('邀請 QR Code', (close) => (
                <>
                  <h2>
                    第 {g.no} 組{g.name ? `「${g.name}」` : ''}
                  </h2>
                  <QR text={link} label="邀請 QR Code" />
                  <p class="mono small" style={{ wordBreak: 'break-all' }}>
                    {link}
                  </p>
                  <div class="actions">
                    <CopyBtn text={link} label="複製連結" />
                    <button type="button" class="btn primary" onClick={() => close()}>
                      完成
                    </button>
                  </div>
                </>
              ))
            }
          />
        </span>
      </div>
      <div class="stack tight">
        <span class="eyebrow">已加入 {g.members.length} 人</span>
        {g.members.length ? (
          <div class="row wrap">
            {g.members.map((m) => (
              <button
                type="button"
                key={m.id}
                class="chip outline"
                style={{ cursor: 'pointer' }}
                title={`加入於 ${agoText(m.created_at, now)}，最近 ${agoText(m.seen_at, now)}使用`}
                onClick={async () => {
                  if (!(await confirm({ title: `讓「${m.name}」登出？`, body: '這台裝置之後需要重新輸入代碼。適合用在有人換手機、或填錯組的時候。', ok: '登出這個裝置', danger: true }))) return;
                  await run('revoke', () => call('oh_admin_delete', { p_kind: 'session', p_id: m.id }), { ok: '已登出。' });
                  reload();
                }}
              >
                {m.name}
                <Icon name="x" size={12} />
              </button>
            ))}
          </div>
        ) : (
          <span class="small muted">還沒有人加入。把邀請連結傳給這組吧。</span>
        )}
      </div>
      <Switch checked={g.active} onChange={(v) => save({ id: g.id, active: v }, v ? '已啟用。' : '已停用，這組的成員會被登出。')} label={g.active ? '啟用中' : '已停用'} />
    </div>
  );
}

export function TeachersPage() {
  const { data: cfg, error, reload } = useConfig();
  const { call } = useApi();
  const { busy, run } = useBusy();
  if (!cfg) return error ? <ErrorState onRetry={reload} /> : <Loading />;
  const host = cfg.settings.host_label;

  const save = async (p: Record<string, unknown>, ok?: string) => {
    await run('save', () => call('oh_admin_save', { p_kind: 'teacher', p }), { ok });
    reload();
  };

  return (
    <main class="page enter">
      <div class="row between wrap">
        <div class="stack tight">
          <p class="eyebrow">老師</p>
          <h1 class="title-l">{host}</h1>
          <p class="muted small" style={{ maxWidth: 560 }}>
            每位老師一個專屬連結。打開就能看到自己的場次、各組題目與進度，也能一鍵加入行事曆。老師不需要做任何設定。
          </p>
        </div>
        <Btn
          variant="primary"
          icon="plus"
          loading={busy === 'save'}
          onClick={async () => {
            const name = await ask({ title: `新增${host}`, label: '名字', maxLength: 40, ok: '新增' });
            if (name) save({ name }, '已新增。記得到「時段與週次」設定開放時段。');
          }}
        >
          新增老師
        </Btn>
      </div>
      {cfg.teachers.length === 0 ? (
        <Empty icon="user" title="還沒有老師" />
      ) : (
        <div class="list">
          {cfg.teachers.map((t) => (
            <TeacherRow key={t.id} t={t} save={save} reload={reload} />
          ))}
        </div>
      )}
    </main>
  );
}

function TeacherRow({ t, save, reload }: { t: ConfigTeacher; save: (p: Record<string, unknown>, ok?: string) => Promise<void>; reload: () => void }) {
  const { call } = useApi();
  const { run } = useBusy();
  const link = inviteLink(t.code);
  return (
    <div class="li wrap" style={{ flexWrap: 'wrap', opacity: t.active ? 1 : 0.6 }}>
      <div class="grow stack" style={{ gap: 2, minWidth: 160 }}>
        <b>{t.name}</b>
        <span class="tiny muted">{t.devices ? `${t.devices} 台裝置登入中` : '還沒有登入'}</span>
      </div>
      <span class="mono small" style={{ letterSpacing: '0.08em' }}>
        {prettyCode(t.code)}
      </span>
      <Btn size="sm" icon="copy" onClick={() => copyText(link, `已複製 ${t.name} 的專屬連結`)}>
        專屬連結
      </Btn>
      <Switch checked={t.active} onChange={(v) => save({ id: t.id, active: v }, v ? '已啟用。' : '已停用：這位老師的時段不再開放。')} label="" />
      <Menu label={`${t.name} 選單`} trigger={<Icon name="more" />}>
        {(close) => (
          <>
            <button
              type="button"
              class="mi"
              role="menuitem"
              onClick={async () => {
                close();
                const name = await ask({ title: '修改名字', label: '名字', initial: t.name, maxLength: 40, ok: '儲存' });
                if (name) save({ id: t.id, name }, '已更新。');
              }}
            >
              <Icon name="edit" /> 修改名字
            </button>
            <button
              type="button"
              class="mi"
              role="menuitem"
              onClick={async () => {
                close();
                await rotateFlow('teacher', t.name, run, call, t.id);
                reload();
              }}
            >
              <Icon name="rotate" /> 更換代碼
            </button>
            {!t.used && (
              <button
                type="button"
                class="mi danger"
                role="menuitem"
                onClick={async () => {
                  close();
                  if (!(await confirm({ title: `刪除 ${t.name}？`, body: '會一併刪除這位老師的開放時段。', ok: '刪除', danger: true }))) return;
                  await run('del', () => call('oh_admin_delete', { p_kind: 'teacher', p_id: t.id }), { ok: '已刪除。' });
                  reload();
                }}
              >
                <Icon name="trash" /> 刪除
              </button>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}

export { rotateFlow };
