import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../src/core/settings.js';
import { locateResistor } from '../src/core/locate.js';
import { refineBoxByBands } from '../src/core/refine.js';
import { rectify } from '../src/core/rectify.js';
import { analyzeRoi } from '../src/core/pipeline.js';
import { splitRuns, identifyBody } from '../src/core/bands/runs.js';
import { deltaE76, labToRgb } from '../src/core/color/colorSpace.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import type { BandColor, LabColor } from '../src/types.js';

/**
 * 色帯の切り出し（ラン分割）を詳しく見るためのツール。
 *
 * `doDetect.sh` の実測では「3 ランに落ち着けば 88% 当たる、6 ランだと
 * ほぼ当たらない」。つまり過分割が主因なので、どのランが余計なのかを
 * 数字で見られるようにする。
 *
 *   npx tsx scripts/dbgRuns.ts ../sample/35-1Mohm.jpg
 *   npx tsx scripts/dbgRuns.ts ../sample/*.jpg    # 一覧だけ
 */

const STRIP_DIR = process.env['STRIP_DIR'] ?? '../sample-detect/runs';
/** ROI の帯を書き出すときの拡大率（40px 高だと見えないため）。 */
const STRIP_SCALE = 4;

/** 学習済みパレットがあれば使う（doDetect.sh と条件を揃える）。 */
function loadPalette(dir: string): Palette {
  const path = join(dir, 'palette.json');
  if (!existsSync(path)) return DEFAULT_PALETTE;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    colors?: Partial<Record<BandColor, LabColor>>;
  };
  return withOverrides(DEFAULT_PALETTE, parsed.colors ?? {});
}

/** ROI とラン境界を 1 枚の帯画像にする。上が ROI、下がランの代表色。 */
async function writeStrip(
  path: string,
  roi: { width: number; height: number; data: Uint8ClampedArray },
  runs: readonly { start: number; end: number; lab: LabColor }[],
  offset: number,
): Promise<void> {
  const stripHeight = 12;
  const total = roi.height + stripHeight;
  const canvas = new Uint8ClampedArray(roi.width * total * 3);

  for (let y = 0; y < roi.height; y += 1) {
    for (let x = 0; x < roi.width; x += 1) {
      const from = (y * roi.width + x) * 4;
      const to = (y * roi.width + x) * 3;
      canvas[to] = roi.data[from] as number;
      canvas[to + 1] = roi.data[from + 1] as number;
      canvas[to + 2] = roi.data[from + 2] as number;
    }
  }

  for (const [index, run] of runs.entries()) {
    const rgb = labToRgb(run.lab);
    for (let x = run.start + offset; x < Math.min(roi.width, run.end + offset); x += 1) {
      for (let y = roi.height; y < total; y += 1) {
        const to = (y * roi.width + x) * 3;
        // 1 本おきに暗くして境界を見えるようにする
        const shade = index % 2 === 0 ? 1 : 0.7;
        canvas[to] = rgb.r * shade;
        canvas[to + 1] = rgb.g * shade;
        canvas[to + 2] = rgb.b * shade;
      }
    }
  }

  await sharp(Buffer.from(canvas), { raw: { width: roi.width, height: total, channels: 3 } })
    .resize({ width: roi.width * STRIP_SCALE, kernel: 'nearest' })
    .png()
    .toFile(path);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('使い方: npx tsx scripts/dbgRuns.ts <画像> [画像...]');
  process.exit(1);
}

mkdirSync(STRIP_DIR, { recursive: true });

const palette = loadPalette('../sample');
const histogram = new Map<number, number>();

/** 本体範囲の外に取り残された「バンドらしいラン」を数えるための彩度。 */
const BAND_CHROMA = 20;
/** 本体範囲が ROI のこの割合より内側から始まっていたら、切りすぎを疑う。 */
const EDGE_MARGIN = 0.25;

let clipped = 0;
let touchesEdge = 0;
let analysed = 0;
const shadingSpread: number[] = [];

for (const path of paths) {
  const image = await loadRoiImage(path);
  const located = locateResistor(image);
  if (located === null) {
    console.log(`${basename(path)} 検出失敗`);
    continue;
  }

  const box = refineBoxByBands(located, image, refineOptions(palette));
  const roi = rectify(image, box, ROI_OPTIONS);
  const result = analyzeRoi(roi, analyzeOptions(box, palette));

  // 本体を含む「切り出す前」のランも見る（何が本体扱いされたかを知るため）
  const allRuns = splitRuns(result.profile, {});
  const body = identifyBody(allRuns, 18);
  const bodyIndices = new Set(body?.runIndices ?? []);

  const count = result.runs.length;
  histogram.set(count, (histogram.get(count) ?? 0) + 1);

  const extentStart = result.extent?.start ?? 0;
  const extentEnd = result.extent?.end ?? roi.width;

  // 本体範囲の外に、彩度の高い（＝バンドらしい）ランが残っていないか
  const orphans = allRuns.filter(
    (run) =>
      (run.end <= extentStart || run.start >= extentEnd) &&
      Math.hypot(run.lab.a, run.lab.b) > BAND_CHROMA,
  );
  analysed += 1;
  if (orphans.length > 0) clipped += 1;
  if (extentStart < roi.width * 0.02 || extentEnd > roi.width * 0.98) touchesEdge += 1;
  if (body !== null) {
    const lightness = [...bodyIndices].map((index) => (allRuns[index] as { lab: LabColor }).lab.l);
    shadingSpread.push(Math.max(...lightness) - Math.min(...lightness));
  }

  const suspicious =
    extentStart > roi.width * EDGE_MARGIN || extentEnd < roi.width * (1 - EDGE_MARGIN);

  console.log(
    `${basename(path)} ROI ${roi.width}x${roi.height}` +
      ` 本体範囲 ${extentStart}..${extentEnd}${suspicious ? ' ←狭い' : ''}` +
      ` 全ラン ${allRuns.length}（本体 ${bodyIndices.size}）→ バンド候補 ${count}` +
      (orphans.length === 0 ? '' : ` 範囲外に彩度のあるラン ${orphans.length}`),
  );

  if (paths.length <= 12) {
    for (const [index, run] of allRuns.entries()) {
      const width = run.end - run.start;
      const fromBody = body === null ? NaN : deltaE76(run.lab, body.lab);
      const previous = index === 0 ? null : (allRuns[index - 1] as { lab: LabColor }).lab;
      const fromPrevious = previous === null ? NaN : deltaE76(run.lab, previous);
      console.log(
        `    ${bodyIndices.has(index) ? '本体' : '    '}` +
          ` #${String(index).padStart(2)} x${String(run.start).padStart(3)}..${String(run.end).padEnd(3)}` +
          ` 幅${String(width).padStart(3)}` +
          ` L${run.lab.l.toFixed(0).padStart(3)} a${run.lab.a.toFixed(0).padStart(4)} b${run.lab.b.toFixed(0).padStart(4)}` +
          ` 本体差${fromBody.toFixed(0).padStart(3)} 前差${fromPrevious.toFixed(0).padStart(3)}`,
      );
    }

    await writeStrip(
      join(STRIP_DIR, `${basename(path, extname(path))}.runs.png`),
      roi,
      result.runs,
      extentStart,
    );
  }
}

console.log('\nバンド候補のラン数の分布:');
for (const count of [...histogram.keys()].sort((a, b) => a - b)) {
  console.log(`  ${count} ラン: ${histogram.get(count)} 件`);
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
};
console.log(
  `\n本体範囲の外に彩度のあるラン（バンドを切り落とした疑い）: ${clipped}/${analysed}\n` +
    `本体範囲が ROI の端に達している（背景を本体に含めた疑い）: ${touchesEdge}/${analysed}\n` +
    `本体ランの L* の広がり（陰影の強さ）: 中央値 ${median(shadingSpread).toFixed(0)}` +
    ` 最大 ${Math.max(0, ...shadingSpread).toFixed(0)}`,
);
if (paths.length <= 12) console.log(`\n帯画像: ${STRIP_DIR}`);
