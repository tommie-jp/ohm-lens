import { describe, expect, it } from 'vitest';
import { bodyExtent } from '../../src/core/bands/extent.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB, BODY_SRGB } from '../../src/core/color/colors.js';
import type { ProfileSample } from '../../src/types.js';

type Rgb = readonly [number, number, number];

const BACKGROUND: Rgb = [250, 250, 250];

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

describe('bodyExtent', () => {
  it('前後の背景を除いた本体の範囲を返す', () => {
    // Arrange: 背景5 → 本体4 → バンド5 → 本体4 → 背景6
    const profile = profileOf([
      [BACKGROUND, 5],
      [BODY_SRGB.beige, 4],
      [BAND_SRGB.red, 5],
      [BODY_SRGB.beige, 4],
      [BACKGROUND, 6],
    ]);

    // Act
    const extent = bodyExtent(profile);

    // Assert
    expect(extent).toEqual({ start: 5, end: 18 });
  });

  it('本体が端まで続く場合は全体を返す', () => {
    const profile = profileOf([
      [BODY_SRGB.beige, 4],
      [BAND_SRGB.red, 5],
      [BODY_SRGB.beige, 4],
    ]);

    expect(bodyExtent(profile)).toEqual({ start: 0, end: 13 });
  });

  it('本体色が見つからなければ null', () => {
    expect(bodyExtent(profileOf([[BACKGROUND, 20]]))).toBeNull();
  });

  it('空のプロファイルは null', () => {
    expect(bodyExtent([])).toBeNull();
  });

  it('水色ボディでも検出できる', () => {
    // Arrange
    const profile = profileOf([
      [BACKGROUND, 4],
      [BODY_SRGB.lightblue, 3],
      [BAND_SRGB.brown, 4],
      [BODY_SRGB.lightblue, 3],
      [BACKGROUND, 4],
    ]);

    // Act / Assert
    expect(bodyExtent(profile)).toEqual({ start: 4, end: 14 });
  });

  it('孤立した本体色サンプル 1 点は無視する', () => {
    // Arrange: 背景の中に本体色が 1 点だけ紛れている（ノイズ）
    const profile = profileOf([
      [BACKGROUND, 3],
      [BODY_SRGB.beige, 1],
      [BACKGROUND, 5],
      [BODY_SRGB.beige, 4],
      [BAND_SRGB.red, 4],
      [BODY_SRGB.beige, 4],
      [BACKGROUND, 3],
    ]);

    // Act
    const extent = bodyExtent(profile, { minRunLength: 2 });

    // Assert: 孤立点(index 3)ではなく index 9 から始まる
    expect(extent?.start).toBe(9);
  });

  it('閾値を指定できる', () => {
    // Arrange: 本体色から少しずれた色。背景はどの本体色からも遠い暗色にする
    const darkBackground: Rgb = [40, 40, 40];
    const offBody: Rgb = [200, 172, 134];
    const profile = profileOf([
      [darkBackground, 4],
      [offBody, 6],
      [darkBackground, 4],
    ]);

    // Act / Assert
    expect(bodyExtent(profile, { bodyDeltaE: 2 })).toBeNull();
    expect(bodyExtent(profile, { bodyDeltaE: 15 })).toEqual({ start: 4, end: 10 });
  });
});
