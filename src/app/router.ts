import { store } from './store';

// Hash routes keep GitHub Pages happy: #/book/12, #/admin/groups, #/join/ABCD2345

function parse(): string[] {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return h.split('/').filter(Boolean);
}

export const route = store<string[]>(parse());

window.addEventListener('hashchange', () => {
  route.set(parse());
});

export function go(path: string, opts: { replace?: boolean } = {}) {
  const target = `#/${path.replace(/^\/+/, '')}`;
  if (opts.replace) {
    history.replaceState(null, '', target);
    route.set(parse());
  } else if (location.hash !== target) {
    location.hash = target;
  }
  window.scrollTo({ top: 0 });
}

export function href(path: string): string {
  return `#/${path.replace(/^\/+/, '')}`;
}
