import { useEffect } from 'preact/hooks';
import type { Role } from './api/types';
import { go, route } from './app/router';
import { exitDemo, resetDemo, signOut, startDemo, switchDemoRole, useApp, verifySession } from './app/session';
import { confirm, Dialogs } from './ui/dialog';
import { Icon } from './ui/icons';
import { Btn, Loading, Seg } from './ui/kit';
import { Toasts } from './ui/toast';
import { AdminApp } from './views/admin/AdminApp';
import { StudentApp } from './views/student/StudentApp';
import { TeacherApp } from './views/teacher/TeacherApp';
import { Welcome } from './views/Welcome';

function DemoBar() {
  const { demo } = useApp();
  if (!demo) return null;
  return (
    <div class="demobar" role="region" aria-label="示範模式">
      <span class="row" style={{ gap: 6 }}>
        <Icon name="play" size={14} />
        示範模式
      </span>
      <Seg<Role>
        label="切換身份"
        value={demo.role}
        onChange={(r) => switchDemoRole(r)}
        options={[
          { value: 'student', label: '學生' },
          { value: 'admin', label: '助教' },
          { value: 'teacher', label: '老師' },
        ]}
      />
      <span class="grow" />
      <span class="tiny" style={{ opacity: 0.85 }}>
        資料只存在這個分頁
      </span>
      <Btn size="sm" icon="rotate" onClick={resetDemo}>
        重設
      </Btn>
      <Btn size="sm" icon="door" onClick={exitDemo}>
        離開
      </Btn>
    </div>
  );
}

export function App() {
  const { auth, demo, demoLoading } = useApp();
  const r = route.use();

  useEffect(() => {
    verifySession();
  }, []);

  // #/demo opens the sandbox directly (handy for judges and screenshots)
  useEffect(() => {
    if (r[0] === 'demo' && !demo && !demoLoading) {
      const role = (['student', 'admin', 'teacher'] as Role[]).includes(r[1] as Role) ? (r[1] as Role) : 'student';
      startDemo(role);
    }
  }, [r[0], r[1]]);

  // a join link while already signed in
  useEffect(() => {
    if (r[0] !== 'join' || !auth || demo) return;
    confirm({
      title: '要切換身份嗎？',
      body: `這台裝置目前以「${auth.session.name}」登入。要登出並使用新的邀請連結嗎？`,
      ok: '登出並切換',
    }).then(async (ok) => {
      const code = r[1];
      if (ok) {
        await signOut();
        go(`join/${code}`, { replace: true });
      } else {
        go('', { replace: true });
      }
    });
  }, [r[0], auth?.token]);

  let body;
  if (demoLoading || (r[0] === 'demo' && !demo)) {
    body = <Loading label="正在你的瀏覽器裡啟動一個完整的資料庫…" />;
  } else if (!auth) {
    body = <Welcome key={r[1] ?? ''} initialCode={r[0] === 'join' ? r[1] : undefined} />;
  } else if (auth.session.role === 'admin') {
    body = <AdminApp route={r[0] === 'admin' ? r : ['admin']} />;
  } else if (auth.session.role === 'teacher') {
    body = <TeacherApp />;
  } else {
    body = <StudentApp route={r} />;
  }

  return (
    <>
      <DemoBar />
      {body}
      <Toasts />
      <Dialogs />
    </>
  );
}
