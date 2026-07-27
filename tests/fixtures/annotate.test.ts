import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { annotateImage, loadRoiImage } from '../../src/annotate/pipeline.js';
import {
  COLOR_SPACE_PANEL_HEIGHT,
  COLOR_SPACE_PANEL_WIDTH,
} from '../../src/annotate/colorSpace.js';
import { hasSamples, loadManifest, loadPalette, sampleDir } from './loadSample.js';

/**
 * 焼き込み出力の回帰テスト。
 *
 * 実処理は `src/annotate/pipeline.ts`（doDetect.sh と同じ実装）を呼ぶだけ。
 * 一括デバッグは ./doDetect.sh の方が使いやすいので、ここでは
 * 「全件が例外なく処理でき、画像が生成される」ことだけを担保する。
 */

const OUT_DIR = join(import.meta.dirname, '../../debug-out');

describe.skipIf(!hasSamples())('検出結果の焼き込み', () => {
  it('sample/ 全件を例外なく焼き込める', { timeout: 600_000 }, async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const entries = loadManifest();
    const palette = loadPalette();

    const captions: string[] = [];
    for (const entry of entries) {
      const result = await annotateImage(join(sampleDir(), entry.file), entry.file, {
        palette,
        expectedOhms: entry.ohms,
      });

      expect(result.jpeg.byteLength).toBeGreaterThan(0);
      writeFileSync(join(OUT_DIR, entry.file.replace(/\.[^.]+$/, '.annotated.jpg')), result.jpeg);
      captions.push(result.caption);
    }

    writeFileSync(join(OUT_DIR, 'summary.txt'), captions.join('\n') + '\n', 'utf-8');
    expect(captions).toHaveLength(entries.length);
  });

  it.each([0, -1])('色空間パネルが収まるだけキャンバスを広げる（%s 枚目）', async (index) => {
    // Arrange: 大きい写真と、パネルより狭い写真の両方で見る
    const entries = loadManifest();
    const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file));
    const entry = index === 0 ? sorted[0] : sorted[sorted.length - 1];
    if (entry === undefined) return;
    const path = join(sampleDir(), entry.file);
    const source = await loadRoiImage(path);

    // Act
    const result = await annotateImage(path, entry.file, { palette: loadPalette() });
    const meta = await sharp(result.jpeg).metadata();

    // Assert: 写真は隠さず、下に帯を足している。写真が狭ければ右にも広げる
    expect(meta.width).toBe(Math.max(source.width, COLOR_SPACE_PANEL_WIDTH));
    expect(meta.height).toBe(source.height + COLOR_SPACE_PANEL_HEIGHT);
  });
});
