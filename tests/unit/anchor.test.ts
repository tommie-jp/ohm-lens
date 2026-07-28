import { describe, expect, it } from 'vitest';
import { estimateBodyAnchor, nearestBodyReference } from '../../src/core/color/anchor.js';
import { BODY_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import type { ProfileSample } from '../../src/types.js';

/**
 * 本体色アンカーの推定と、基準本体色の選択。
 *
 * **基準は色みだけで選ぶ。** 観測アンカーの明度は露出でいくらでも動く
 * （39 枚の実測で基準への倍率は 1.10〜3.75 倍、しかも全枚数で 1 より大きい）。
 * 明度を判断に混ぜると「暗い青ボディ」が「ベージュ」に写され、b\* が
 * +29 も足されて青バンドが灰になる。
 */

const BEIGE = BODY_REFERENCE_COLORS.beige;
const LIGHTBLUE = BODY_REFERENCE_COLORS.lightblue;

describe('nearestBodyReference', () => {
  it('明るい青ボディには lightblue を選ぶ', () => {
    expect(nearestBodyReference(srgb255ToLab(170, 198, 214))).toStrictEqual(LIGHTBLUE);
  });

  it('明るいベージュボディには beige を選ぶ', () => {
    expect(nearestBodyReference(srgb255ToLab(208, 178, 138))).toStrictEqual(BEIGE);
  });

  it('露出が足りず暗く写った青ボディでも lightblue を選ぶ', () => {
    // Arrange: 39-10Mohm の実測アンカー（L20 a-7 b-5）。色みは青のままだが
    //          明度が基準から 3.75 倍離れている
    const underexposed = { l: 20, a: -7, b: -5 };

    // Act / Assert
    expect(nearestBodyReference(underexposed)).toStrictEqual(LIGHTBLUE);
  });

  it('暗く写ったベージュボディでも beige を選ぶ', () => {
    // Arrange: 37-10Mohm の実測アンカー（L42 a2 b33）
    expect(nearestBodyReference({ l: 42, a: 2, b: 33 })).toStrictEqual(BEIGE);
  });

  it('明度だけが違うアンカーは同じ基準を選ぶ', () => {
    const bright = { l: 80, a: -8, b: -12 };
    const dark = { l: 25, a: -8, b: -12 };

    expect(nearestBodyReference(dark)).toStrictEqual(nearestBodyReference(bright));
  });
});

describe('estimateBodyAnchor', () => {
  it('少数派のバンドに引っ張られず本体色を返す', () => {
    // Arrange: 本体色 7 列に対しバンド色 3 列
    const body = srgb255ToLab(200, 170, 130);
    const band = srgb255ToLab(200, 30, 30);
    const profile: ProfileSample[] = [
      ...Array.from({ length: 7 }, (_, x) => ({ x, lab: body })),
      ...Array.from({ length: 3 }, (_, i) => ({ x: 7 + i, lab: band })),
    ];

    // Act
    const anchor = estimateBodyAnchor(profile);

    // Assert
    expect(anchor?.a).toBeCloseTo(body.a, 5);
  });

  it('空のプロファイルでは null を返す', () => {
    expect(estimateBodyAnchor([])).toBeNull();
  });
});
