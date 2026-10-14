// Single-file, demo-only build of Cue for sandboxed previews:
//   VITE_CUE_PREVIEW=1 npx vite build -c vite.cue-preview.config.ts
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    outDir: process.env.CUE_PREVIEW_OUT || 'dist-preview',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { input: 'cue/index.html', output: { inlineDynamicImports: true } },
  },
});
