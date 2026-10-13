// Copies PGlite's WebAssembly + data files next to the app (public/pglite)
// and records their versions and SHA-256 hashes. The demo first fetches
// the identical files from jsDelivr (much faster than GitHub Pages) and
// only accepts them if the hashes match; otherwise it uses these copies.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules/@electric-sql/pglite');
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const files = ['pglite.wasm', 'initdb.wasm', 'pglite.data'];
const out = join(root, 'public/pglite');
mkdirSync(out, { recursive: true });

const manifest = { version, files: {} };
for (const f of files) {
  const src = join(pkgDir, 'dist', f);
  copyFileSync(src, join(out, f));
  manifest.files[f] = {
    size: statSync(src).size,
    sha256: createHash('sha256').update(readFileSync(src)).digest('base64'),
  };
}
writeFileSync(join(root, 'src/db/pglite-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`pglite ${version}: ${files.join(', ')} ready`);
