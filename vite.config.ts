/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// A Content-Security-Policy for each page of the production build. Scripts
// only from this site, fonts only from Google Fonts, and network only to the
// backend each app talks to: Office Hour to its Supabase project (plus
// WebAssembly for the in-browser demo database), Cue to the GitHub API.
function csp(supabaseUrl: string): Plugin {
  const api = supabaseUrl ? new URL(supabaseUrl) : null;
  const common = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ];
  const officeHour = [
    ...common,
    "script-src 'self' 'wasm-unsafe-eval'",
    "img-src 'self' data: blob:",
    `connect-src ${["'self'", api ? api.origin : '', api ? `wss://${api.host}` : '', 'https://cdn.jsdelivr.net'].filter(Boolean).join(' ')}`,
    "worker-src 'self' blob:",
  ];
  // Discord previews show avatars and embed images from any https host.
  const cue = [...common, "script-src 'self'", "img-src 'self' data: blob: https:", "connect-src 'self' https://api.github.com"];
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html, ctx) => {
      const policy = (/[\\/]cue[\\/]index\.html$/.test(ctx.filename) ? cue : officeHour).join('; ');
      return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    base: './',
    plugins: [preact(), csp(env.VITE_SUPABASE_URL ?? '')],
    define: {},
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        // two apps, one site: Office Hour at ./, Cue at ./cue/
        input: { main: 'index.html', cue: 'cue/index.html' },
      },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      testTimeout: 30000,
      hookTimeout: 60000,
    },
  };
});
