import { describe, expect, it } from 'vitest';
import { segmentBands } from '../../src/core/bands/segment.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BODY_REFERENCE_COLORS } from '../../src/core/color/colors.js';
import type { ProfileSample } from '../../src/types.js';

const BODY = BODY_REFERENCE_COLORS.beige;

/**
 * 「本体色 n 列 → バンド色 m 列 → …」というプロファイルを組み立てる。
 * spec は [色, 列数] の並び。null は本体色。
 */
function profileOf(spec: readonly [[number, number, number] | null, number][]): ProfileSample[] {
  const samples: ProfileSample[] = [];
  let x = 0;
  for (const [rgb, count] of spec) {
    const lab = rgb === null ? BODY : srgb255ToLab(rgb[0], rgb[1], rgb[2]);
    for (let i = 0; i < count; i += 1) {
      samples.push({ x, lab });
      x += 1;
    }
  }
  return samples;
}

const RED: [number, number, number] = [200, 30, 30];
const VIOLET: [number, number, number] = [120, 70, 160];
const GREEN: [number, number, number] = [40, 130, 70];
const BLUE: [number, number, number] = [40, 80, 170];
const YELLOW: [number, number, number] = [235, 210, 50];
const GOLD: [number, number, number] = [200, 160, 50];

describe('segmentBands', () => {
  it('本体色に挟まれた 4 本のバンドを抽出する', () => {
    // Arrange
    const profile = profileOf([
      [null, 10],
      [YELLOW, 5],
      [null, 4],
      [VIOLET, 5],
      [null, 4],
      [RED, 5],
      [null, 8],
      [GOLD, 5],
      [null, 10],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert
    expect(bands).toHaveLength(4);
    expect(bands.map((band) => band.color)).toEqual(['yellow', 'violet', 'red', 'gold']);
  });

  it('抽出したバンドの位置が正しい', () => {
    // Arrange
    const profile = profileOf([
      [null, 10],
      [RED, 5],
      [null, 10],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert
    expect(bands[0]?.start).toBe(10);
    expect(bands[0]?.end).toBe(15);
  });

  it('幅が閾値未満のランはノイズとして捨てる', () => {
    // Arrange: 1 列だけの赤（ノイズ）と 5 列の紫
    const profile = profileOf([
      [null, 10],
      [RED, 1],
      [null, 5],
      [VIOLET, 5],
      [null, 10],
    ]);

    // Act
    const bands = segmentBands(profile, { minBandWidth: 3 });

    // Assert
    expect(bands).toHaveLength(1);
    expect(bands[0]?.color).toBe('violet');
  });

  it('本体色しかないプロファイルからはバンドが出ない', () => {
    expect(segmentBands(profileOf([[null, 30]]))).toEqual([]);
  });

  it('空のプロファイルは空配列を返す', () => {
    expect(segmentBands([])).toEqual([]);
  });

  it('解析範囲の端に接したランはバンドにしない', () => {
    // Arrange: 先頭と末尾に本体色を挟まずに色が付いている。
    // 解析範囲は検出した本体そのものなので、バンドの外側には必ず地の色がある。
    // 端から始まる色は本体の肩の照り返しか、はみ出した背景。
    const profile = profileOf([
      [RED, 5],
      [null, 8],
      [VIOLET, 5],
      [null, 8],
      [GREEN, 5],
      [null, 8],
      [BLUE, 5],
      [null, 8],
      [YELLOW, 5],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert: 端の赤と黄が落ちる
    expect(bands.map((band) => band.color)).toEqual(['violet', 'green', 'blue']);
  });

  it('端を落とすと 3 本を切る場合は落とさない', () => {
    // Arrange: バンドが 3 本しかなく、うち 2 本が端に接している
    const profile = profileOf([
      [RED, 5],
      [null, 8],
      [VIOLET, 5],
      [null, 8],
      [GREEN, 5],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert: 読めなくなるより、端のランを残すほうがまし
    expect(bands.map((band) => band.color)).toEqual(['red', 'violet', 'green']);
  });

  it('端に接していないバンドは残す', () => {
    // Arrange: 本体色 → 赤 → 本体色 → 紫 → 本体色
    const profile = profileOf([
      [null, 6],
      [RED, 5],
      [null, 8],
      [VIOLET, 5],
      [null, 6],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert
    expect(bands.map((band) => band.color)).toEqual(['red', 'violet']);
  });

  it('濃淡で 2 本に割れた同じバンドは 1 本に戻す', () => {
    // Arrange: 太い赤バンドの中で明度だけが落ちる（縁のぼけ・陰）
    const dark = [Math.round(RED[0] * 0.86), Math.round(RED[1] * 0.86), Math.round(RED[2] * 0.86)] as [number, number, number];
    const profile = profileOf([
      [null, 8],
      [RED, 5],
      [dark, 5],
      [null, 8],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert
    expect(bands).toHaveLength(1);
    expect(bands[0]?.start).toBe(8);
    expect(bands[0]?.end).toBe(18);
  });

  it('隣接する異なる色は別のバンドとして分割する', () => {
    // Arrange: 本体色を挟まずに赤と紫が隣接
    const profile = profileOf([
      [null, 5],
      [RED, 5],
      [VIOLET, 5],
      [null, 5],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert
    expect(bands.map((band) => band.color)).toEqual(['red', 'violet']);
  });

  it('バンドの確信度は構成サンプルの分類確信度に基づく', () => {
    // Arrange
    const profile = profileOf([
      [null, 5],
      [RED, 5],
      [null, 5],
    ]);

    // Act
    const bands = segmentBands(profile);

    // Assert
    expect(bands[0]?.confidence).toBeGreaterThan(0.5);
    expect(bands[0]?.confidence).toBeLessThanOrEqual(1);
  });

  it('本体色に近い区間はクラスタ閾値しだいで本体に含まれる', () => {
    // Arrange: 本体色に近いが少しずれた色
    const offBody: [number, number, number] = [205, 178, 138];
    const profile = profileOf([
      [null, 5],
      [offBody, 5],
      [null, 5],
    ]);

    // Act / Assert: 閾値を広げれば本体として吸収され、絞ればバンドになる
    expect(segmentBands(profile, { edgeDeltaE: 1, clusterDeltaE: 20 })).toEqual([]);
    expect(segmentBands(profile, { edgeDeltaE: 1, clusterDeltaE: 0.5 })).toHaveLength(1);
  });
});
