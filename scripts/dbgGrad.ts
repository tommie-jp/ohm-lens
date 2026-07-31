import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadRoiImage } from '../src/annotate/pipeline.js';
import { readResistorImage } from '../src/annotate/read.js';
import type { ProfileSample } from '../src/types.js';

/**
 * 中心線プロファイルの微分を、チャンネルごとに「雑音床」と「信号」に分けて測る。
 *
 * バンド境界の指標 abs = L1·|dL/dx| + A1·|da/dx| + B1·|db/dx| の係数を
 * 決めるための材料。生の振幅で比べると L* が大きいが、L* は雑音も大きい。
 * 効かせたいのは SNR なので、雑音床（MAD）と信号（|d| の p95）を別々に出す。
 *
 * - MAD = 1.4826 × median(|d − median(d)|)。外れ値（境界そのもの）に
 *   引っ張られないので、境界を含む信号から雑音床だけを取り出せる
 * - p95 = |d| の 95 パーセンタイル。境界の立ち上がりの大きさの代表値
 *
 *   npx tsx scripts/dbgGrad.ts             # sample/ 全件
 *   npx tsx scripts/dbgGrad.ts 41 42       # ファイル名で絞り込む
 *
 * 測定結果と、そこから導いた係数の議論は
 * `docs/13-バンド境界の検出指標.md` にある。
 */

const SAMPLE_DIR = join(import.meta.dirname, '../../sample');

/** MAD を標準偏差の尺度に合わせる係数（正規分布のとき一致する）。 */
const MAD_SCALE = 1.4826;

type Channel = 'l' | 'a' | 'b';

const CHANNELS: readonly Channel[] = ['l', 'a', 'b'];

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

function mad(values: readonly number[]): number {
  const center = median(values);
  return MAD_SCALE * median(values.map((value) => Math.abs(value - center)));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}

/** 中心差分（端は使わない。片側差分は傾きが半分になって統計を汚す）。 */
function centralDifference(profile: readonly ProfileSample[], channel: Channel): number[] {
  return profile
    .slice(1, -1)
    .map((_, index) => {
      const next = profile[index + 2] as ProfileSample;
      const prev = profile[index] as ProfileSample;
      return (next.lab[channel] - prev.lab[channel]) / 2;
    });
}

interface Row {
  readonly file: string;
  readonly samples: number;
  readonly mad: Record<Channel, number>;
  readonly p95: Record<Channel, number>;
}

async function measure(file: string): Promise<Row | null> {
  const image = await loadRoiImage(join(SAMPLE_DIR, file));
  const profile = readResistorImage(image, {}).analysis?.profile;
  if (profile === undefined || profile.length < 8) return null;

  const byChannel = <T,>(compute: (values: number[]) => T): Record<Channel, T> => ({
    l: compute(centralDifference(profile, 'l')),
    a: compute(centralDifference(profile, 'a')),
    b: compute(centralDifference(profile, 'b')),
  });

  return {
    file,
    samples: profile.length,
    mad: byChannel(mad),
    p95: byChannel((values) => percentile(values.map(Math.abs), 0.95)),
  };
}

const filters = process.argv.slice(2);
const files = readdirSync(SAMPLE_DIR)
  .filter((file) => /\.(jpe?g|png|webp)$/i.test(file))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  .sort();

const rows: Row[] = [];
for (const file of files) {
  const row = await measure(file);
  if (row !== null) rows.push(row);
}

if (rows.length === 0) {
  console.log('対象がありません');
  process.exit(0);
}

console.log(
  'ファイル'.padEnd(46),
  'N'.padStart(4),
  '  MAD(L)  MAD(a)  MAD(b)',
  '   p95(L)  p95(a)  p95(b)',
  '   SNR(L) SNR(a) SNR(b)',
);
for (const row of rows) {
  const snr = (channel: Channel): number => row.p95[channel] / Math.max(0.01, row.mad[channel]);
  console.log(
    basename(row.file).padEnd(46),
    String(row.samples).padStart(4),
    CHANNELS.map((c) => row.mad[c].toFixed(2).padStart(7)).join(' '),
    ' ',
    CHANNELS.map((c) => row.p95[c].toFixed(1).padStart(7)).join(' '),
    ' ',
    CHANNELS.map((c) => snr(c).toFixed(1).padStart(6)).join(' '),
  );
}

console.log(`\n枚数 ${rows.length}`);
const summary = (label: string, pick: (row: Row) => Record<Channel, number>): void => {
  const values = CHANNELS.map((c) => median(rows.map((row) => pick(row)[c])));
  console.log(`${label} 中央値   ` + CHANNELS.map((c, i) => `${c}* ${(values[i] as number).toFixed(2)}`).join('  '));
};
summary('MAD', (row) => row.mad);
summary('p95', (row) => row.p95);

// 係数の目安: 1/MAD の比。雑音の大きいチャンネルほど重みを下げる
const madMedian = CHANNELS.map((c) => median(rows.map((row) => row.mad[c])));
const base = madMedian[0] as number;
console.log(
  '1/MAD 比（L* を 1 としたとき）  ' +
    CHANNELS.slice(1)
      .map((c, i) => `${c}* ${(base / (madMedian[i + 1] as number)).toFixed(2)}`)
      .join('  '),
);
console.log(
  'SNR(p95/MAD) 中央値  ' +
    CHANNELS.map(
      (c) => `${c}* ${median(rows.map((row) => row.p95[c] / Math.max(0.01, row.mad[c]))).toFixed(1)}`,
    ).join('  '),
);
