import { describe, expect, it } from 'vitest';
import { outputSize, screenshotFileName, visibleSourceRect } from '../../src/debug/screenshot.js';

describe('screenshotFileName', () => {
  it('ohm-lens-年月日-時分 の形にする', () => {
    // Arrange: ローカル時刻で 2026-07-31 19:03
    const at = new Date(2026, 6, 31, 19, 3);

    // Act / Assert
    expect(screenshotFileName(at)).toBe('ohm-lens-2026-07-31-1903.jpg');
  });

  it('1 桁の月日時分は 0 で詰める', () => {
    expect(screenshotFileName(new Date(2026, 0, 5, 4, 7))).toBe('ohm-lens-2026-01-05-0407.jpg');
  });

  it('真夜中も 4 桁で出す', () => {
    expect(screenshotFileName(new Date(2026, 11, 1, 0, 0))).toBe('ohm-lens-2026-12-01-0000.jpg');
  });
});

describe('visibleSourceRect', () => {
  const video = { width: 1920, height: 1440 };
  const frame = { width: 800, height: 600 };

  it('等倍で全体が見えていれば映像全体を指す', () => {
    // Act
    const rect = visibleSourceRect(video, frame, { x: 0, y: 0, width: 800, height: 600 }, 1);

    // Assert
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1440 });
  });

  it('画面に出ている範囲だけを元映像の座標へ戻す', () => {
    // Arrange: 左右が切れて中央 400px ぶんだけ見えている
    const visible = { x: 200, y: 0, width: 400, height: 600 };

    // Act
    const rect = visibleSourceRect(video, frame, visible, 1);

    // Assert: 解析フレーム 1px = 元映像 2.4px
    expect(rect).toEqual({ x: 480, y: 0, width: 960, height: 1440 });
  });

  it('デジタルズーム中は中央の切り出し範囲を基準にする', () => {
    // Arrange: 2 倍ズーム → 解析フレームは元映像の中央 960x720 に対応する
    const visible = { x: 0, y: 0, width: 800, height: 600 };

    // Act
    const rect = visibleSourceRect(video, frame, visible, 2);

    // Assert
    expect(rect).toEqual({ x: 480, y: 360, width: 960, height: 720 });
  });

  it('ズームと切り取りが重なっても元映像の範囲を外れない', () => {
    // Arrange: 2 倍ズーム + 左右の切り取り
    const rect = visibleSourceRect(video, frame, { x: 200, y: 0, width: 400, height: 600 }, 2);

    // Assert
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(video.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(video.height);
  });
});

describe('outputSize', () => {
  it('小さい画像はそのまま', () => {
    expect(outputSize({ width: 960, height: 720 })).toEqual({ width: 960, height: 720 });
  });

  it('長辺が上限を超えたら縦横比を保って縮める', () => {
    // Act
    const size = outputSize({ width: 4000, height: 3000 }, 2000);

    // Assert
    expect(size).toEqual({ width: 2000, height: 1500 });
  });

  it('縦長でも長辺を基準にする', () => {
    expect(outputSize({ width: 1500, height: 3000 }, 2000)).toEqual({ width: 1000, height: 2000 });
  });
});
