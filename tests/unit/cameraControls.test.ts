import { describe, expect, it } from 'vitest';
import {
  applyTorch,
  applyZoom,
  isFrontFacing,
  readCameraCapabilities,
  zoomLevelsFor,
  NEAR_FOCUS_ZOOM,
  ZOOM_STEPS,
} from '../../src/debug/cameraControls.js';

/** applyConstraints の呼び出しを記録する擬似トラック。 */
interface FakeTrackOptions {
  readonly capabilities?: object;
  readonly settings?: object;
  readonly label?: string;
  readonly failApply?: boolean;
}

function fakeTrack(options: FakeTrackOptions = {}): {
  track: MediaStreamTrack;
  applied: MediaTrackConstraints[];
} {
  const applied: MediaTrackConstraints[] = [];
  const track = {
    label: options.label ?? '',
    ...(options.capabilities === undefined
      ? {}
      : { getCapabilities: () => options.capabilities }),
    ...(options.settings === undefined ? {} : { getSettings: () => options.settings }),
    applyConstraints: (constraints: MediaTrackConstraints): Promise<void> => {
      if (options.failApply === true) return Promise.reject(new Error('not satisfiable'));
      applied.push(constraints);
      return Promise.resolve();
    },
  } as unknown as MediaStreamTrack;
  return { track, applied };
}

describe('zoomLevelsFor', () => {
  it('最大ズームに収まる段階だけ返す', () => {
    expect(zoomLevelsFor(4)).toEqual([1, 2, 4]);
    expect(zoomLevelsFor(8)).toEqual([1, 2, 4]);
    expect(zoomLevelsFor(2.5)).toEqual([1, 2]);
  });

  it('1 段階しか収まらなければ空配列（ボタンを出さない）', () => {
    expect(zoomLevelsFor(1)).toEqual([]);
    expect(zoomLevelsFor(1.9)).toEqual([]);
  });

  it('接写の初期ズームは段階のひとつ', () => {
    expect(ZOOM_STEPS).toContain(NEAR_FOCUS_ZOOM);
  });
});

describe('readCameraCapabilities', () => {
  it('torch と zoom の両対応を読み取る', () => {
    // Arrange
    const { track } = fakeTrack({ capabilities: { torch: true, zoom: { min: 1, max: 8 } } });

    // Act / Assert
    expect(readCameraCapabilities(track)).toEqual({ torch: true, zoom: { min: 1, max: 8 } });
  });

  it.each([
    ['getCapabilities 未実装（Firefox など）', {}],
    ['torch のみ', { capabilities: { torch: false } }],
    ['zoom の形が不正', { capabilities: { zoom: {} } }],
  ])('%s では非対応として扱う', (_name, options) => {
    const { track } = fakeTrack(options);
    const capabilities = readCameraCapabilities(track);
    expect(capabilities.torch).toBe(false);
    expect(capabilities.zoom).toBeNull();
  });
});

describe('applyZoom', () => {
  it('対応範囲へクランプして適用し、適用値を返す', async () => {
    // Arrange
    const { track, applied } = fakeTrack({ capabilities: { zoom: { min: 1, max: 3 } } });

    // Act
    const value = await applyZoom(track, 4);

    // Assert
    expect(value).toBe(3);
    expect(applied).toEqual([{ advanced: [{ zoom: 3 }] }]);
  });

  it('下限側にもクランプする', async () => {
    const { track } = fakeTrack({ capabilities: { zoom: { min: 2, max: 8 } } });
    expect(await applyZoom(track, 1)).toBe(2);
  });

  it('zoom 非対応なら何もせず null', async () => {
    const { track, applied } = fakeTrack({ capabilities: { torch: true } });
    expect(await applyZoom(track, 2)).toBeNull();
    expect(applied).toEqual([]);
  });

  it('applyConstraints が拒まれても例外にせず null', async () => {
    const { track } = fakeTrack({ capabilities: { zoom: { min: 1, max: 4 } }, failApply: true });
    expect(await applyZoom(track, 2)).toBeNull();
  });
});

describe('applyTorch', () => {
  it('対応していれば点灯を適用して true', async () => {
    // Arrange
    const { track, applied } = fakeTrack({ capabilities: { torch: true } });

    // Act / Assert
    expect(await applyTorch(track, true)).toBe(true);
    expect(applied).toEqual([{ advanced: [{ torch: true }] }]);
  });

  it('非対応なら何もせず false', async () => {
    const { track, applied } = fakeTrack({ capabilities: {} });
    expect(await applyTorch(track, true)).toBe(false);
    expect(applied).toEqual([]);
  });

  it('applyConstraints が拒まれたら false（点いていない扱い）', async () => {
    const { track } = fakeTrack({ capabilities: { torch: true }, failApply: true });
    expect(await applyTorch(track, true)).toBe(false);
  });
});

describe('isFrontFacing', () => {
  it('getSettings の facingMode を最優先する', () => {
    const { track } = fakeTrack({ settings: { facingMode: 'user' }, label: 'Back Camera' });
    expect(isFrontFacing(track)).toBe(true);
  });

  it('facingMode が environment なら背面', () => {
    const { track } = fakeTrack({ settings: { facingMode: 'environment' }, label: 'Front' });
    expect(isFrontFacing(track)).toBe(false);
  });

  it.each(['Front Camera', '前面カメラ'])('facingMode が無ければラベル "%s" で前面と判定', (label) => {
    const { track } = fakeTrack({ settings: {}, label });
    expect(isFrontFacing(track)).toBe(true);
  });

  it('どちらも取れなければ前面と断定しない', () => {
    const { track } = fakeTrack({ settings: {}, label: 'Integrated Webcam' });
    expect(isFrontFacing(track)).toBe(false);
  });
});
