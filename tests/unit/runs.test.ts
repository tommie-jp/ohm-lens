import { describe, expect, it } from 'vitest';
import { identifyBody, splitRuns } from '../../src/core/bands/runs.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB, BODY_SRGB } from '../../src/core/color/colors.js';
import type { ProfileSample } from '../../src/types.js';

type Rgb = readonly [number, number, number];

function profileOf(spec: readonly (readonly [Rgb, number])[]): ProfileSample[] {
  const samples: ProfileSample[] = [];
  let x = 0;
  for (const [rgb, count] of spec) {
    const lab = srgb255ToLab(rgb[0], rgb[1], rgb[2]);
    for (let i = 0; i < count; i += 1) {
      samples.push({ x, lab });
      x += 1;
    }
  }
  return samples;
}

describe('splitRuns', () => {
  it('色が変わる位置でランに分割する', () => {
    // Arrange
    const profile = profileOf([
      [BODY_SRGB.beige, 6],
      [BAND_SRGB.red, 4],
      [BODY_SRGB.beige, 6],
    ]);

    // Act
    const runs = splitRuns(profile);

    // Assert
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => [r.start, r.end])).toEqual([
      [0, 6],
      [6, 10],
      [10, 16],
    ]);
  });

  it('ランの Lab は構成サンプルの中央値', () => {
    // Arrange
    const profile = profileOf([[BAND_SRGB.red, 5]]);
    const expected = srgb255ToLab(...(BAND_SRGB.red as [number, number, number]));

    // Act
    const runs = splitRuns(profile);

    // Assert
    expect(runs[0]?.lab.l).toBeCloseTo(expected.l, 6);
    expect(runs[0]?.lab.a).toBeCloseTo(expected.a, 6);
  });

  it('緩やかな変化では分割しない（同じバンド内のむら）', () => {
    // Arrange: 赤がわずかに変化していくだけ
    const samples: ProfileSample[] = [];
    for (let x = 0; x < 10; x += 1) {
      samples.push({ x, lab: srgb255ToLab(200 + x, 30, 30) });
    }

    // Act / Assert
    expect(splitRuns(samples)).toHaveLength(1);
  });

  it('短すぎるランは捨てる', () => {
    // Arrange: 1 サンプルだけのノイズが挟まる
    const profile = profileOf([
      [BODY_SRGB.beige, 6],
      [BAND_SRGB.green, 1],
      [BODY_SRGB.beige, 6],
    ]);

    // Act
    const runs = splitRuns(profile, { minRunLength: 2 });

    // Assert
    expect(runs.map((r) => r.end - r.start)).toEqual([6, 6]);
  });

  it('空のプロファイルは空配列', () => {
    expect(splitRuns([])).toEqual([]);
  });

  it('切れ目の閾値を指定できる', () => {
    // Arrange: 中程度に色が違う 2 区間
    const profile = profileOf([
      [[200, 30, 30], 5],
      [[170, 60, 40], 5],
    ]);

    // Act / Assert
    expect(splitRuns(profile, { edgeDeltaE: 2 })).toHaveLength(2);
    expect(splitRuns(profile, { edgeDeltaE: 40 })).toHaveLength(1);
  });
});

describe('identifyBody', () => {
  it('最も面積の大きい色を本体とみなす', () => {
    // Arrange: 本体が合計 12、バンドが 4
    const runs = splitRuns(
      profileOf([
        [BODY_SRGB.beige, 6],
        [BAND_SRGB.red, 4],
        [BODY_SRGB.beige, 6],
      ]),
    );

    // Act
    const body = identifyBody(runs);

    // Assert
    expect(body).not.toBeNull();
    expect(body?.runIndices).toEqual([0, 2]);
  });

  it('本体の範囲は最初と最後の本体ランの外端', () => {
    // Arrange: 背景 → 本体 → バンド → 本体 → 背景
    const runs = splitRuns(
      profileOf([
        [[250, 250, 250], 5],
        [BODY_SRGB.beige, 5],
        [BAND_SRGB.red, 4],
        [BODY_SRGB.beige, 5],
        [[250, 250, 250], 5],
      ]),
    );

    // Act
    const body = identifyBody(runs);

    // Assert
    expect(body?.extent).toEqual({ start: 5, end: 19 });
  });

  it('離れた位置にある同色のランをまとめて数える', () => {
    // Arrange: 本体が 3 か所に分かれている
    const runs = splitRuns(
      profileOf([
        [BODY_SRGB.beige, 4],
        [BAND_SRGB.red, 3],
        [BODY_SRGB.beige, 4],
        [BAND_SRGB.blue, 3],
        [BODY_SRGB.beige, 4],
      ]),
    );

    // Act
    const body = identifyBody(runs);

    // Assert
    expect(body?.runIndices).toEqual([0, 2, 4]);
  });

  it('ランが無ければ null', () => {
    expect(identifyBody([])).toBeNull();
  });

  it('本体色テーブルに無い色でも本体として扱える', () => {
    // Arrange: 緑色のボディ（ソ連製など）。面積が最大なら本体
    const runs = splitRuns(
      profileOf([
        [[40, 90, 60], 8],
        [BAND_SRGB.white, 3],
        [[40, 90, 60], 8],
      ]),
    );

    // Act
    const body = identifyBody(runs);

    // Assert
    expect(body?.runIndices).toEqual([0, 2]);
  });
});

describe('identifyBody — 円筒の陰影で明度が変わる本体', () => {
  /** 同じ色相のまま明度だけ落とす（円筒の端の陰影）。 */
  const shaded = (rgb: Rgb, factor: number): Rgb =>
    [
      Math.round(rgb[0] * factor),
      Math.round(rgb[1] * factor),
      Math.round(rgb[2] * factor),
    ] as const;

  it('明度の重みを下げると、陰で暗くなった本体も本体として拾う', () => {
    // Arrange: 中央が明るく、両端が暗いベージュ本体。間に赤バンド
    const runs = splitRuns(
      profileOf([
        [shaded(BODY_SRGB.beige, 0.62), 6],
        [BAND_SRGB.red, 4],
        [BODY_SRGB.beige, 8],
        [BAND_SRGB.red, 4],
        [shaded(BODY_SRGB.beige, 0.62), 6],
      ]),
    );

    // Act
    const body = identifyBody(runs, undefined, 0.35);

    // Assert: 明暗 3 つのランがすべて本体（バンドは残る）
    expect(body?.runIndices).toEqual([0, 2, 4]);
  });

  it('明度の重みを下げても、明度だけが違う黒バンドは本体に吸収しない', () => {
    // Arrange: ベージュ本体に黒バンド（黒は彩度がほぼ 0 でベージュと離れている）
    const runs = splitRuns(
      profileOf([
        [BODY_SRGB.beige, 8],
        [BAND_SRGB.black, 4],
        [BODY_SRGB.beige, 8],
      ]),
    );

    // Act
    const body = identifyBody(runs, undefined, 0.35);

    // Assert
    expect(body?.runIndices).toEqual([0, 2]);
  });

  it('重みを指定しなければ従来どおり（明度も等しく効く）', () => {
    // Arrange
    const runs = splitRuns(
      profileOf([
        [shaded(BODY_SRGB.beige, 0.62), 6],
        [BAND_SRGB.red, 4],
        [BODY_SRGB.beige, 8],
      ]),
    );

    // Act
    const body = identifyBody(runs);

    // Assert: 暗いベージュは別クラスタになる
    expect(body?.runIndices).toEqual([2]);
  });
});

describe('identifyBody — 代表色での取り込み直し', () => {
  it('明るい端から始まる本体でも、暗い端まで 1 つの本体にまとめる', () => {
    // Arrange: 明るい端 → 中間 → 暗い端、と段階的に暗くなる本体。
    // 先頭のランとだけ比べると、暗い端が閾値から外れて別扱いになる。
    const runs = splitRuns(
      profileOf([
        [[214, 188, 140], 5], // 明るいベージュ
        [BAND_SRGB.red, 4],
        [[178, 154, 112], 8], // 中間（本体の代表色）
        [BAND_SRGB.red, 4],
        [[140, 120, 86], 5], // 暗いベージュ
      ]),
    );

    // Act
    const body = identifyBody(runs, undefined, 0.7);

    // Assert
    expect(body?.runIndices).toEqual([0, 2, 4]);
  });

  it('取り込み直しでもバンドは吸収しない', () => {
    // Arrange
    const runs = splitRuns(
      profileOf([
        [BODY_SRGB.beige, 8],
        [BAND_SRGB.red, 4],
        [BODY_SRGB.beige, 8],
        [BAND_SRGB.blue, 4],
        [BODY_SRGB.beige, 8],
      ]),
    );

    // Act
    const body = identifyBody(runs, undefined, 0.7);

    // Assert
    expect(body?.runIndices).toEqual([0, 2, 4]);
  });
});

describe('identifyBody — 金・銀のように本体と色相が同じバンド', () => {
  /** 明度だけを落とす（金は本体ベージュと同色相で暗い）。 */
  const darker = (rgb: Rgb, factor: number): Rgb =>
    [
      Math.round(rgb[0] * factor),
      Math.round(rgb[1] * factor),
      Math.round(rgb[2] * factor),
    ] as [number, number, number];

  it('前後より暗く凹んだランは本体に取り込まない（金バンド）', () => {
    // Arrange: ベージュ本体の中に、色相そのままで暗い帯が 1 本
    const gold = darker(BODY_SRGB.beige, 0.74);
    const runs = splitRuns(
      profileOf([
        [BODY_SRGB.beige, 8],
        [gold, 4],
        [BODY_SRGB.beige, 8],
      ]),
    );

    // Act
    const body = identifyBody(runs, undefined, 0.6);

    // Assert: 金は本体から外れてバンド候補として残る
    expect(body?.runIndices).toEqual([0, 2]);
  });

  it('前後より明るく盛り上がったランも本体に取り込まない（銀バンド）', () => {
    // Arrange
    const silver = darker(BODY_SRGB.beige, 1.22);
    const runs = splitRuns(
      profileOf([
        [BODY_SRGB.beige, 8],
        [silver, 4],
        [BODY_SRGB.beige, 8],
      ]),
    );

    // Act
    const body = identifyBody(runs, undefined, 0.6);

    // Assert
    expect(body?.runIndices).toEqual([0, 2]);
  });

  it('端から端へ単調に暗くなる陰影は本体のまま', () => {
    // Arrange: 円筒の陰影。凹凸ではなく片側へ向かって暗くなるだけ
    const runs = splitRuns(
      profileOf([
        [BODY_SRGB.beige, 6],
        [darker(BODY_SRGB.beige, 0.88), 6],
        [darker(BODY_SRGB.beige, 0.76), 6],
        [darker(BODY_SRGB.beige, 0.66), 6],
      ]),
    );

    // Act
    const body = identifyBody(runs, undefined, 0.6);

    // Assert: 分割された本数によらず、全部が本体
    expect(body?.runIndices).toHaveLength(runs.length);
  });
});

describe('splitRuns の明度マージン', () => {
  /**
   * 金・銀のバンドは本体と**色相が同じで明度だけ違う**。実写 19 枚で測ると
   * 本体との ΔE76 は 4〜11 しかなく、切れ目のしきい値 20 にまるで届かない。
   * ΔE では切れないので、明度の落ち込みを別の基準として持つ。
   */

  /** 本体色から明度だけを下げた色（金バンドの見え方に相当）。 */
  function darker(sample: ProfileSample, drop: number): ProfileSample {
    return { x: sample.x, lab: { ...sample.lab, l: sample.lab.l - drop } };
  }

  function bodyWithDip(drop: number): ProfileSample[] {
    const body = profileOf([[BODY_SRGB.beige, 20]]);
    return body.map((sample, index) => (index >= 8 && index < 12 ? darker(sample, drop) : sample));
  }

  it('ΔE がしきい値に届かなくても、明度が落ち込む位置で切る', () => {
    // Arrange: L が 8 下がるだけの区間。ΔE76 も 8 なので edgeDeltaE 20 では切れない
    const profile = bodyWithDip(8);

    // Act
    const withoutMargin = splitRuns(profile, { edgeDeltaE: 20 });
    const withMargin = splitRuns(profile, { edgeDeltaE: 20, lightnessMargin: 5 });

    // Assert
    expect(withoutMargin).toHaveLength(1);
    expect(withMargin.map((run) => [run.start, run.end])).toEqual([
      [0, 8],
      [8, 12],
      [12, 20],
    ]);
  });

  it('指定しなければ従来どおり明度では切らない', () => {
    // Arrange
    const profile = bodyWithDip(8);

    // Act / Assert
    expect(splitRuns(profile, { edgeDeltaE: 20 })).toHaveLength(1);
  });

  it('マージンより浅い落ち込みでは切らない', () => {
    // Arrange
    const profile = bodyWithDip(3);

    // Act / Assert
    expect(splitRuns(profile, { edgeDeltaE: 20, lightnessMargin: 5 })).toHaveLength(1);
  });
});
