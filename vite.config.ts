/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: './',
  plugins: [preact()],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
