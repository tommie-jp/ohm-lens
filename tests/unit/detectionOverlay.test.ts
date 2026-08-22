import { describe, expect, it } from 'vitest';
import { drawBandLabels } from '../../src/debug/detectionOverlay.js';
import type { OrientedBox } from '../../src/core/locate.js';
import type { UsedRun } from '../../src/core/value/jointDecode.js';
import type { Band } from '../../src/types.js';

/**
 * ライブのバンド表示は、**値を決めた解釈と同じものを描く**。
 *
 * 表示だけが独立分類（`toBands`）のままだと、デコーダが金属容疑として
 * 除外した本体色のランが「白 9」のようなカラーコードとして画面に出る。
 * 値は守られているのに読み取りが壊れて見える、という食い違いが起きる。
 */

const BOX: OrientedBox = {
  centerX: 200,
  centerY: 100,
  angleDeg: 0,
  length: 120,
  thickness: 40,
};

/** 描画呼び出しを記録するだけの 2D コンテキスト。node で動かすため。 */
interface DrawnText {
  readonly text: string;
  readonly dashed: boolean;
  readonly alpha: number;
}

function fakeContext(): { context: CanvasRenderingContext2D; texts: DrawnText[] } {
  const texts: DrawnText[] = [];
  const stack: { dash: number[]; alpha: number }[] = [];
  let dash: number[] = [];

  const fake = {
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    strokeStyle: '',
    fillStyle: '',
    save(): void {
      stack.push({ dash: [...dash], alpha: fake.globalAlpha });
    },
    restore(): void {
      const previous = stack.pop();
      if (previous === undefined) return;
      dash = previous.dash;
      fake.globalAlpha = previous.alpha;
    },
    setLineDash(next: readonly number[]): void {
      dash = [...next];
    },
    beginPath(): void {},
    closePath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    rect(): void {},
    stroke(): void {},
    fill(): void {},
    translate(): void {},
    rotate(): void {},
    strokeText(): void {},
    fillText(text: string): void {
      texts.push({ text, dashed: dash.length > 0, alpha: fake.globalAlpha });
    },
  };

  return { context: fake as unknown as CanvasRenderingContext2D, texts };
}

function bandsOf(colors: readonly Band['color'][]): Band[] {
  return colors.map((color, index) => ({
    color,
    start: index * 12,
    end: index * 12 + 8,
    confidence: 0.9,
  }));
}

const RECTIFY = { padding: 0.28, targetHeight: 40 };

describe('drawBandLabels', () => {
  it('採用されたランには、同時デコードが決めた意味を描く', () => {
    // Arrange: デコーダは 3 本を数字・倍率として採用した
    const { context, texts } = fakeContext();
    const bands = bandsOf(['brown', 'black', 'red']);
    const usedRuns: UsedRun[] = [
      { runIndex: 0, color: 'brown', role: 'digit', roleText: '1' },
      { runIndex: 1, color: 'black', role: 'digit', roleText: '0' },
      { runIndex: 2, color: 'red', role: 'multiplier', roleText: '×100' },
    ];

    // Act
    drawBandLabels(context, BOX, bands, { rectify: RECTIFY, usedRuns, droppedRuns: [] });

    // Assert
    const drawn = texts.map((entry) => entry.text);
    expect(drawn).toContain('1');
    expect(drawn).toContain('×100');
    expect(drawn).not.toContain('除外');
  });

  it('デコーダが採用しなかったランは「除外」と描き、破線で薄くする', () => {
    // Arrange: 4 本目は本体色を拾ったもので、デコーダは採用していない
    const { context, texts } = fakeContext();
    const bands = bandsOf(['brown', 'black', 'red', 'white']);
    const usedRuns: UsedRun[] = [
      { runIndex: 0, color: 'brown', role: 'digit', roleText: '1' },
      { runIndex: 1, color: 'black', role: 'digit', roleText: '0' },
      { runIndex: 2, color: 'red', role: 'multiplier', roleText: '×100' },
    ];

    // Act
    drawBandLabels(context, BOX, bands, { rectify: RECTIFY, usedRuns, droppedRuns: [3] });

    // Assert: 除外の印が出ていて、カラーコードとしての意味は描かれない
    const excluded = texts.filter((entry) => entry.text === '除外');
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.alpha).toBeLessThan(1);
  });

  it('採用情報が無ければ、従来どおり全バンドから意味を組み立てる', () => {
    // Arrange: 静止画の焼き込みなど、joint の解が無い経路
    const { context, texts } = fakeContext();

    // Act
    drawBandLabels(context, BOX, bandsOf(['brown', 'black', 'red']), { rectify: RECTIFY });

    // Assert
    expect(texts.map((entry) => entry.text)).not.toContain('除外');
    expect(texts.length).toBeGreaterThan(0);
  });

  it('除外したランの帯は破線で描く', () => {
    // Arrange
    const { context } = fakeContext();
    const dashes: number[][] = [];
    const spy = context as unknown as { setLineDash: (dash: readonly number[]) => void };
    const original = spy.setLineDash.bind(spy);
    spy.setLineDash = (dash: readonly number[]): void => {
      dashes.push([...dash]);
      original(dash);
    };

    // Act
    drawBandLabels(context, BOX, bandsOf(['brown', 'white']), {
      rectify: RECTIFY,
      usedRuns: [{ runIndex: 0, color: 'brown', role: 'digit', roleText: '1' }],
      droppedRuns: [1],
    });

    // Assert: 破線を一度は引いている
    expect(dashes.some((dash) => dash.length > 0)).toBe(true);
  });
});
