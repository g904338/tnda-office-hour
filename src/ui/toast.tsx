import { store } from '../app/store';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

const toasts = store<Toast[]>([]);
let seq = 0;

export function toast(text: string, opts: { kind?: 'info' | 'error'; action?: Toast['action']; ms?: number } = {}) {
  const id = ++seq;
  toasts.set((l) => [...l.filter((t) => t.text !== text), { id, text, kind: opts.kind ?? 'info', action: opts.action }].slice(-3));
  setTimeout(() => toasts.set((l) => l.filter((t) => t.id !== id)), opts.ms ?? (opts.kind === 'error' ? 6000 : 3600));
}

export function Toasts() {
  const list = toasts.use();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind === 'error' ? 'error' : ''}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.run();
                toasts.set((l) => l.filter((x) => x.id !== t.id));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
