/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// A Content-Security-Policy for the production build. Scripts only from
// this site (plus WebAssembly for the in-browser demo database), network
// only to the Supabase project, fonts only from Google Fonts.
function csp(supabaseUrl: string): Plugin {
  const api = supabaseUrl ? new URL(supabaseUrl) : null;
  const connect = ["'self'", api ? api.origin : '', api ? `wss://${api.host}` : ''].filter(Boolean).join(' ');
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: './',
    plugins: [preact(), csp(env.VITE_SUPABASE_URL ?? '')],
    define: {},
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      testTimeout: 30000,
      hookTimeout: 60000,
    },
  };
});
