import { local, store } from '../../app/store';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'cue:theme';

export const theme = store<ThemePref>(local.get<ThemePref>(KEY) ?? 'system');

function apply(t: ThemePref) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

export function setTheme(t: ThemePref) {
  theme.set(t);
  local.set(KEY, t);
  apply(t);
}

/** The theme actually showing, for things that must pick one (the Discord preview). */
export function effectiveTheme(t: ThemePref = theme.get()): 'light' | 'dark' {
  if (t !== 'system') return t;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

apply(theme.get());
