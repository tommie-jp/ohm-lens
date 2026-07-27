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
