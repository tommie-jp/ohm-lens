import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captionFor, readResistorImage, verdictOf, type Verdict } from '../../src/annotate/read.js';
import { hasSamples, loadImage, loadManifest, loadPalette, type SampleEntry } from './loadSample.js';

/**
 * sample/ の実写真を通した回帰テスト（Step 0-7）。
 *
 * sample/ は非公開の作業用リポジトリにあるため、公開リポジトリだけを
 * クローンした環境では丸ごとスキップされる。
 *
 * **解析条件は `annotate/read.ts` 経由で `core/settings.ts` に従う。**
 * 以前はここで `ROI_PADDING = 0.06` を直書きし、`refineBoxExtent` も
 * `bodyRange` も渡していなかったため、`doDetect.sh` と違う数字を報告していた
 * （値一致 21/39 対 30/39）。条件がずれていると測った意味がなくなるので、
 * ここに独自の解析条件を書かないこと。
 */

/** 較正用レポートの出力先（git 管理外）。 */
const REPORT_PATH = join(import.meta.dirname, '../../sample-report.txt');

interface Outcome {
  readonly entry: SampleEntry;
  readonly located: boolean;
  readonly runCount: number;
  readonly ohms: number | null;
  readonly correct: boolean;
  readonly verdict: Verdict;
  readonly caption: string;
}

const PALETTE = hasSamples() ? loadPalette() : undefined;

async function analyzeSample(entry: SampleEntry): Promise<Outcome> {
  const image = await loadImage(entry.file);
  const read = readResistorImage(image, {
    ...(PALETTE === undefined ? {} : { palette: PALETTE }),
    expectedOhms: entry.ohms,
  });

  return {
    entry,
    located: read.located,
    runCount: read.analysis?.runs.length ?? 0,
    ohms: read.ohms,
    correct: read.correct,
    verdict: verdictOf(read),
    caption: captionFor(read, entry.file, entry.ohms),
  };
}

/** 実機での見え方の三分。誤答が何件残るかが要点。 */
function tally(outcomes: readonly Outcome[]): Record<Verdict, number> {
  return {
    correct: outcomes.filter((o) => o.verdict === 'correct').length,
    wrong: outcomes.filter((o) => o.verdict === 'wrong').length,
    held: outcomes.filter((o) => o.verdict === 'held').length,
  };
}

/** ラン数ごとの層別。本数が成否をどれだけ説明するかを見るため。 */
function byRunCount(outcomes: readonly Outcome[]): string[] {
  const counts = [...new Set(outcomes.map((o) => o.runCount))].sort((a, b) => a - b);
  return counts.map((count) => {
    const group = outcomes.filter((o) => o.runCount === count);
    const { correct, wrong, held } = tally(group);
    return (
      `  ラン ${String(count).padStart(2)} 本: ${String(group.length).padStart(2)} 枚` +
      `  正解 ${correct} / 誤答 ${wrong} / 保留 ${held}`
    );
  });
}

describe.skipIf(!hasSamples())('sample/ の実写真（Step 0-7）', () => {
  const entries = hasSamples() ? loadManifest() : [];

  it('マニフェストに期待値つきのエントリがある', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('全件を本番条件で解析して現状の成績を報告する', { timeout: 300_000 }, async () => {
    // Arrange / Act
    const outcomes: Outcome[] = [];
    for (const entry of entries) {
      outcomes.push(await analyzeSample(entry));
    }

    // Assert（レポート目的なので閾値では落とさない）
    const located = outcomes.filter((o) => o.located).length;
    const decoded = outcomes.filter((o) => o.ohms !== null).length;
    const matched = outcomes.filter((o) => o.correct).length;
    const { correct, wrong, held } = tally(outcomes);

    const lines = outcomes.map((o) => {
      const mark = o.verdict === 'correct' ? '○' : o.verdict === 'wrong' ? '×' : '△';
      return `  ${mark} ${o.caption}`;
    });

    writeFileSync(
      REPORT_PATH,
      [
        '解析条件: core/settings.ts（doDetect.sh と同一）',
        '',
        `検出成功 ${located}/${entries.length}`,
        `デコード成功 ${decoded}/${entries.length}`,
        `値一致 ${matched}/${entries.length} (${((matched / entries.length) * 100).toFixed(0)}%)`,
        `実機での見え方: 正解 ${correct} / 誤答 ${wrong} / 保留 ${held}`,
        '',
        'ラン数ごとの内訳',
        ...byRunCount(outcomes),
        '',
        ...lines,
        '',
      ].join('\n'),
      'utf-8',
    );

    expect(outcomes).toHaveLength(entries.length);
  });

  it('抵抗器の位置検出はすべての写真で成功する', { timeout: 300_000 }, async () => {
    const results = await Promise.all(
      entries.map(async (entry) => ({
        file: entry.file,
        located: readResistorImage(await loadImage(entry.file)).located,
      })),
    );

    const failed = results.filter((r) => !r.located).map((r) => r.file);
    expect(failed).toEqual([]);
  });
});
