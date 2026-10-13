import { BOOTSTRAP, MIGRATIONS, SEED } from '../db/sql';
import demoSeed from '../db/demo.sql?raw';
import manifest from '../db/pglite-manifest.json';
import { ApiError, Emitter, assertFn, type Engine } from './engine';

type AssetName = keyof typeof manifest.files;

// jsDelivr serves the exact npm release far faster than GitHub Pages;
// a copy shipped with the site is the fallback. Either way the bytes
// must match the SHA-256 recorded at build time.
const SOURCES = [`https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${manifest.version}/dist/`, './pglite/'];

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s);
}

async function download(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes(total);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

async function fetchAsset(name: AssetName, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const want = manifest.files[name].sha256;
  let last: unknown;
  for (const base of SOURCES) {
    try {
      const buf = await download(base + name, onBytes);
      if ((await sha256(buf)) !== want) throw new Error(`integrity check failed for ${base}${name}`);
      return buf;
    } catch (e) {
      last = e;
      onBytes(0);
      console.warn(`demo: ${base}${name} unavailable, trying next source`, e);
    }
  }
  throw last;
}

/**
 * The full backend, running in this tab on PGlite (Postgres compiled to
 * WebAssembly). Nothing leaves the browser; a reload starts over.
 */
export async function demoEngine(onProgress: (fraction: number) => void = () => {}): Promise<Engine> {
  const names = Object.keys(manifest.files) as AssetName[];
  const totalBytes = names.reduce((n, k) => n + manifest.files[k].size, 0);
  const got: Record<string, number> = {};
  const report = () => onProgress(Math.min(1, Object.values(got).reduce((a, b) => a + b, 0) / totalBytes));

  const get = (n: AssetName) =>
    fetchAsset(n, (b) => {
      got[n] = b;
      report();
    });
  const [{ PGlite }, pgWasm, initdbWasm, data] = await Promise.all([
    import('@electric-sql/pglite'),
    get('pglite.wasm'),
    get('initdb.wasm'),
    get('pglite.data'),
  ]);
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([WebAssembly.compile(pgWasm), WebAssembly.compile(initdbWasm)]);
  const pg = await PGlite.create({ pgliteWasmModule, initdbWasmModule, fsBundle: new Blob([data]) });
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
