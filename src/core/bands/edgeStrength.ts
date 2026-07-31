import type { ProfileSample } from '../../types.js';

/**
 * バンド境界の強さを 1D プロファイルから測る。
 *
 * 素の中心差分は 2 サンプルしか使わないので雑音をそのまま増幅する。
 * ここでは Savitzky–Golay（多項式当てはめ）で**平滑化しながら微分**し、
 * チャンネルごとに雑音床で割ってから **max** を採る。
 *
 * 設計の根拠は `docs/13-バンド境界の検出指標.md`。要点は 3 つ。
 *
 * - 生の振幅では L\* が a\*・b\* の 2 倍以上だが、L\* は雑音も 2〜3 倍大きい。
 *   SNR で見ると 3 チャンネルは横並びなので、**雑音で割る**のが筋
 * - 雑音床は画像間で 35 倍ばらつく。固定係数はどの 1 枚にも最適にならないので、
 *   1 枚ごとに MAD で正規化する
 * - 境界は「どれか 1 チャンネルに出れば境界」。黒・灰・白・銀は L\* にしか出ず、
 *   茶・赤は a\*・b\* にしか出ない。和にすると片側の山が他の雑音で薄まるので max
 */

/** MAD を標準偏差の尺度に合わせる係数（正規分布のとき一致する）。 */
const MAD_SCALE = 1.4826;

/** 雑音床の下限。全サンプルが同値のときのゼロ割を避ける。 */
const MIN_SCALE = 0.05;

/** 平滑化の既定の窓幅 [サンプル]。最小バンド幅（2）より広く、バンドを潰さない程度。 */
const DEFAULT_WINDOW = 5;

export interface EdgeStrengthOptions {
  /** Savitzky–Golay の窓幅（奇数）。広いほど平滑だがバンドの縁が鈍る */
  readonly window?: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * 雑音床の頑健な推定（MAD）。
 *
 * 標準偏差だと境界そのもの（外れ値）に引っ張られて、雑音床を過大に見積もる。
 * 中央絶対偏差なら、列の半分以上が雑音である限り境界の影響を受けない。
 */
export function robustScale(values: readonly number[]): number {
  if (values.length === 0) return MIN_SCALE;
  const center = median(values);
  return Math.max(MIN_SCALE, MAD_SCALE * median(values.map((value) => Math.abs(value - center))));
}

/**
 * Savitzky–Golay の 1 次微分（2 次多項式、等間隔）。
 *
 * 窓の中で最小二乗の 2 次当てはめをして、その導関数を中央の値とする。
 * 係数は `x` が対称に並ぶことから閉じた形になり、重み `i / Σi²` で足すだけ。
 * 2 次までの形を歪めないので、バンドの縁のなだらかな立ち上がりを保てる。
 *
 * 端は窓が半分しか取れないので、取れる範囲で対称に縮める。
 */
export function savitzkyGolayDerivative(
  values: readonly number[],
  window: number = DEFAULT_WINDOW,
): number[] {
  if (values.length < 2) return values.length === 0 ? [] : [0];

  const half = Math.max(1, Math.floor(window / 2));

  return values.map((_, index) => {
    // 端では左右対称に取れる幅まで縮める（片側だけ伸ばすと傾きが偏る）
    const reach = Math.min(half, index, values.length - 1 - index);
    if (reach === 0) {
      // 端そのものは片側差分（幅 1）で代用する
      const near = index === 0 ? 1 : values.length - 2;
      return (values[near + 1] as number) - (values[near] as number);
    }

    let numerator = 0;
    let denominator = 0;
    for (let offset = -reach; offset <= reach; offset += 1) {
      numerator += offset * (values[index + offset] as number);
      denominator += offset * offset;
    }
    return numerator / denominator;
  });
}

/**
 * 境界の強さ（1 サンプルごと）。
 *
 * 各チャンネルを平滑化微分し、そのチャンネルの雑音床で割ってから最大を採る。
 * 返る値は「雑音の何倍か」なので、画像をまたいで比べられる。
 */
export function edgeStrength(
  profile: readonly ProfileSample[],
  options: EdgeStrengthOptions = {},
): number[] {
  if (profile.length < 2) return [];

  const window = options.window ?? DEFAULT_WINDOW;
  const channels = (['l', 'a', 'b'] as const).map((key) => {
    const derivative = savitzkyGolayDerivative(
      profile.map((sample) => sample.lab[key]),
      window,
    );
    const scale = robustScale(derivative);
    return derivative.map((value) => Math.abs(value) / scale);
  });

  return profile.map((_, index) =>
    Math.max(...channels.map((channel) => channel[index] as number)),
  );
}
