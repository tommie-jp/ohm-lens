import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRoi } from '../../src/core/pipeline.js';
import { locateResistor } from '../../src/core/locate.js';
import { rectify } from '../../src/core/rectify.js';
import { formatOhms } from '../../src/core/format.js';
import { hasSamples, loadImage, loadManifest, loadPalette, type SampleEntry } from './loadSample.js';

/**
 * sample/ の実写真を通した回帰テスト（Step 0-7）。
 *
 * sample/ は非公開の作業用リポジトリにあるため、公開リポジトリだけを
 * クローンした環境では丸ごとスキップされる。
 */

/** 較正用レポートの出力先（git 管理外）。 */
const REPORT_PATH = join(import.meta.dirname, '../../sample-report.txt');

/** ROI は本体の外側を少し含める（端のバンドが切れるのを防ぐ）。 */
const ROI_PADDING = 0.06;

/** 解析時の ROI 高さ。色帯の解像度と処理量のバランス。 */
const ROI_HEIGHT = 40;

/** 読み取り値がこの相対誤差以内なら正解とみなす。 */
const VALUE_TOLERANCE = 1e-6;

interface Outcome {
  readonly entry: SampleEntry;
  readonly located: boolean;
  readonly bandCount: number;
  readonly detected: readonly string[];
  readonly ohms: number | null;
  readonly confidence: number;
  readonly correct: boolean;
}

const PALETTE = hasSamples() ? loadPalette() : undefined;

async function analyzeSample(entry: SampleEntry): Promise<Outcome> {
  const image = await loadImage(entry.file);
  const box = locateResistor(image);
  if (box === null) {
    return { entry, located: false, bandCount: 0, detected: [], ohms: null, confidence: 0, correct: false };
  }

  const roi = rectify(image, box, { padding: ROI_PADDING, targetHeight: ROI_HEIGHT });
  const result = analyzeRoi(roi, PALETTE === undefined ? {} : { segment: { palette: PALETTE } });
  const ohms = result.reading?.ohms ?? null;

  return {
    entry,
    located: true,
    bandCount: result.bands.length,
    detected: result.bands.map((band) => `${band.color}(${band.end - band.start})`),
    ohms,
    confidence: result.reading?.confidence ?? 0,
    correct: ohms !== null && Math.abs(ohms - entry.ohms) / entry.ohms < VALUE_TOLERANCE,
  };
}

describe.skipIf(!hasSamples())('sample/ の実写真（Step 0-7）', () => {
  const entries = hasSamples() ? loadManifest() : [];

  it('マニフェストに期待値つきのエントリがある', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('全件を解析して現状の成功率を報告する', { timeout: 120_000 }, async () => {
      // Arrange / Act
      const outcomes: Outcome[] = [];
      for (const entry of entries) {
        outcomes.push(await analyzeSample(entry));
      }

      // Assert（レポート目的なので閾値では落とさない）
      const located = outcomes.filter((o) => o.located).length;
      const decoded = outcomes.filter((o) => o.ohms !== null).length;
      const correct = outcomes.filter((o) => o.correct).length;

      const lines = outcomes.flatMap((o) => {
        const mark = o.correct ? '○' : o.ohms === null ? '×' : '△';
        const got = o.ohms === null ? '読取不可' : formatOhms(o.ohms);
        return [
          `  ${mark} ${o.entry.file.padEnd(40)} 期待 ${formatOhms(o.entry.ohms).padEnd(9)} 実際 ${got.padEnd(9)} 確信度 ${o.confidence.toFixed(2)}`,
          `      検出: ${o.detected.join(' ') || '(なし)'}`,
          o.entry.bands ? `      正解: ${o.entry.bands.join(' ')}` : '',
        ].filter(Boolean);
      });

      writeFileSync(
        REPORT_PATH,
        [
          `検出成功 ${located}/${entries.length}`,
          `デコード成功 ${decoded}/${entries.length}`,
          `値一致 ${correct}/${entries.length} (${((correct / entries.length) * 100).toFixed(0)}%)`,
          '',
          ...lines,
          '',
        ].join('\n'),
        'utf-8',
      );

    expect(outcomes).toHaveLength(entries.length);
  });

  it('抵抗器の位置検出はすべての写真で成功する', { timeout: 120_000 }, async () => {
      const results = await Promise.all(
        entries.map(async (entry) => ({
          file: entry.file,
          located: locateResistor(await loadImage(entry.file)) !== null,
        })),
      );

      const failed = results.filter((r) => !r.located).map((r) => r.file);
    expect(failed).toEqual([]);
  });
});
