// An Engine runs oh_* functions somewhere: on Supabase (cloud) or on
// PGlite inside the page (demo). Both speak exactly the same SQL API.

export type LinkStatus = 'connecting' | 'live' | 'offline';

export interface Engine {
  mode: 'cloud' | 'demo';
  call<T>(fn: string, args?: Record<string, unknown>): Promise<T>;
  /** Fires when anything changed on the server (debounced by callers). */
  onChange(cb: () => void): () => void;
  onStatus(cb: (s: LinkStatus) => void): () => void;
  status(): LinkStatus;
}

export class ApiError extends Error {
  constructor(public code: string, public detail = '') {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export class Emitter<T> {
  private subs = new Set<(v: T) => void>();
  on(cb: (v: T) => void) {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  emit(v: T) {
    for (const s of [...this.subs]) s(v);
  }
}

const FN = /^oh_[a-z_]+$/;
export function assertFn(fn: string) {
  if (!FN.test(fn)) throw new ApiError('CLIENT', `bad function ${fn}`);
}
