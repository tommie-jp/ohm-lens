import { describe, expect, it } from 'vitest';
import {
  buildVideoConstraints,
  displayCameraLabel,
  describeCameraError,
  manualColorConstraints,
  pickPreferredCamera,
  supportsManualColor,
} from '../../src/debug/cameraSupport.js';

describe('buildVideoConstraints', () => {
  it('既定では背面カメラを希望し、高解像度を要求する', () => {
    // Act
    const constraints = buildVideoConstraints();

    // Assert
    expect(constraints.facingMode).toBe('environment');
    expect(constraints.width).toEqual({ ideal: 1920 });
  });

  it('deviceId を指定すると facingMode より優先する', () => {
    // Act
    const constraints = buildVideoConstraints({ deviceId: 'abc123' });

    // Assert
    expect(constraints.deviceId).toEqual({ exact: 'abc123' });
    expect(constraints.facingMode).toBeUndefined();
  });
});

describe('pickPreferredCamera', () => {
  const device = (deviceId: string, label: string): MediaDeviceInfo =>
    ({ deviceId, label, kind: 'videoinput', groupId: '' }) as MediaDeviceInfo;

  it('背面カメラらしいラベルを優先する', () => {
    // Arrange
    const devices = [device('1', 'FaceTime HD Camera'), device('2', 'Back Camera')];

    // Act / Assert
    expect(pickPreferredCamera(devices)?.deviceId).toBe('2');
  });

  it.each(['背面カメラ', 'rear camera', 'Camera 0, facing back'])(
    'ラベル "%s" を背面と判断する',
    (label) => {
      const devices = [device('1', 'Front'), device('2', label)];
      expect(pickPreferredCamera(devices)?.deviceId).toBe('2');
    },
  );

  it('背面らしいものが無ければ最初のカメラを返す', () => {
    const devices = [device('1', 'Integrated Webcam'), device('2', 'Virtual Camera')];

    expect(pickPreferredCamera(devices)?.deviceId).toBe('1');
  });

  it('カメラが無ければ null', () => {
    expect(pickPreferredCamera([])).toBeNull();
  });

  it('映像以外のデバイスは無視する', () => {
    const microphone = { deviceId: 'm', label: 'Mic', kind: 'audioinput', groupId: '' };
    const devices = [microphone as MediaDeviceInfo, device('2', 'Back Camera')];

    expect(pickPreferredCamera(devices)?.deviceId).toBe('2');
  });
});

describe('supportsManualColor', () => {
  it('ホワイトバランスと露出の両方を手動にできるなら true', () => {
    // Arrange: Chromium 系が返す capabilities を模す
    const capabilities = {
      whiteBalanceMode: ['continuous', 'manual'],
      exposureMode: ['continuous', 'manual'],
    };

    // Act / Assert
    expect(supportsManualColor(capabilities)).toBe(true);
  });

  it.each([
    ['ホワイトバランスのみ', { whiteBalanceMode: ['manual'] }],
    ['露出のみ', { exposureMode: ['manual'] }],
    ['どちらも continuous のみ', { whiteBalanceMode: ['continuous'], exposureMode: ['continuous'] }],
    ['capabilities なし', {}],
  ])('%s では false', (_name, capabilities) => {
    expect(supportsManualColor(capabilities)).toBe(false);
  });
});

describe('manualColorConstraints', () => {
  it('ホワイトバランスと露出を manual に固定する制約を返す', () => {
    expect(manualColorConstraints()).toEqual({
      advanced: [{ whiteBalanceMode: 'manual', exposureMode: 'manual' }],
    });
  });
});

describe('describeCameraError', () => {
  it.each([
    ['NotAllowedError', 'カメラの使用が許可されませんでした'],
    ['NotFoundError', 'カメラが見つかりませんでした'],
    ['NotReadableError', 'カメラを開けませんでした'],
    ['OverconstrainedError', '要求した設定に合うカメラがありませんでした'],
  ])('%s を日本語で説明する', (name, expected) => {
    // Arrange
    const error = new Error('boom');
    error.name = name;

    // Act / Assert
    expect(describeCameraError(error)).toContain(expected);
  });

  it('未知のエラーはそのまま伝える', () => {
    expect(describeCameraError(new Error('something odd'))).toContain('something odd');
  });

  it('Error でない値でも文字列を返す', () => {
    expect(typeof describeCameraError('文字列')).toBe('string');
  });
});

describe('displayCameraLabel', () => {
  it('通常のラベルはそのまま使う', () => {
    expect(displayCameraLabel('Back Camera')).toBe('Back Camera');
  });

  it('空のラベルは既定名にする（権限取得前は空になる）', () => {
    expect(displayCameraLabel('   ')).toBe('カメラ');
  });

  it('長すぎるラベルは機械的な ID とみなして既定名にする', () => {
    expect(displayCameraLabel('JG5HtW9fMsOHlneHeny4MZXkuVz0DQorCddrGC1lQg3gF7GbtE8P9IqV')).toBe(
      'カメラ',
    );
  });
});
