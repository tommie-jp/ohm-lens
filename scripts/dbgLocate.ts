import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { locateResistorDetailed } from '../src/core/locate.js';

/**
 * 抵抗器の検出（赤い四角形）だけを詳しく見るためのツール。
 *
 * `doDetect.sh` は「検出できたか / 値が合ったか」しか出さないので、
 * 外したときに前景マスクと成分の評価を直接見られるようにしておく。
 *
 *   npx tsx scripts/dbgLocate.ts ../sample/07-*.jpg
 *   MASK_DIR=/tmp/mask npx tsx scripts/dbgLocate.ts ../sample/*.jpg
 */

const MASK_DIR = process.env['MASK_DIR'] ?? '../sample-detect/mask';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('使い方: npx tsx scripts/dbgLocate.ts <画像> [画像...]');
  process.exit(1);
}

mkdirSync(MASK_DIR, { recursive: true });

for (const path of paths) {
  const image = await loadRoiImage(path);
  const { background, foregroundRatio, candidates, rejected, mask } =
    locateResistorDetailed(image);

  console.log(
    `${basename(path)} ${image.width}x${image.height}` +
      ` 背景(L${background.l.toFixed(0)} a${background.a.toFixed(1)} b${background.b.toFixed(1)})` +
      ` 前景${(foregroundRatio * 100).toFixed(0)}%` +
      ` 候補${candidates.length} 却下${rejected.length}`,
  );
  for (const candidate of candidates.slice(0, 3)) {
    const { box } = candidate;
    console.log(
      `    採点${candidate.score.toFixed(3)}` +
        ` 細長さ${candidate.elongation.toFixed(2)}` +
        ` 面積${(candidate.areaRatio * 100).toFixed(1)}%` +
        ` 充填${candidate.fill.toFixed(2)}` +
        ` → L${box.length.toFixed(0)} T${box.thickness.toFixed(0)} ${box.angleDeg.toFixed(0)}°`,
    );
  }
  for (const entry of rejected.slice(0, 3)) {
    console.log(`    却下 ${entry.reason}（${entry.cells} セル）`);
  }

  if (mask.cols > 0) {
    const gray = Buffer.from(mask.cells.map((cell) => (cell === 1 ? 255 : 0)));
    const name = `${basename(path, extname(path))}.mask.png`;
    await sharp(gray, { raw: { width: mask.cols, height: mask.rows, channels: 1 } })
      .png()
      .toFile(join(MASK_DIR, name));
  }
}

console.log(`\n前景マスク: ${MASK_DIR}`);
