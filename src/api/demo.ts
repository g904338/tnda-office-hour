import { BOOTSTRAP, MIGRATIONS, SEED } from '../db/sql';
import demoSeed from '../db/demo.sql?raw';
import { ApiError, Emitter, assertFn, type Engine } from './engine';

// The full backend, running in this tab on PGlite (Postgres compiled to
// WebAssembly). Nothing leaves the browser; a reload starts over.
export async function demoEngine(): Promise<Engine> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();
  await pg.exec(BOOTSTRAP);
  for (const m of MIGRATIONS) await pg.exec(m);
  await pg.exec(SEED);
  await pg.exec(demoSeed);

  const changes = new Emitter<void>();
  await pg.listen('oh_sync', () => changes.emit());

  return {
    mode: 'demo',
    async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      assertFn(fn);
      const keys = Object.keys(args).filter((k) => args[k] !== undefined);
      for (const k of keys) if (!/^p(_[a-z]+)*$/.test(k)) throw new ApiError('CLIENT', `bad arg ${k}`);
      const list = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const params = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      try {
        const r = await pg.query<{ r: T }>(`select public.${fn}(${list}) as r`, params);
        return r.rows[0].r;
      } catch (e: any) {
        if (e?.code === 'P0001') throw new ApiError(e.message, e.detail ?? '');
        throw new ApiError('SERVER', e?.message ?? String(e));
      }
    },
    onChange: (cb) => changes.on(cb),
    onStatus: () => () => {},
    status: () => 'live',
  };
}
