import { describe, expect, it } from 'vitest';
import {
  CAPTION_LINE_HEIGHT,
  blockHeightFor,
  buildAnnotationSvg,
  captionHeightFor,
  captionLines,
  expectedTableHeightFor,
  tableHeightFor,
  type AnnotateInput,
} from '../../src/annotate/render.js';
import {
  CHART,
  chartBlockHeight,
  differentiate,
  plotGeometry,
  stripBlockHeight,
} from '../../src/annotate/profileChart.js';
import type { StripData } from '../../src/annotate/profileChart.js';
import type { Band, ProfileSample } from '../../src/types.js';
import type { OrientedBox } from '../../src/core/locate.js';

/**
 * 焼き込み画像の段組み。
 *
 * 以前はキャプションを写真の上に半透明で重ねていたので、上端に写った抵抗器や
 * バンドが隠れた。写真の外に帯を作って独立した文字列として出す。
 * グラフも表の右に押し込むと細くなるため、幅いっぱいの段として積む。
 *
 * 上から順に: キャプション帯 / 写真 / カラーコード読み取り値の表 /
 * Lab グラフ / Lab 微分グラフ / 色空間パネル。
 */

const BOX: OrientedBox = {
  centerX: 200,
  centerY: 100,
  angleDeg: 0,
  length: 120,
  thickness: 40,
};

function bandsOf(colors: readonly Band['color'][]): Band[] {
  return colors.map((color, index) => ({
    color,
    start: index * 10,
    end: index * 10 + 8,
    confidence: 0.9,
  }));
}

function profileOf(length: number): NonNullable<AnnotateInput['profile']> {
  return {
    samples: Array.from({ length }, (_, x) => ({
      x,
      lab: { l: 50 + (x % 7), a: x % 3, b: -5 + (x % 5) },
    })),
    extent: { start: 2, end: length - 2 },
    runs: [
      { start: 3, end: 6 },
      { start: 10, end: 13 },
    ],
  };
}

function inputOf(overrides: Partial<AnnotateInput> = {}): AnnotateInput {
  return {
    width: 800,
    height: 200,
    box: BOX,
    bands: bandsOf(['red', 'red', 'brown']),
    rectify: { padding: 0.28, targetHeight: 40 },
    caption: '01-test.jpg | 期待 220Ω → 220Ω',
    ...overrides,
  };
}

describe('キャプション帯', () => {
  it('写真に重ねず、写真の上に独立した帯として出す', () => {
    // Arrange / Act
    const svg = buildAnnotationSvg(inputOf());

    // Assert: 写真の中身は帯のぶん下へずらして描く
    expect(svg).toContain(`translate(0,${CAPTION_LINE_HEIGHT})`);
    // 帯は不透明。半透明の黒を写真に被せていた頃の名残を残さない
    expect(svg).not.toContain('rgba(0,0,0,0.66)');
  });

  it('キャプションの文字は帯の中（写真より上）に置く', () => {
    // Arrange
    const svg = buildAnnotationSvg(inputOf({ caption: 'CAPTION-MARK' }));

    // Act: キャプションの text 要素の y を読む
    const match = svg.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*>CAPTION-MARK</);

    // Assert
    expect(match).not.toBeNull();
    expect(Number((match as RegExpMatchArray)[1])).toBeLessThan(CAPTION_LINE_HEIGHT);
  });

  it('幅に収まらないキャプションは折り返して帯を高くする', () => {
    // Arrange: 実際のキャプションは「ファイル名 | 期待 … | 角度 … | バンド列」と長い
    const long =
      '46-82kohm-5pct-carbonfilm-grey.jpg | 期待 82kΩ → 3.3GΩ [確信度 46%] | ' +
      '-1° L110 T30 (比 3.67) | grey×100,000,000 orange3 orange3';

    // Act
    const lines = captionLines(long, 800);

    // Assert: 折り返しても中身は落とさない
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(long);
    expect(captionHeightFor(long, 800)).toBe(lines.length * CAPTION_LINE_HEIGHT);
  });

  it('短いキャプションは 1 行のまま', () => {
    expect(captionLines('short.jpg | 220Ω', 800)).toHaveLength(1);
  });

  it('検出できなかった写真でもキャプションは帯に出す', () => {
    const svg = buildAnnotationSvg(inputOf({ box: null, bands: [], caption: 'NOT-FOUND' }));

    expect(svg).toContain('>NOT-FOUND<');
    expect(svg).not.toContain('rgba(0,0,0,0.66)');
  });
});

/** テスト用の ROI ストリップ。 */
function stripOf(
  scanRows: { start: number; end: number }[],
  runs: { start: number; end: number }[] = [],
): StripData {
  return {
    href: 'data:image/png;base64,AAAA',
    roiHeight: 40,
    roiWidth: 120,
    scanRows,
    runs,
    dropped: new Set<number>(),
    roiPadding: 0.28,
  };
}

describe('見出し', () => {
  it('バンド一覧表に「カラーコード読み取り値」を付ける', () => {
    expect(buildAnnotationSvg(inputOf())).toContain('>カラーコード読み取り値<');
  });

  it('Lab のグラフに「Labグラフ」を付ける', () => {
    expect(buildAnnotationSvg(inputOf({ profile: profileOf(40) }))).toContain('>Labグラフ<');
  });

  it('微分は 2 プレーンに分け、それぞれに見出しを付ける', () => {
    // Arrange / Act: abs は値域が違うので Lab 微分と別のプレーンにする
    const svg = buildAnnotationSvg(inputOf({ profile: profileOf(40) }));

    // Assert
    expect(svg).toContain('>absグラフ<');
    expect(svg).toContain('>Lab微分グラフ２<');
  });

  it('abs グラフには定義式を添える', () => {
    expect(buildAnnotationSvg(inputOf({ profile: profileOf(40) }))).toContain(
      'abs = |dL*/dx| + |da*/dx| + |db*/dx|',
    );
  });

  it('日本語フォントが無い環境では英字の見出しにする', () => {
    const svg = buildAnnotationSvg(inputOf({ profile: profileOf(40), japanese: false }));

    expect(svg).toContain('>Color code reading<');
    expect(svg).toContain('>Lab chart<');
    expect(svg).toContain('>abs chart<');
    expect(svg).toContain('>Lab derivative 2<');
    expect(svg).not.toContain('>Labグラフ<');
  });
});

describe('Lab グラフの段組み', () => {
  it('表の右ではなく、幅いっぱいの段として描く', () => {
    // Arrange: バンド数が変わっても左端は動かない（表の幅に依存しない）
    const narrow = buildAnnotationSvg(inputOf({ bands: bandsOf(['red']), profile: profileOf(40) }));
    const wide = buildAnnotationSvg(
      inputOf({
        bands: bandsOf(['red', 'red', 'brown', 'gold', 'silver']),
        profile: profileOf(40),
      }),
    );

    // Act: グラフの枠（背景の rect）の x と width を読む
    const frameOf = (svg: string): { x: number; width: number } => {
      const match = svg.match(
        new RegExp(`<rect x="([\\d.]+)" y="[\\d.]+" width="([\\d.]+)" height="${CHART.height}"`),
      );
      return {
        x: Number((match as RegExpMatchArray)[1]),
        width: Number((match as RegExpMatchArray)[2]),
      };
    };

    // Assert
    expect(frameOf(narrow)).toEqual(frameOf(wide));
    expect(frameOf(wide).width).toBeGreaterThan(700);
  });

  it('グラフは Lab → abs → Lab 微分２ の順に積む', () => {
    // Arrange
    const svg = buildAnnotationSvg(inputOf({ profile: profileOf(40) }));

    // Act: グラフの枠を上から拾う
    const tops = [
      ...svg.matchAll(
        new RegExp(`<rect x="[\\d.]+" y="([\\d.]+)" width="[\\d.]+" height="${CHART.height}"`, 'g'),
      ),
    ].map((match) => Number(match[1]));

    // Assert
    expect(tops).toHaveLength(3);
    expect(tops[1]).toBeGreaterThan(tops[0] as number);
    expect(tops[2]).toBeGreaterThan(tops[1] as number);
  });

  it('帯の高さは 表 + グラフ 3 枚 の積み上げ', () => {
    // Arrange / Act
    const height = blockHeightFor({
      bands: bandsOf(['red', 'red', 'brown']),
      profile: profileOf(40),
    });

    // Assert
    expect(height).toBe(tableHeightFor(3) + chartBlockHeight() * 3);
  });

  it('ROI ストリップを渡すとその高さぶん増える', () => {
    // Arrange
    const base = { bands: bandsOf(['red', 'red', 'brown']), profile: profileOf(40) };

    // Act
    const without = blockHeightFor(base);
    const withStrip = blockHeightFor({
      ...base,
      strip: stripOf([]),
    });

    // Assert
    expect(withStrip - without).toBe(stripBlockHeight());
  });
});

/**
 * 水平化・色補正した ROI のストリップ。
 *
 * Lab グラフと **X 軸を共有する**のが要点。別々に位置を計算すると、
 * 画像と % 目盛りの対応がずれて「グラフの 50% が画像のどこか」が読めなくなる。
 */
describe('ROI ストリップ', () => {

  it('画像の X 範囲が Lab グラフのプロット領域と一致する', () => {
    // Arrange
    const svg = buildAnnotationSvg(
      inputOf({ profile: profileOf(40), strip: stripOf([]) }),
    );
    const geometry = plotGeometry({ left: 0, top: 0, width: 800 });

    // Act
    const image = svg.match(/<image x="([\d.]+)"[^>]*width="([\d.]+)"/) as RegExpMatchArray;

    // Assert
    expect(Number(image[1])).toBeCloseTo((geometry as { left: number }).left, 1);
    expect(Number(image[2])).toBeCloseTo((geometry as { width: number }).width, 1);
  });

  it('走査線を白の点線で重ねる', () => {
    // Arrange / Act
    const svg = buildAnnotationSvg(
      inputOf({
        profile: profileOf(40),
        strip: stripOf([
          { start: 8, end: 11 },
          { start: 14, end: 17 },
        ]),
      }),
    );

    // Assert: 走査線 2 本ぶんの白い点線が出る
    const dashed = [...svg.matchAll(/<line[^>]*stroke="#ffffff"[^>]*stroke-dasharray/g)];
    expect(dashed).toHaveLength(2);
  });

  it('ストリップを渡さなければ画像を描かない', () => {
    expect(buildAnnotationSvg(inputOf({ profile: profileOf(40) }))).not.toContain('<image');
  });
});

describe('differentiate', () => {
  it('傾き一定の入力では微分も一定になる', () => {
    // Arrange: L* が 1 サンプルあたり 2 ずつ増える
    const samples: ProfileSample[] = Array.from({ length: 5 }, (_, x) => ({
      x,
      lab: { l: x * 2, a: 0, b: 0 },
    }));

    // Act
    const derived = differentiate(samples);

    // Assert
    expect(derived).toHaveLength(5);
    expect(derived.map((sample) => sample.lab.l)).toEqual([2, 2, 2, 2, 2]);
  });

  it('段差の位置で山ができる（ラン境界を見るための性質）', () => {
    // Arrange: 3 番目で L* が 50 跳ねる
    const values = [10, 10, 10, 60, 60, 60];
    const samples: ProfileSample[] = values.map((l, x) => ({
      x,
      lab: { l, a: 0, b: 0 },
    }));

    // Act
    const derived = differentiate(samples).map((sample) => sample.lab.l);

    // Assert: 跳ねの前後だけが大きい
    expect(Math.max(...derived)).toBe(25);
    expect(derived[0]).toBe(0);
    expect(derived[5]).toBe(0);
  });

  it('サンプルが 1 点以下なら空を返す（微分できない）', () => {
    expect(differentiate([])).toEqual([]);
    expect(differentiate([{ x: 0, lab: { l: 1, a: 2, b: 3 } }])).toEqual([]);
  });
});

/**
 * カラーコード期待値の表。
 *
 * 人手で確定した境界（`boundaries.json` の `verified: true`）だけを出す。
 * 種（推定値）を並べても検出そのものを写しているだけで、見比べる意味がない。
 */
describe('カラーコード期待値の表', () => {
  const labels = [
    { color: 'grey' as const, start: 12, end: 20 },
    { color: 'red' as const, start: 46, end: 54 },
  ];

  it('読み取り値の表の下に置く', () => {
    // Arrange
    const svg = buildAnnotationSvg(inputOf({ labels }));

    // Act: 見出しの y を読む
    const yOf = (title: string): number => {
      const match = svg.match(
        new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${title}<`),
      ) as RegExpMatchArray;
      return Number(match[1]);
    };

    // Assert
    expect(svg).toContain('>カラーコード期待値<');
    expect(yOf('カラーコード期待値')).toBeGreaterThan(yOf('カラーコード読み取り値'));
  });

  it('色名とカラーコード上の意味を出す（区間は出さない）', () => {
    // Arrange: 画像上は 金-橙-赤-灰。この向きでは金が数字に来てデコードできず、
    //          逆向き 灰-赤-橙-金 = 82kΩ ±5% が成立する
    const svg = buildAnnotationSvg(
      inputOf({
        labels: [
          { color: 'gold' as const, start: 19, end: 25 },
          { color: 'orange' as const, start: 47, end: 53 },
          { color: 'red' as const, start: 65, end: 71 },
          { color: 'grey' as const, start: 82, end: 88 },
        ],
      }),
    );

    // Assert: 読み取り値の表と同じ意味の表記になる
    expect(svg).toContain('>灰<');
    expect(svg).toContain('>±5%<');
    expect(svg).toContain('>×10³<');
    expect(svg).toContain('>8<');
    expect(svg).toContain('>2<');
    // 区間は出さない
    expect(svg).not.toContain('>19-25%<');
  });

  it('色が分かっていない区間は「?」にする', () => {
    const svg = buildAnnotationSvg(
      inputOf({
        labels: [
          { color: null, start: 5, end: 9 },
          { color: 'red' as const, start: 20, end: 26 },
          { color: 'brown' as const, start: 40, end: 46 },
        ],
      }),
    );

    expect(svg).toContain('>?<');
  });

  it('正解データが無ければ表も帯も足さない', () => {
    expect(buildAnnotationSvg(inputOf())).not.toContain('>カラーコード期待値<');
    expect(expectedTableHeightFor(undefined)).toBe(0);
    expect(expectedTableHeightFor([])).toBe(0);
  });

  it('期待値の表のぶん帯が高くなる', () => {
    const base = { bands: bandsOf(['red', 'red', 'brown']), profile: profileOf(40) };

    expect(blockHeightFor({ ...base, labels }) - blockHeightFor(base)).toBe(
      expectedTableHeightFor(labels),
    );
  });
});

/**
 * 格子の刻み。
 *
 * 5% 刻みで引き、10% の倍数は実線で濃く、その間は点線で薄くする。
 * バンドの境界を % で読み取るための目盛りなので、細かいほうが役に立つ。
 */
describe('格子の刻み', () => {
  it('5% 刻みの格子は点線で薄く引く', () => {
    const svg = buildAnnotationSvg(inputOf({ profile: profileOf(40) }));

    expect(svg).toContain(CHART.minorGridColor);
    expect(svg).toContain(`stroke-dasharray="${CHART.minorGridDash}"`);
  });

  it('10% 刻みの格子は実線（点線にしない）', () => {
    // Arrange
    const svg = buildAnnotationSvg(inputOf({ profile: profileOf(40) }));

    // Act: 濃い色の線を全部拾う
    const major = svg
      .split('<line')
      .filter((line) => line.includes(`stroke="${CHART.gridColor}"`));

    // Assert: Y 軸だけで 11 本（0〜100% の 10% 刻み）× グラフ 3 枚
    expect(major.length).toBeGreaterThan(30);
    expect(major.every((line) => !line.includes('stroke-dasharray'))).toBe(true);
  });

  it('5% 刻みの格子は必ず点線', () => {
    // Arrange
    const svg = buildAnnotationSvg(inputOf({ profile: profileOf(40) }));

    // Act
    const minor = svg
      .split('<line')
      .filter((line) => line.includes(`stroke="${CHART.minorGridColor}"`));

    // Assert
    expect(minor.length).toBeGreaterThan(30);
    expect(minor.every((line) => line.includes(`stroke-dasharray="${CHART.minorGridDash}"`))).toBe(
      true,
    );
  });
});

/** ROI ストリップの X 軸とラン境界。 */
describe('ROI ストリップの目盛りと境界', () => {
  it('X 軸の % ラベルを出す', () => {
    const svg = buildAnnotationSvg(
      inputOf({ profile: profileOf(40), strip: stripOf([]) }),
    );

    // グラフ 3 枚 + ストリップ 1 枚で、同じラベルが 4 回出る
    expect(svg.split('>0%<').length - 1).toBe(4);
  });

  it('ラン境界を赤い縦線で重ねる', () => {
    const svg = buildAnnotationSvg(
      inputOf({
        profile: profileOf(40),
        strip: stripOf([], [{ start: 10, end: 20 }]),
      }),
    );

    // ストリップの高さぶんの赤い縦線（境界 2 本）
    const lines = [...svg.matchAll(/<line[^>]*stroke="rgba\(255,59,48,0\.7\)"/g)];
    expect(lines).toHaveLength(2);
  });
});
