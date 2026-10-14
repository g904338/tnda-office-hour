import { useEffect } from 'preact/hooks';
import { go } from '../../app/router';

/** N: new post, /: search. Ignored while typing or with a dialog open. */
export function useShortcuts() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.scrim')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        go('compose');
      } else if (e.key === '/') {
        const s = document.querySelector<HTMLInputElement>('[data-search]');
        if (s) {
          e.preventDefault();
          s.focus();
        }
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);
}
