import { describe, expect, it } from 'vitest';
import { isBackgroundLike, locateResistor } from '../../src/core/locate.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import type { RoiImage } from '../../src/core/bands/profile.js';

type Rgb = readonly [number, number, number];

interface BarSpec {
  readonly width: number;
  readonly height: number;
  readonly background: Rgb;
  /** 背景に乗せるノイズの振れ幅（0 なら無地） */
  readonly noise?: number;
  readonly bar: Rgb;
  readonly length: number;
  readonly thickness: number;
  readonly angleDeg?: number;
  /** 本体の下に落ちる影（背景と同色相で暗い） */
  readonly shadow?: { readonly drop: number; readonly thickness: number };
  /** 本体と同じ向きに伸びる細いリード線 */
  readonly leads?: boolean;
  /** 画像の外周を囲む枠線（スキャン画像の縁など） */
  readonly frame?: { readonly width: number; readonly color: Rgb };
  /** 本体の途中で背景色に溶ける帯（白背景の白バンドを模す） */
  readonly blendedBand?: { readonly at: number; readonly width: number };
}

/** 決定的な擬似乱数（テストを再現可能にする）。 */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function drawScene(spec: BarSpec): RoiImage {
  const { width, height, background, bar, length, thickness } = spec;
  const data = new Uint8ClampedArray(width * height * 4);
  const random = makeRandom(42);
  const noise = spec.noise ?? 0;

  for (let i = 0; i < width * height; i += 1) {
    const jitter = noise === 0 ? 0 : Math.round((random() - 0.5) * 2 * noise);
    data[i * 4] = background[0] + jitter;
    data[i * 4 + 1] = background[1] + jitter;
    data[i * 4 + 2] = background[2] + jitter;
    data[i * 4 + 3] = 255;
  }

  const rad = ((spec.angleDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const centerX = width / 2;
  const centerY = height / 2;

  const paint = (
    halfLength: number,
    acrossFrom: number,
    acrossTo: number,
    rgb: readonly [number, number, number],
  ): void => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        const along = dx * cos + dy * sin;
        const across = -dx * sin + dy * cos;
        if (Math.abs(along) > halfLength || across < acrossFrom || across > acrossTo) continue;
        const offset = (y * width + x) * 4;
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
      }
    }
  };

  // 影は本体のすぐ下に、背景と同色相で暗く落ちる
  if (spec.shadow !== undefined) {
    const shadowRgb = background.map((channel) => channel - spec.shadow!.drop) as unknown as Rgb;
    paint(length / 2, thickness / 2, thickness / 2 + spec.shadow.thickness, shadowRgb);
  }
  if (spec.leads === true) paint(length, -2, 2, [150, 150, 150]);
  paint(length / 2, -thickness / 2, thickness / 2, bar);

  // 背景と同じ色の帯。本体に「穴」が開いた状態になる
  if (spec.blendedBand !== undefined) {
    const { at, width: bandWidth } = spec.blendedBand;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        const along = dx * cos + dy * sin;
        const across = -dx * sin + dy * cos;
        if (Math.abs(along - at) > bandWidth / 2) continue;
        // 上側 7 割を背景色で塗る（残る断面は本体の 3 割）
        if (across < -thickness / 2 || across > thickness * 0.2) continue;
        const offset = (y * width + x) * 4;
        data[offset] = background[0];
        data[offset + 1] = background[1];
        data[offset + 2] = background[2];
      }
    }
  }

  if (spec.frame !== undefined) {
    const { width: frameWidth, color } = spec.frame;
    for (let y = 0; y < height; y += 1) {
      const isFrameRow = y < frameWidth || y >= height - frameWidth;
      for (let x = 0; x < width; x += 1) {
        if (!isFrameRow && x >= frameWidth && x < width - frameWidth) continue;
        const offset = (y * width + x) * 4;
        data[offset] = color[0];
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
      }
    }
  }

  return { width, height, data };
}

describe('isBackgroundLike — 影と照明ムラの扱い', () => {
  const background = srgb255ToLab(160, 160, 158);

  it('背景そのものは背景', () => {
    expect(isBackgroundLike(background, background, 10)).toBe(true);
  });

  it('色相が同じでわずかに暗いだけの画素は影とみなして背景に含める', () => {
    // Arrange: 明度だけ下げた（机に落ちた影）
    const shadow = srgb255ToLab(130, 130, 128);

    // Act / Assert
    expect(isBackgroundLike(shadow, background, 10)).toBe(true);
  });

  it('黒バンドのように大きく暗い画素は前景のまま', () => {
    // Arrange: 影と違い、明度の落差が大きい
    const black = srgb255ToLab(30, 30, 30);

    // Act / Assert
    expect(isBackgroundLike(black, background, 10)).toBe(false);
  });

  it('色相が違えば暗くても前景（青ボディなど）', () => {
    const blue = srgb255ToLab(60, 110, 150);

    expect(isBackgroundLike(blue, background, 10)).toBe(false);
  });

  it('色相が同じでわずかに明るいだけの画素も背景に含める（照明ムラ）', () => {
    // Arrange: 同じ机が光源側で明るいだけ。色度はほぼ変わらない
    const lit = srgb255ToLab(205, 205, 203);

    // Act / Assert
    expect(isBackgroundLike(lit, background, 10)).toBe(true);
  });

  it('白飛びするほど明るい画素は前景（別の物体とみなす）', () => {
    const blown = srgb255ToLab(252, 252, 250);

    expect(isBackgroundLike(blown, background, 10)).toBe(false);
  });
});

describe('locateResistor — 影があっても太さを膨らませない', () => {
  it('本体の下に影があっても太さは本体ぶんに収まる', () => {
    // Arrange: 本体 40px の下に 30px の影
    const image = drawScene({
      width: 300,
      height: 200,
      background: [160, 160, 158],
      bar: [210, 180, 140],
      length: 160,
      thickness: 40,
      shadow: { drop: 30, thickness: 30 },
    });

    // Act
    const box = locateResistor(image);

    // Assert: 影込みなら 70px 近くになる
    expect(box).not.toBeNull();
    expect(box!.thickness).toBeLessThan(56);
    expect(box!.length / box!.thickness).toBeGreaterThan(2.8);
  });
});

describe('locateResistor — 背景が広く前景になる場合', () => {
  it('背景にムラがあっても抵抗器を選ぶ', () => {
    // Arrange: ざらついた背景（机やカーペット）に本体を置く
    const image = drawScene({
      width: 320,
      height: 240,
      background: [150, 140, 130],
      noise: 26,
      bar: [210, 180, 140],
      length: 170,
      thickness: 42,
    });

    // Act
    const box = locateResistor(image);

    // Assert: 画像全体ではなく細長い塊が選ばれる
    expect(box).not.toBeNull();
    expect(box!.length).toBeLessThan(240);
    expect(box!.length / box!.thickness).toBeGreaterThan(2.5);
  });

  it('前景が画像の大半を占めても、抵抗器の大きさに収まる', () => {
    // Arrange: 背景が暗く、抵抗器が明るい（カーペット上の撮影を模す）
    const image = drawScene({
      width: 320,
      height: 240,
      background: [70, 60, 55],
      noise: 34,
      bar: [220, 190, 150],
      length: 180,
      thickness: 44,
    });

    // Act
    const box = locateResistor(image);

    // Assert: 画像いっぱい（比 1.3 など）にならないこと
    expect(box).not.toBeNull();
    expect(box!.length / box!.thickness).toBeGreaterThan(2.5);
  });
});

describe('locateResistor — 細い構造に引きずられない', () => {
  it('リード線が画像の枠線に触れていても本体の向きを見失わない', () => {
    // Arrange: スキャン画像の黒縁。リード線が縁まで届いて一続きになる
    const image = drawScene({
      width: 400,
      height: 300,
      background: [250, 250, 250],
      bar: [210, 180, 140],
      length: 240,
      thickness: 90,
      leads: true,
      frame: { width: 8, color: [20, 20, 20] },
    });

    // Act
    const box = locateResistor(image);

    // Assert: 枠を含む塊の主軸ではなく、本体の水平な主軸が出る
    expect(box).not.toBeNull();
    expect(Math.abs(((box!.angleDeg + 90 + 360) % 180) - 90)).toBeLessThan(5);
    expect(box!.length / box!.thickness).toBeGreaterThan(2);
  });
});

describe('locateResistor — 本体の途中が背景色に溶ける場合', () => {
  it('白背景の白バンドで穴が開いても長さは縮まない', () => {
    // Arrange: 本体 240px の中央付近に、背景と同色の帯を 40px
    const image = drawScene({
      width: 400,
      height: 300,
      background: [250, 250, 250],
      bar: [210, 180, 140],
      length: 240,
      thickness: 90,
      blendedBand: { at: 0, width: 40 },
    });

    // Act
    const box = locateResistor(image);

    // Assert: 穴の手前で切らず、本体ぜんぶを 1 つの範囲として返す
    expect(box).not.toBeNull();
    expect(box!.length).toBeGreaterThan(200);
  });

  it('中心線の違う別の塊までは繋がない', () => {
    // Arrange: 本体（中央・太さ 90）と、その左上にある別の塊（反射など）を
    // 太めのリード線で繋ぐ。開処理では切れない太さにしてある。
    const width = 520;
    const height = 300;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 250;
      data[i * 4 + 1] = 250;
      data[i * 4 + 2] = 250;
      data[i * 4 + 3] = 255;
    }
    const fill = (x0: number, x1: number, y0: number, y1: number): void => {
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * 4;
          data[offset] = 210;
          data[offset + 1] = 180;
          data[offset + 2] = 140;
        }
      }
    };
    fill(260, 460, 105, 195); // 本体 200x90、中心 y=150
    fill(150, 240, 40, 110); // 別の塊 90x70、中心 y=75
    // 橋。開処理では切れない太さだが、本体とみなす太さには届かない
    fill(240, 252, 62, 100);
    fill(248, 262, 95, 130);

    // Act
    const box = locateResistor({ width, height, data });

    // Assert: 本体に留まり、左の塊まで一続きにしない
    expect(box).not.toBeNull();
    expect(box!.length).toBeLessThan(260);
  });
});

describe('locateResistor — 従来の挙動を壊さない', () => {
  it.each([0, 24, -30])('角度 %s 度でも向きを検出する', (angleDeg) => {
    const image = drawScene({
      width: 300,
      height: 300,
      background: [245, 245, 245],
      bar: [210, 180, 140],
      length: 160,
      thickness: 44,
      angleDeg,
    });

    const box = locateResistor(image);

    expect(box).not.toBeNull();
    const diff = Math.abs(((box!.angleDeg - angleDeg + 90 + 360) % 180) - 90);
    expect(diff).toBeLessThan(5);
  });

  it('リード線があっても本体の太さを返す', () => {
    const image = drawScene({
      width: 360,
      height: 240,
      background: [245, 245, 245],
      bar: [210, 180, 140],
      length: 160,
      thickness: 44,
      leads: true,
    });

    const box = locateResistor(image);

    expect(box!.thickness).toBeGreaterThan(30);
    expect(box!.thickness).toBeLessThan(58);
  });

  it('被写体がなければ null', () => {
    const image = drawScene({
      width: 120,
      height: 90,
      background: [245, 245, 245],
      bar: [245, 245, 245],
      length: 1,
      thickness: 1,
    });

    expect(locateResistor(image)).toBeNull();
  });
});
