import { useEffect, useState } from 'preact/hooks';

/** A tiny observable value with a hook. */
export interface Store<T> {
  get(): T;
  set(v: T | ((prev: T) => T)): void;
  subscribe(cb: () => void): () => void;
  use(): T;
}

export function store<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  const s: Store<T> = {
    get: () => value,
    set(v) {
      const next = typeof v === 'function' ? (v as (p: T) => T)(value) : v;
      if (Object.is(next, value)) return;
      value = next;
      for (const cb of [...subs]) cb();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    use() {
      const [, force] = useState(0);
      useEffect(() => s.subscribe(() => force((n) => n + 1)), []);
      return value;
    },
  };
  return s;
}

/** localStorage that never throws (private mode, blocked storage…). */
export const local = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};
