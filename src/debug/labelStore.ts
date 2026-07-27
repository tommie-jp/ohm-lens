import type { BandColor } from '../types.js';

/**
 * 手動修正したラベルをためておく。
 *
 * 較正には複数枚のラベルが要るので、1 枚ずつコピーするのではなく
 * まとめて `sample/labels.json` に貼れる形で出せるようにする。
 * リロードで消えると作業が飛ぶため localStorage に保存する。
 */

const STORAGE_KEY = 'ohmlens.labels';

export type LabelMap = Record<string, BandColor[]>;

function isLabelMap(value: unknown): value is LabelMap {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every(
    (colors) => Array.isArray(colors) && colors.every((color) => typeof color === 'string'),
  );
}

export function loadLabels(): LabelMap {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    return isLabelMap(parsed) ? parsed : {};
  } catch (error) {
    console.error('保存済みラベルを読めませんでした', error);
    return {};
  }
}

export function saveLabels(labels: LabelMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(labels));
}

/** labels.json にそのまま貼れる整形済み JSON。 */
export function formatLabels(labels: LabelMap): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return '{}';

  const body = names.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(labels[name])}`);
  return `{\n${body.join(',\n')}\n}`;
}
