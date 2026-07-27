import { describe, expect, it } from 'vitest';
import { bodyExtent } from '../../src/core/bands/extent.js';
import { segmentBands } from '../../src/core/bands/segment.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB, BODY_SRGB } from '../../src/core/color/colors.js';
import type { ProfileSample } from '../../src/types.js';

/**
 * 前提: ROI は rectify で本体に寄せて切り出されているので、本体が
 * 画像内で最大の面積を占める。背景は端に少し残る程度。
 */

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
  it('端に残った背景を除いた本体の範囲を返す', () => {
    // Arrange: 背景3 → 本体8 → バンド4 → 本体8 → 背景3
    const profile = profileOf([
      [BACKGROUND, 3],
      [BODY_SRGB.beige, 8],
      [BAND_SRGB.red, 4],
      [BODY_SRGB.beige, 8],
      [BACKGROUND, 3],
    ]);

    // Act / Assert
    expect(bodyExtent(profile)).toEqual({ start: 3, end: 23 });
  });

  it('本体が端まで続く場合は全体を返す', () => {
    const profile = profileOf([
      [BODY_SRGB.beige, 8],
      [BAND_SRGB.red, 4],
      [BODY_SRGB.beige, 8],
    ]);

    expect(bodyExtent(profile)).toEqual({ start: 0, end: 20 });
  });

  it('単色のプロファイルは全体が本体（バンドは 0 本）', () => {
    // Arrange
    const profile = profileOf([[BACKGROUND, 20]]);

    // Act / Assert
    expect(bodyExtent(profile)).toEqual({ start: 0, end: 20 });
    expect(segmentBands(profile)).toEqual([]);
  });

  it('空のプロファイルは null', () => {
    expect(bodyExtent([])).toBeNull();
  });

  it('水色ボディでも検出できる', () => {
    // Arrange
    const profile = profileOf([
      [BACKGROUND, 3],
      [BODY_SRGB.lightblue, 7],
      [BAND_SRGB.brown, 4],
      [BODY_SRGB.lightblue, 7],
      [BACKGROUND, 3],
    ]);

    // Act / Assert
    expect(bodyExtent(profile)).toEqual({ start: 3, end: 21 });
  });

  it('本体色テーブルに無いボディ色でも検出できる', () => {
    // Arrange: 緑色のボディ（ソ連製など）
    const green: Rgb = [40, 90, 60];
    const profile = profileOf([
      [BACKGROUND, 3],
      [green, 8],
      [BAND_SRGB.white, 4],
      [green, 8],
      [BACKGROUND, 3],
    ]);

    // Act / Assert
    expect(bodyExtent(profile)).toEqual({ start: 3, end: 23 });
  });

  it('孤立したサンプル 1 点はノイズとして無視する', () => {
    // Arrange: 本体の中に 1 点だけ別色が紛れている
    const profile = profileOf([
      [BODY_SRGB.beige, 8],
      [BAND_SRGB.green, 1],
      [BODY_SRGB.beige, 8],
    ]);

    // Act / Assert
    expect(segmentBands(profile, { minBandWidth: 2 })).toEqual([]);
  });

  it('クラスタ閾値を指定できる', () => {
    // Arrange: 本体色からわずかにずれた区間。閾値を広げれば本体に含まれる
    const offBody: Rgb = [200, 172, 134];
    const profile = profileOf([
      [BODY_SRGB.beige, 8],
      [offBody, 5],
      [BODY_SRGB.beige, 8],
    ]);

    // Act / Assert: 切れ目の閾値を下げてランを分けたうえで、
    // クラスタ閾値によって本体に含めるかどうかが変わる
    expect(segmentBands(profile, { edgeDeltaE: 1, clusterDeltaE: 20 })).toEqual([]);
    expect(segmentBands(profile, { edgeDeltaE: 1, clusterDeltaE: 0.5 }).length).toBe(1);
  });
});
