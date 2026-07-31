import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { SAMPLE_EXTENSIONS, sampleDir, staleManifestEntries } from '../tests/fixtures/loadSample.js';

/**
 * `sample/MANIFEST.json` をディレクトリの実体に合わせる。
 *
 * sample/ は切り出しが甘い検体を手で消す運用なので、消し忘れたエントリが残る。
 * 残っていても `loadManifest` が実体の無いものを飛ばすため実害は出にくいが、
 * 「マニフェストにあるのに無い」状態は次に見たときに事故のもとになる。
 *
 *   npx tsx scripts/syncManifest.ts          # 差分を表示するだけ
 *   npx tsx scripts/syncManifest.ts --write  # 実体の無いエントリを削除する
 *
 * 消したエントリの出典・ライセンスは `sample-candidates/CANDIDATES.json` に
 * 残るので、原本から切り直せば復帰できる。
 */

interface ManifestEntry {
  readonly file: string;
  readonly title?: string;
  readonly [key: string]: unknown;
}

const MANIFEST_PATH = join(sampleDir(), 'MANIFEST.json');

const write = process.argv.includes('--write');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ManifestEntry[];
const present = new Set(
  readdirSync(sampleDir()).filter((file) =>
    (SAMPLE_EXTENSIONS as readonly string[]).includes(extname(file).toLowerCase()),
  ),
);

const stale = staleManifestEntries(manifest, present);
const untracked = [...present].filter((file) => !manifest.some((entry) => entry.file === file));

console.log(`画像 ${present.size} 枚 / マニフェスト ${manifest.length} 件`);

if (stale.length > 0) {
  console.log(`\n実体の無いエントリ ${stale.length} 件:`);
  for (const file of stale) console.log(`  - ${file}`);
}
if (untracked.length > 0) {
  console.log(`\nマニフェストに無い画像 ${untracked.length} 枚（手で足すこと）:`);
  for (const file of untracked) console.log(`  + ${file}`);
}
if (stale.length === 0 && untracked.length === 0) {
  console.log('\n差分はありません。');
  process.exit(0);
}

if (!write) {
  console.log('\n--write を付けると、実体の無いエントリを削除します。');
  process.exit(0);
}

const kept = manifest.filter((entry) => present.has(entry.file));
writeFileSync(MANIFEST_PATH, `${JSON.stringify(kept, null, 2)}\n`, 'utf-8');
console.log(`\nマニフェストを更新しました（${manifest.length} → ${kept.length} 件）。`);
