import { describe, expect, it } from 'vitest';
import {
  guideBox,
  GUIDE_ASPECT_RATIO,
  GUIDE_CENTER_Y_RATIO,
  GUIDE_LENGTH_RATIO,
} from '../../src/debug/guide.js';
import { coverVisibleRect } from '../../src/debug/viewMapping.js';

describe('guideBox', () => {
  it('横は可視範囲の中央、縦は上から 30% に水平な枠を置く', () => {
    // Act
    const box = guideBox({ x: 0, y: 0, width: 800, height: 600 });

    // Assert
    expect(box.centerX).toBe(400);
    expect(box.centerY).toBe(600 * GUIDE_CENTER_Y_RATIO);
    expect(box.angleDeg).toBe(0);
  });

  it('長さは可視範囲の幅から決まり、太さは抵抗器の縦横比に従う', () => {
    // Act
    const box = guideBox({ x: 0, y: 0, width: 800, height: 600 });

    // Assert
    expect(box.length).toBeCloseTo(800 * GUIDE_LENGTH_RATIO);
    expect(box.thickness).toBeCloseTo((800 * GUIDE_LENGTH_RATIO) / GUIDE_ASPECT_RATIO);
  });

  it('可視範囲がずれていれば枠もその範囲に付いていく', () => {
    // Arrange: 左右が切れて中央 400px だけ見えている状態
    const box = guideBox({ x: 200, y: 60, width: 400, height: 300 });

    // Assert
    expect(box.centerX).toBe(400);
    expect(box.centerY).toBe(60 + 300 * GUIDE_CENTER_Y_RATIO);
  });

  it('縦に潰れた可視範囲でも枠が高さからはみ出さない', () => {
    // Arrange: 横長すぎて縦横比どおりだと高さを超える
    const visible = { x: 0, y: 0, width: 1000, height: 100 };

    // Act
    const box = guideBox(visible);

    // Assert
    expect(box.thickness).toBeLessThanOrEqual(visible.height);
  });

  it('画面いっぱい表示で切り取られても枠は可視範囲に収まる', () => {
    // Arrange: 横長フレームを縦長画面に cover で出す（左右が大きく切れる）
    const frame = { width: 640, height: 480 };
    const visible = coverVisibleRect(frame, { width: 390, height: 720 });

    // Act
    const box = guideBox(visible);

    // Assert: 枠の左右端が可視範囲の内側にある
    expect(box.centerX - box.length / 2).toBeGreaterThanOrEqual(visible.x);
    expect(box.centerX + box.length / 2).toBeLessThanOrEqual(visible.x + visible.width);
    expect(box.centerY - box.thickness / 2).toBeGreaterThanOrEqual(visible.y);
    expect(box.centerY + box.thickness / 2).toBeLessThanOrEqual(visible.y + visible.height);
  });
});
