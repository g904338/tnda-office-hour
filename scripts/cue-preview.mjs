// Builds a single-file, demo-only copy of Cue (everything inlined) for
// sandboxed previews that cannot load other files or reach GitHub.
//   node scripts/cue-preview.mjs cue-demo.html
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'cue-demo.html';
const dir = mkdtempSync(join(tmpdir(), 'cue-preview-'));
execFileSync('npx', ['vite', 'build', '-c', 'vite.cue-preview.config.ts', '--logLevel', 'warn'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_CUE_PREVIEW: '1', CUE_PREVIEW_OUT: dir },
});
const assets = readdirSync(join(dir, 'assets'));
const js = readFileSync(join(dir, 'assets', assets.find((f) => f.endsWith('.js'))), 'utf8').replace(/<\/script/gi, '<\\/script');
// the preview has no class on <html>: Cue's tokens go on :root instead
const css = readFileSync(join(dir, 'assets', assets.find((f) => f.endsWith('.css'))), 'utf8')
  .replace(/html\.cue/g, ':root')
  .replace(/<\/style/gi, '<\\/style');
writeFileSync(
  out,
  `<title>Cue 課堂公告排程</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700;800;900&display=swap" />
<style>
${css}
</style>
<div id="app"></div>
<noscript>Cue 需要 JavaScript 才能使用。</noscript>
<script type="module">
${js}
</script>
`,
);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${out}`);
