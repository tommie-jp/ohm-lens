import { defineConfig } from 'vitest/config';

// Phase 0 のデバッグページは src/debug をルートにする。
// Phase 1 で本番 UI を作る際にルート構成を見直す。
export default defineConfig({
  root: 'src/debug',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    root: '.',
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
