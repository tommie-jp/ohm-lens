import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { annotateImage } from '../src/annotate/pipeline.js';
import { DEFAULT_PALETTE, withOverrides, type Palette } from '../src/core/color/palette.js';
import type { BandColor, LabColor } from '../src/types.js';

/**
 * 検出結果の一括焼き込み（doDetect.sh の実体）。
 *
 * ロジックは `src/annotate` と `src/core` にあり、ここは入出力の面倒を
 * 見るだけ。1 枚ずつ逐次処理し、1 枚の失敗で全体を止めない。
 */

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif']);

interface Args {
  readonly inDir: string;
  readonly outDir: string;
  readonly filter: string | null;
  readonly clean: boolean;
  readonly japanese: boolean;
}

/** 値を取るオプション。位置引数の判定でこれらの値を除外する。 */
const VALUE_FLAGS = ['in', 'out'] as const;

function parseArgs(argv: readonly string[]): Args {
  const consumed = new Set<number>();

  const get = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0 || argv[index + 1] === undefined) return fallback;
    consumed.add(index);
    consumed.add(index + 1);
    return argv[index + 1] as string;
  };

  const values: Record<string, string> = {};
  for (const flag of VALUE_FLAGS) {
    values[flag] = get(flag, flag === 'in' ? '../sample' : '../sample-detect');
  }

  // 残った非オプション引数の最後をフィルタとして使う。
  // --out の値などを拾わないよう、消費済みの位置は除外する。
  const positional = argv.filter(
    (arg, index) => !consumed.has(index) && !arg.startsWith('--'),
  );

  return {
    inDir: values['in'] as string,
    outDir: values['out'] as string,
    filter: positional.length > 0 ? (positional[positional.length - 1] as string) : null,
    clean: argv.includes('--clean'),
    japanese: !argv.includes('--ascii'),
  };
}

/** MANIFEST.json から期待値を引く（無ければファイル名からの推定に任せる）。 */
function loadExpected(inDir: string): Map<string, number> {
  const path = join(inDir, 'MANIFEST.json');
  const map = new Map<string, number>();
  if (!existsSync(path)) return map;

  const items = JSON.parse(readFileSync(path, 'utf-8')) as {
    file: string;
    expected: { ohms: number } | null;
  }[];
  for (const item of items) {
    if (item.expected !== null) map.set(item.file, item.expected.ohms);
  }
  return map;
}

/** 学習済みパレットがあれば使う（GUI と同じ結果になるように）。 */
function loadPalette(inDir: string): Palette {
  const path = join(inDir, 'palette.json');
  if (!existsSync(path)) return DEFAULT_PALETTE;

  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
    colors?: Partial<Record<BandColor, LabColor>>;
  };
  return withOverrides(DEFAULT_PALETTE, parsed.colors ?? {});
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.inDir)) {
    console.error(`入力ディレクトリがありません: ${args.inDir}`);
    process.exit(1);
  }

  if (args.clean && existsSync(args.outDir)) rmSync(args.outDir, { recursive: true, force: true });
  mkdirSync(args.outDir, { recursive: true });

  const expected = loadExpected(args.inDir);
  const palette = loadPalette(args.inDir);

  const files = readdirSync(args.inDir)
    .filter((name) => EXTENSIONS.has(extname(name).toLowerCase()))
    .filter((name) => args.filter === null || name.includes(args.filter))
    .sort();

  if (files.length === 0) {
    console.error(`対象の画像がありません（${args.inDir}${args.filter === null ? '' : ` / "${args.filter}"`}）`);
    process.exit(1);
  }

  console.log(`入力 ${args.inDir} → 出力 ${args.outDir}（${files.length} 枚）`);
  if (palette !== DEFAULT_PALETTE) console.log('学習パレットを適用します\n');
  else console.log('学習パレットなし（既定の基準色）\n');

  const captions: string[] = [];
  let located = 0;
  let correct = 0;
  let failed = 0;

  for (const [index, file] of files.entries()) {
    const progress = `${String(index + 1).padStart(String(files.length).length)}/${files.length}`;
    const ohms = expected.get(file);

    try {
      const result = await annotateImage(join(args.inDir, file), file, {
        palette,
        japanese: args.japanese,
        ...(ohms === undefined ? {} : { expectedOhms: ohms }),
      });

      const name = `${basename(file, extname(file))}.detect.jpg`;
      writeFileSync(join(args.outDir, name), result.jpeg);

      if (result.located) located += 1;
      if (result.correct) correct += 1;
      captions.push(result.caption);
      console.log(`${progress} ${result.correct ? '○' : result.located ? '△' : '×'} ${result.caption}`);
    } catch (error) {
      failed += 1;
      const line = `${file} | 読込/処理に失敗: ${String(error)}`;
      captions.push(line);
      console.log(`${progress} ! ${line}`);
    }
  }

  writeFileSync(join(args.outDir, 'summary.txt'), captions.join('\n') + '\n', 'utf-8');

  const withExpected = files.filter((file) => expected.has(file)).length;
  console.log(
    `\n処理 ${files.length} 枚 / 検出成功 ${located} / 読込失敗 ${failed}` +
      (withExpected > 0 ? ` / 値一致 ${correct}/${withExpected}` : ''),
  );
  console.log(`出力: ${args.outDir}（summary.txt に一覧）`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
