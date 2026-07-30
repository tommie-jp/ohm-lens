import { zoomLevelsFor, type CameraCapabilities } from './cameraControls.js';

/**
 * カメラ操作ボタン行（接写・ズーム・ライト）の DOM 構築。
 *
 * capability に応じてボタンを出し分ける: 対応しない操作のボタンは
 * **作らない**（無効化ではなく非表示。押せない操作を見せない）。
 * 全部非対応なら行ごと隠す。デスクトップの webcam は通常ここに落ちる。
 *
 * 状態遷移（レンズ切替の成否など）は呼び出し側が判断するので、この
 * モジュールはボタンの生成と見た目の更新だけを担う。
 */

export interface ControlHandlers {
  /** トーチの点灯/消灯。実際に適用できたかを返す。 */
  readonly onTorch: (on: boolean) => Promise<boolean>;
  readonly onZoom: (level: number) => Promise<void>;
  readonly onMacro: (on: boolean) => Promise<void>;
}

/** 生成済みボタン行の見た目を外から更新するためのハンドル。 */
export interface ControlsHandle {
  setTorch(on: boolean): void;
  setZoom(level: number | null): void;
  setMacro(on: boolean): void;
  /** ボタンを全部消して行を隠す（カメラ停止時）。 */
  clear(): void;
}

function controlButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'camera-control';
  button.textContent = label;
  button.setAttribute('aria-pressed', 'false');
  return button;
}

function setPressed(button: HTMLButtonElement, on: boolean): void {
  button.setAttribute('aria-pressed', String(on));
  button.classList.toggle('active', on);
}

export function renderCameraControls(
  container: HTMLElement,
  capabilities: CameraCapabilities,
  hasUltraWide: boolean,
  handlers: ControlHandlers,
): ControlsHandle {
  container.replaceChildren();

  let macroButton: HTMLButtonElement | null = null;
  let macroOn = false;
  if (hasUltraWide) {
    macroButton = controlButton('接写');
    macroButton.addEventListener('click', () => {
      // 成否はレンズを開き直した呼び出し側にしか分からないので、
      // 見た目は setMacro で確定させる（ここでは切り替えない）
      void handlers.onMacro(!macroOn);
    });
    container.append(macroButton);
  }

  const zoomLevels = capabilities.zoom === null ? [] : zoomLevelsFor(capabilities.zoom.max);
  const zoomButtons = new Map<number, HTMLButtonElement>();
  for (const level of zoomLevels) {
    const button = controlButton(`${level}x`);
    button.addEventListener('click', () => {
      void handlers.onZoom(level).then(() => {
        setZoom(level);
      });
    });
    zoomButtons.set(level, button);
    container.append(button);
  }

  let torchButton: HTMLButtonElement | null = null;
  let torchOn = false;
  if (capabilities.torch) {
    torchButton = controlButton('ライト');
    torchButton.addEventListener('click', () => {
      void handlers.onTorch(!torchOn).then((applied) => {
        setTorch(applied && !torchOn);
      });
    });
    container.append(torchButton);
  }

  container.hidden = container.childElementCount === 0;

  function setTorch(on: boolean): void {
    torchOn = on;
    if (torchButton !== null) setPressed(torchButton, on);
  }

  function setZoom(level: number | null): void {
    for (const [step, button] of zoomButtons) setPressed(button, step === level);
  }

  function setMacro(on: boolean): void {
    macroOn = on;
    if (macroButton !== null) setPressed(macroButton, on);
  }

  return {
    setTorch,
    setZoom,
    setMacro,
    clear(): void {
      container.replaceChildren();
      container.hidden = true;
    },
  };
}
