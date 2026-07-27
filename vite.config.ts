import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * 開発時だけ、隣の作業用リポジトリにある学習パレットを配信する。
 *
 * sample/ は非公開の作業用リポジトリ側にあり、本リポジトリのビルド成果物には
 * 含めない。デバッグページからは fetch できるようにしておきたいので、
 * dev サーバーにだけ経路を足す。
 */
function servePalette(): Plugin {
  const palettePath = join(import.meta.dirname, '../sample/palette.json');

  return {
    name: 'ohmlens-serve-palette',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/palette.json', (_request, response) => {
        if (!existsSync(palettePath)) {
          response.statusCode = 404;
          response.end('{}');
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(readFileSync(palettePath, 'utf-8'));
      });
    },
  };
}

// Phase 0 のデバッグページは src/debug をルートにする。
// Phase 1 で本番 UI を作る際にルート構成を見直す。
export default defineConfig({
  root: 'src/debug',
  plugins: [servePalette()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // HEIC デコーダ（libheif の WASM、約 3MB）は動的 import で分割してあり、
    // HEIC を選んだときだけ読み込まれる。分割済みなので警告は不要。
    chunkSizeWarningLimit: 4096,
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
