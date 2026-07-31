import { describe, expect, it } from 'vitest';
import type { RoiImage } from '../../src/core/bands/profile.js';
import { DEFAULT_PALETTE } from '../../src/core/color/palette.js';
import { createSampleImage, SAMPLE_EXPECTED } from '../../src/debug/sampleImage.js';
import {
  toTransferImage,
  type AnalysisMode,
  type AnalysisRequest,
} from '../../src/debug/analysis/protocol.js';
import { runAnalysis } from '../../src/debug/analysis/runAnalysis.js';

type Rgb = [number, number, number];

const BEIGE: Rgb = [210, 180, 140];
const YELLOW: Rgb = [235, 210, 50];
const VIOLET: Rgb = [120, 70, 160];
const RED: Rgb = [200, 30, 30];
const GOLD: Rgb = [200, 160, 50];

/** 「4.7kΩ ±5%」の抵抗器を模した ROI（pipeline.test.ts と同じ構成）。 */
function buildResistorRoi(): RoiImage {
  const layout: [Rgb, number][] = [
    [BEIGE, 12],
    [YELLOW, 6],
    [BEIGE, 5],
    [VIOLET, 6],
    [BEIGE, 5],
    [RED, 6],
    [BEIGE, 10],
    [GOLD, 6],
    [BEIGE, 14],
  ];

  const columns: Rgb[] = [];
  for (const [rgb, count] of layout) {
    for (let i = 0; i < count; i += 1) columns.push(rgb);
  }

  const width = columns.length;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = columns[x] as Rgb;
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/** 何も写っていない白背景。検出失敗の経路に使う。 */
function blankImage(): RoiImage {
  const width = 160;
  const height = 120;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 240;
    data[i * 4 + 1] = 240;
    data[i * 4 + 2] = 240;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function requestFor(
  image: RoiImage,
  mode: AnalysisMode,
  overrides: Partial<AnalysisRequest> = {},
): AnalysisRequest {
  return {
    frameId: 1,
    image: toTransferImage(image),
    mode,
    paletteColors: null,
    ...overrides,
  };
}

describe('runAnalysis: auto モード', () => {
  it('合成サンプル画像から 4.7kΩ ±5% を読み取る', () => {
    // Arrange
    const request = requestFor(createSampleImage(), { kind: 'auto' });

    // Act
    const response = runAnalysis(request);

    // Assert
    expect(response.box).not.toBeNull();
    expect(response.roi).not.toBeNull();
    expect(response.analysis?.reading?.ohms).toBeCloseTo(SAMPLE_EXPECTED.ohms, 6);
    expect(response.analysis?.reading?.tolerance).toBe(SAMPLE_EXPECTED.tolerancePercent);
  });

  it('検出できない画像では analysis が null（例外にしない）', () => {
    // Act
    const response = runAnalysis(requestFor(blankImage(), { kind: 'auto' }));

    // Assert
    expect(response.box).toBeNull();
    expect(response.roi).toBeNull();
    expect(response.analysis).toBeNull();
  });

  it('frameId をそのまま返す（応答の突き合わせに使う）', () => {
    const response = runAnalysis(
      requestFor(createSampleImage(), { kind: 'auto' }, { frameId: 42 }),
    );

    expect(response.frameId).toBe(42);
  });

  it('UI が読む項目だけ返す（走査線プロファイルは転送しない）', () => {
    const response = runAnalysis(requestFor(createSampleImage(), { kind: 'auto' }));

    expect(response.analysis).not.toBeNull();
    expect(Object.keys(response.analysis ?? {}).sort()).toEqual([
      'anchor',
      'bands',
      'profile',
      'reading',
      'runs',
    ]);
  });

  it('paletteColors から Worker 側でパレットを再構築して使える', () => {
    // Arrange: 既定パレットの colors を明示的に渡す（Palette は entries を持ち回らない）
    const request = requestFor(
      createSampleImage(),
      { kind: 'auto' },
      { paletteColors: DEFAULT_PALETTE.colors },
    );

    // Act
    const response = runAnalysis(request);

    // Assert: 既定パレットと同じ結果になる
    expect(response.analysis?.reading?.ohms).toBeCloseTo(SAMPLE_EXPECTED.ohms, 6);
  });
});

describe('runAnalysis: box モード（ライブガイド）', () => {
  it('検出済みの枠を渡すと同じ値が読める', () => {
    // Arrange: auto モードの検出結果を「ガイド枠」に見立てて渡す
    const image = createSampleImage();
    const located = runAnalysis(requestFor(image, { kind: 'auto' }));
    expect(located.box).not.toBeNull();

    // Act
    const response = runAnalysis(
      requestFor(image, { kind: 'box', box: located.box as NonNullable<typeof located.box> }),
    );

    // Assert
    expect(response.roi).not.toBeNull();
    expect(response.analysis?.reading?.ohms).toBeCloseTo(SAMPLE_EXPECTED.ohms, 6);
  });
});

describe('runAnalysis: roi モード（手動 ROI）', () => {
  it('ROI をそのまま解析して読み取る', () => {
    // Act
    const response = runAnalysis(
      requestFor(buildResistorRoi(), { kind: 'roi', adaptWhiteBalance: true }),
    );

    // Assert
    expect(response.box).toBeNull();
    expect(response.analysis?.reading?.ohms).toBeCloseTo(4700, 6);
  });

  it('入力画像を ROI としてそのまま返す（表示とバッファ返却のため）', () => {
    // Arrange
    const request = requestFor(buildResistorRoi(), { kind: 'roi', adaptWhiteBalance: true });

    // Act
    const response = runAnalysis(request);

    // Assert
    expect(response.roi).toBe(request.image);
  });

  it('adaptWhiteBalance: false で色順応補正を切れる（anchor が null）', () => {
    // Act
    const adapted = runAnalysis(
      requestFor(buildResistorRoi(), { kind: 'roi', adaptWhiteBalance: true }),
    );
    const raw = runAnalysis(
      requestFor(buildResistorRoi(), { kind: 'roi', adaptWhiteBalance: false }),
    );

    // Assert
    expect(adapted.analysis?.anchor).not.toBeNull();
    expect(raw.analysis?.anchor).toBeNull();
  });
});
