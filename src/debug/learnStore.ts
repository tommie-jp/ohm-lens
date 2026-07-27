import type { BandColor, LabColor } from '../types.js';
import type { Observations } from '../core/learning.js';

/**
 * 値からの学習で蓄積した観測（色ごとの実写 Lab）の保存。
 * リロードで消えると学習が飛ぶため localStorage に永続化する。
 */

const STORAGE_KEY = 'ohmlens.observations';

function isLab(value: unknown): value is LabColor {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as LabColor).l === 'number' &&
    typeof (value as LabColor).a === 'number' &&
    typeof (value as LabColor).b === 'number'
  );
}

export function loadObservations(): Observations {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Partial<Record<BandColor, LabColor[]>> = {};
    for (const [color, samples] of Object.entries(parsed)) {
      if (Array.isArray(samples) && samples.every(isLab)) {
        result[color as BandColor] = samples;
      }
    }
    return result;
  } catch (error) {
    console.error('保存済みの学習データを読めませんでした', error);
    return {};
  }
}

export function saveObservations(observations: Observations): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(observations));
}

export function clearObservations(): void {
  localStorage.removeItem(STORAGE_KEY);
}
