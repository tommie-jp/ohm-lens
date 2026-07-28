import { describe, expect, test } from 'vitest';
import { createSampleImage, SAMPLE_EXPECTED } from '../src/debug/sampleImage.js';
import { locateResistor } from '../src/core/locate.js';
import { refineBoxExtent } from '../src/core/refine.js';
import { rectify } from '../src/core/rectify.js';
import { analyzeRoi } from '../src/core/pipeline.js';
import { analyzeOptions, refineOptions, ROI_OPTIONS } from '../src/core/settings.js';

/**
 * 「サンプルで試す」は、写真もカメラも無い相手が最初に押すボタン。
 * ここが読めないと、初見の人はアプリが壊れていると受け取る。
 *
 * 一度、抵抗器が画面を埋めていたせいで検出の保護（前景が広すぎるときに
 * 閾値を上げ直す仕組み）が働き、本体が背景側に落ちて 90°・65px の縦長の
 * 箱になったことがある。同じことが起きないよう、合成画像から値が出るまでを
 * 通しで確かめる。
 */

describe('合成サンプル画像', () => {
  test('抵抗器を水平の 1 本として検出する', () => {
    // Arrange
    const image = createSampleImage();

    // Act
    const box = locateResistor(image);

    // Assert
    expect(box).not.toBeNull();
    expect(box?.angleDeg).toBeCloseTo(0, 0);
    // 本体は 186px 幅・66px 厚で描いてある
    expect(box?.length).toBeGreaterThan(150);
    expect(box?.thickness).toBeGreaterThan(40);
  });

  test('抵抗器が画面を埋めていない（検出の前景保護が働かない）', () => {
    // Arrange
    const image = createSampleImage();
    const box = locateResistor(image);

    // Act
    const occupied = ((box?.length ?? 0) * (box?.thickness ?? 0)) / (image.width * image.height);

    // Assert — 実写と同じく画面の 5〜35% に収まっていること
    expect(occupied).toBeGreaterThan(0.05);
    expect(occupied).toBeLessThan(0.35);
  });

  test(`${SAMPLE_EXPECTED.ohms}Ω ±${SAMPLE_EXPECTED.tolerancePercent}% として読める`, () => {
    // Arrange
    const image = createSampleImage();
    const located = locateResistor(image);
    expect(located).not.toBeNull();

    // Act — GUI と同じ経路（検出 → 枠の補正 → 切り出し → 解析）
    const box = refineBoxExtent(located!, image, refineOptions());
    const roi = rectify(image, box, ROI_OPTIONS);
    const result = analyzeRoi(roi, analyzeOptions(box));

    // Assert
    expect(result.reading?.ohms).toBe(SAMPLE_EXPECTED.ohms);
    expect(result.reading?.tolerance).toBe(SAMPLE_EXPECTED.tolerancePercent);
  });
});
