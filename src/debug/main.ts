import { analyzeRoi, type AnalysisResult } from '../core/pipeline.js';
import { locateResistor, type OrientedBox } from '../core/locate.js';
import { rectify } from '../core/rectify.js';
import type { RoiImage } from '../core/bands/profile.js';
import { withOverrides, DEFAULT_PALETTE, type Palette } from '../core/color/palette.js';
import { formatLabels, loadLabels, saveLabels, type LabelMap } from './labelStore.js';
import {
  addObservations,
  matchRunsToValue,
  paletteOverrides,
  type Observations,
} from '../core/learning.js';
import { parseOhms } from '../core/value/parseOhms.js';
import { clearObservations, loadObservations, saveObservations } from './learnStore.js';
import { releaseWakeLock, requestWakeLock } from './wakeLock.js';
import { formatOhms, formatReading, MIN_REPORTABLE_CONFIDENCE } from '../core/format.js';
import { clamp } from '../core/math.js';
import type { Band, BandColor, LabColor } from '../types.js';
import { createSampleCanvas } from './sample.js';
import { drawProfile } from './profileView.js';
import { context2d } from './canvas.js';
import { decodeImageFile } from './decodeImage.js';
import { SUPPORTED_ACCEPT } from '../core/imageFormat.js';
import { listCameras, pickPreferredCamera, startCamera, type CameraSession } from './camera.js';
import { describeCameraError } from './cameraSupport.js';

/**
 * Phase 0 の目視確認ツール。
 * 画像を読み込み、ドラッグで ROI を指定して解析結果を表示する。
 * ここだけ DOM に依存する（core/ は DOM 非依存を保つ）。
 */

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const elements = {
  fileInput: requireElement<HTMLInputElement>('#file-input'),
  sampleButton: requireElement<HTMLButtonElement>('#sample-button'),
  adaptToggle: requireElement<HTMLInputElement>('#adapt-toggle'),
  roiHint: requireElement<HTMLParagraphElement>('#roi-hint'),
  sourceCanvas: requireElement<HTMLCanvasElement>('#source-canvas'),
  roiCanvas: requireElement<HTMLCanvasElement>('#roi-canvas'),
  profileCanvas: requireElement<HTMLCanvasElement>('#profile-canvas'),
  bandsTable: requireElement<HTMLTableElement>('#bands-table'),
  bandsEmpty: requireElement<HTMLParagraphElement>('#bands-empty'),
  reading: requireElement<HTMLOutputElement>('#reading'),
  readingDetail: requireElement<HTMLDListElement>('#reading-detail'),
  labelName: requireElement<HTMLInputElement>('#label-name'),
  labelJson: requireElement<HTMLPreElement>('#label-json'),
  copyLabel: requireElement<HTMLButtonElement>('#copy-label'),
  copyStatus: requireElement<HTMLSpanElement>('#copy-status'),
  autoToggle: requireElement<HTMLInputElement>('#auto-toggle'),
  saveLabel: requireElement<HTMLButtonElement>('#save-label'),
  clearLabels: requireElement<HTMLButtonElement>('#clear-labels'),
  labelCount: requireElement<HTMLSpanElement>('#label-count'),
  paletteStatus: requireElement<HTMLSpanElement>('#palette-status'),
  formatStatus: requireElement<HTMLSpanElement>('#format-status'),
  cameraButton: requireElement<HTMLButtonElement>('#camera-button'),
  captureButton: requireElement<HTMLButtonElement>('#capture-button'),
  cameraSelect: requireElement<HTMLSelectElement>('#camera-select'),
  cameraStatus: requireElement<HTMLSpanElement>('#camera-status'),
  learnValue: requireElement<HTMLInputElement>('#learn-value'),
  learnTolerance: requireElement<HTMLSelectElement>('#learn-tolerance'),
  learnButton: requireElement<HTMLButtonElement>('#learn-button'),
  learnStatus: requireElement<HTMLSpanElement>('#learn-status'),
  learnCounts: requireElement<HTMLParagraphElement>('#learn-counts'),
  learnExport: requireElement<HTMLButtonElement>('#learn-export'),
  learnClear: requireElement<HTMLButtonElement>('#learn-clear'),
  perfStatus: requireElement<HTMLSpanElement>('#perf-status'),
  stickyBar: requireElement<HTMLDivElement>('#sticky-bar'),
  stickyReading: requireElement<HTMLOutputElement>('#sticky-reading'),
  stickyLearn: requireElement<HTMLButtonElement>('#sticky-learn'),
};

/** 選択肢に出すバンド色。 */
const BAND_COLORS: readonly BandColor[] = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green',
  'blue', 'violet', 'grey', 'white', 'gold', 'silver',
];

/** 手動修正の結果。推測を上書きして学習に回す。 */
let correctedColors: BandColor[] = [];

let source: HTMLCanvasElement | null = null;
let detectedBox: OrientedBox | null = null;
let palette: Palette | null = null;
let savedLabels: LabelMap = loadLabels();
let camera: CameraSession | null = null;
let observations: Observations = loadObservations();
let lastResult: AnalysisResult | null = null;

/** 学習に使うには対応付けコストがこの水準以下であること。 */
const MAX_LEARN_COST = 25;

/**
 * 現在有効なパレット。サーバの学習結果に、この場で学習した上書きを重ねる。
 */
function activePalette(): Palette | null {
  const learned = paletteOverrides(observations);
  const base = palette ?? DEFAULT_PALETTE;
  if (Object.keys(learned).length === 0) return palette;
  return withOverrides(base, learned);
}

/** 学習した色ごとの件数を表示する。 */
function renderLearnCounts(): void {
  const entries = Object.entries(observations)
    .filter(([, samples]) => (samples?.length ?? 0) > 0)
    .map(([color, samples]) => `${color} ${samples?.length ?? 0}`);
  elements.learnCounts.textContent =
    entries.length === 0 ? '学習データ: なし' : `学習データ: ${entries.join(' / ')}`;
}
let selection: Rect | null = null;
let dragStart: { x: number; y: number } | null = null;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`要素が見つかりません: ${selector}`);
  return element;
}

function setSource(canvas: HTMLCanvasElement): void {
  source = canvas;
  updateStickyBar();
  elements.sourceCanvas.width = canvas.width;
  elements.sourceCanvas.height = canvas.height;
  context2d(elements.sourceCanvas).drawImage(canvas, 0, 0);

  // 既定 ROI は中央の横帯。まず何か表示してから微調整できるようにする。
  selection = {
    x: 0,
    y: Math.round(canvas.height * 0.3),
    width: canvas.width,
    height: Math.max(1, Math.round(canvas.height * 0.4)),
  };
  elements.roiHint.textContent =
    'ドラッグで ROI を指定できます（初期値は中央の横帯）。抵抗器の本体が収まるように囲んでください。';
  analyzeSelection();
}

/** canvas 上のポインタ座標を画像の内在解像度に変換する。 */
function toCanvasPoint(event: PointerEvent): { x: number; y: number } {
  const canvas = elements.sourceCanvas;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: clamp((event.clientX - rect.left) * scaleX, 0, canvas.width),
    y: clamp((event.clientY - rect.top) * scaleY, 0, canvas.height),
  };
}

function redrawSource(): void {
  if (source === null) return;
  const context = context2d(elements.sourceCanvas);
  context.drawImage(source, 0, 0);

  if (elements.autoToggle.checked) {
    if (detectedBox !== null) drawDetectedBox(context, detectedBox);
    return;
  }
  if (selection === null) return;

  context.strokeStyle = '#00b0ff';
  context.lineWidth = 2;
  context.strokeRect(selection.x, selection.y, selection.width, selection.height);
}

/** 自動検出した回転ボックスを元画像に重ねて描く。 */
function drawDetectedBox(context: CanvasRenderingContext2D, box: OrientedBox): void {
  const rad = (box.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfLength = box.length / 2;
  const halfThickness = box.thickness / 2;

  const corners: readonly (readonly [number, number])[] = [
    [-halfLength, -halfThickness],
    [halfLength, -halfThickness],
    [halfLength, halfThickness],
    [-halfLength, halfThickness],
  ];

  context.strokeStyle = '#ff4081';
  context.lineWidth = Math.max(2, Math.round(box.thickness / 12));
  context.beginPath();
  corners.forEach(([along, across], index) => {
    const x = box.centerX + along * cos - across * sin;
    const y = box.centerY + along * sin + across * cos;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.closePath();
  context.stroke();
}

/** テストのフィクスチャハーネスと揃えた ROI の切り出し条件。 */
const ROI_PADDING = 0.06;
const ROI_HEIGHT = 40;

/**
 * 解析対象の ROI を用意する。
 *
 * 自動検出が有効なら、画像全体から抵抗器を探して水平化する
 * （`tests/fixtures` と同じ経路）。無効なら選択範囲をそのまま使う。
 */
function buildRoi(): RoiImage | null {
  if (source === null) return null;
  const context = context2d(source, { willReadFrequently: true });

  if (elements.autoToggle.checked) {
    const full = context.getImageData(0, 0, source.width, source.height);
    const image: RoiImage = { width: full.width, height: full.height, data: full.data };
    const box = locateResistor(image);
    if (box === null) {
      elements.roiHint.textContent = '抵抗器を自動検出できませんでした。手動指定に切り替えてください。';
      return null;
    }
    detectedBox = box;
    elements.roiHint.textContent =
      `自動検出: 角度 ${box.angleDeg.toFixed(1)}度 / 長さ ${Math.round(box.length)}px。` +
      ' ドラッグしたい場合は「自動検出」を外してください。';
    return rectify(image, box, { padding: ROI_PADDING, targetHeight: ROI_HEIGHT });
  }

  detectedBox = null;
  if (selection === null || selection.width < 1 || selection.height < 1) return null;
  const roi = context.getImageData(
    Math.round(selection.x),
    Math.round(selection.y),
    Math.round(selection.width),
    Math.round(selection.height),
  );
  return { width: roi.width, height: roi.height, data: roi.data };
}

function analyzeSelection(): void {
  if (source === null) return;

  redrawSource();

  const roi = buildRoi();
  if (roi === null) return;

  elements.roiCanvas.width = roi.width;
  elements.roiCanvas.height = roi.height;
  const roiContext = context2d(elements.roiCanvas);
  const imageData = roiContext.createImageData(roi.width, roi.height);
  imageData.data.set(roi.data);
  roiContext.putImageData(imageData, 0, 0);

  const effective = activePalette();
  const result = analyzeRoi(roi, {
    adaptWhiteBalance: elements.adaptToggle.checked,
    ...(effective === null ? {} : { segment: { palette: effective } }),
  });
  lastResult = result;

  drawProfile(elements.profileCanvas, result.profile, result.bands);
  renderBands(result.bands);
  renderReading(result);
}

function renderBands(bands: readonly Band[]): void {
  const body = elements.bandsTable.tBodies[0];
  if (body === undefined) return;

  correctedColors = bands.map((band) => band.color);

  body.replaceChildren();
  elements.bandsEmpty.hidden = bands.length > 0;
  elements.bandsTable.hidden = bands.length === 0;

  bands.forEach((band, index) => {
    const row = body.insertRow();
    row.insertCell().textContent = String(index + 1);

    const guessCell = row.insertCell();
    guessCell.append(swatchFor(band.color), band.color);

    const editCell = row.insertCell();
    editCell.append(colorSelect(index, band.color));

    row.insertCell().textContent = `${band.start}–${band.end}`;
    row.insertCell().textContent = String(band.end - band.start);
    row.insertCell().textContent = band.confidence.toFixed(2);
  });

  renderLabelJson();
}

function swatchFor(color: BandColor): HTMLSpanElement {
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = color === 'grey' ? 'gray' : color;
  return swatch;
}

/** バンド 1 本ぶんの色を選び直すプルダウン。 */
function colorSelect(index: number, selected: BandColor): HTMLSelectElement {
  const select = document.createElement('select');
  for (const color of BAND_COLORS) {
    const option = document.createElement('option');
    option.value = color;
    option.textContent = color;
    option.selected = color === selected;
    select.append(option);
  }
  select.addEventListener('change', () => {
    correctedColors[index] = select.value as BandColor;
    renderLabelJson();
  });
  return select;
}

/** labels.json に貼り付けられる形で、保存済みラベルをまとめて出す。 */
function renderLabelJson(): void {
  const count = Object.keys(savedLabels).length;
  elements.labelCount.textContent = count === 0 ? '保存済み 0 件' : `保存済み ${count} 件`;

  const current =
    correctedColors.length === 0
      ? ''
      : `現在の修正: ${JSON.stringify(elements.labelName.value.trim() || '<ファイル名>')}: ` +
        `${JSON.stringify(correctedColors)}\n\n`;

  elements.labelJson.textContent =
    count === 0 && correctedColors.length === 0
      ? '（バンドを検出すると表示されます）'
      : `${current}${formatLabels(savedLabels)}`;
}

/** 現在の修正内容を保存済みラベルに追加する。 */
function saveCurrentLabel(): void {
  const name = elements.labelName.value.trim();
  if (name === '' || correctedColors.length === 0) {
    elements.copyStatus.textContent = 'ファイル名とバンドが必要です';
    return;
  }
  savedLabels = { ...savedLabels, [name]: [...correctedColors] };
  saveLabels(savedLabels);
  elements.copyStatus.textContent = `${name} を保存しました`;
  renderLabelJson();
}

/** 学習済みパレットを読み込む。dev サーバーが sample/palette.json を配信する。 */
async function loadPaletteFromServer(): Promise<void> {
  try {
    const response = await fetch('/palette.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as { colors?: Record<string, LabColor> };
    const colors = parsed.colors ?? {};
    const count = Object.keys(colors).length;
    if (count === 0) {
      elements.paletteStatus.textContent = '学習パレット: なし（既定の基準色を使用）';
      return;
    }
    palette = withOverrides(DEFAULT_PALETTE, colors as Parameters<typeof withOverrides>[1]);
    elements.paletteStatus.textContent = `学習パレット: ${count} 色を適用中`;
  } catch {
    elements.paletteStatus.textContent = '学習パレット: なし（既定の基準色を使用）';
  }
}

function renderReading(result: AnalysisResult): void {
  const text = formatReading(result.reading);
  elements.reading.textContent = text;
  elements.stickyReading.textContent = text;

  const rows: [string, string][] = [];
  if (result.reading !== null) {
    const reading = result.reading;
    // 閾値未満でも、デバッグ用途では「何と読めたか」を確認できるようにする
    const suppressed =
      reading.confidence < MIN_REPORTABLE_CONFIDENCE
        ? `（閾値未満: ${formatOhms(reading.ohms)}）`
        : '';
    rows.push(
      ['確信度', `${reading.confidence.toFixed(2)}${suppressed}`],
      ['読み取り方向', reading.direction],
      ['E系列', reading.series],
      ['スナップ前', `${reading.rawOhms} Ω`],
    );
    if (reading.tempCoefficient !== null) {
      rows.push(['温度係数', `${reading.tempCoefficient} ppm/K`]);
    }
  }
  if (result.anchor !== null) rows.push(['本体色アンカー', formatLab(result.anchor)]);

  elements.readingDetail.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    elements.readingDetail.append(dt, dd);
  }
}

function formatLab(lab: LabColor): string {
  return `L* ${lab.l.toFixed(1)} / a* ${lab.a.toFixed(1)} / b* ${lab.b.toFixed(1)}`;
}

async function loadFile(file: File): Promise<void> {
  elements.roiHint.textContent = `${file.name} を読み込み中…`;
  const decoded = await decodeImageFile(file);
  elements.labelName.value = file.name;
  elements.formatStatus.textContent =
    `形式: ${decoded.format.toUpperCase()}` + (decoded.converted ? '（変換して表示）' : '');
  setSource(decoded.canvas);
}

/** カメラ稼働中は「静止画として扱う」操作を隠す。 */
function setCameraRunning(running: boolean): void {
  elements.cameraButton.textContent = running ? 'カメラを停止' : 'カメラを開始';
  elements.captureButton.hidden = !running;
  elements.cameraSelect.hidden = !running;
}

/** 画像かカメラが載っていれば、下部の固定バーを出す。 */
function updateStickyBar(): void {
  elements.stickyBar.hidden = source === null;
}

function stopCamera(): void {
  camera?.stop();
  camera = null;
  setCameraRunning(false);
  elements.cameraStatus.textContent = '';
  elements.perfStatus.textContent = '';
  void releaseWakeLock();
}

/** カメラ一覧をプルダウンに反映する（ラベルは権限取得後でないと空になる）。 */
async function refreshCameraList(): Promise<void> {
  const cameras = await listCameras();
  elements.cameraSelect.replaceChildren();
  cameras.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label === '' ? `カメラ ${index + 1}` : device.label;
    elements.cameraSelect.append(option);
  });
  const preferred = pickPreferredCamera(cameras);
  if (preferred !== null) elements.cameraSelect.value = preferred.deviceId;
}

async function beginCamera(deviceId?: string): Promise<void> {
  stopCamera();
  elements.cameraStatus.textContent = 'カメラを起動中…';

  try {
    camera = await startCamera({
      ...(deviceId === undefined ? {} : { deviceId }),
      onFrame: (frame) => {
        source = frame;
        updateStickyBar();
        analyzeSelection();
      },
      onStats: (stats, analysisPx) => {
        elements.perfStatus.textContent =
          `${stats.fps.toFixed(1)}fps / ${stats.meanMs.toFixed(0)}ms / 解析 ${analysisPx}px`;
      },
      onError: (error) => {
        console.error(error);
      },
    });
  } catch (error) {
    elements.cameraStatus.textContent = describeCameraError(error);
    setCameraRunning(false);
    return;
  }

  setCameraRunning(true);
  void requestWakeLock();
  const { status } = camera;
  elements.cameraStatus.textContent =
    `${status.label} ${status.width}x${status.height}` +
    (status.manualColorLocked ? ' / WB・露出を固定' : ' / WB・露出は自動（この環境では固定不可）');
  await refreshCameraList();
}

/**
 * クリップボードへコピーする。失敗したら手動選択できるよう表示に落とす。
 * iOS Safari はユーザー操作の文脈から外れると writeText を拒否するため、
 * 「コピーできない」で終わらせず必ず取り出せる経路を残す。
 */
function copyOrShow(text: string, target: HTMLElement, status: HTMLElement): void {
  const fallback = (): void => {
    target.textContent = text;
    status.textContent = 'コピーできなかったので下に表示しました（長押しで選択）';
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  if (typeof navigator.clipboard?.writeText !== 'function') {
    fallback();
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      status.textContent = 'コピーしました';
    },
    fallback,
  );
}

function learnFromCurrent(): void {
  if (lastResult === null || lastResult.runs.length === 0) {
    elements.learnStatus.textContent = '先に抵抗を検出してください';
    return;
  }

  const ohms = parseOhms(elements.learnValue.value);
  if (ohms === null) {
    elements.learnStatus.textContent = '値を解釈できません（例: 4.7k, 220, 1M）';
    return;
  }
  const toleranceRaw = elements.learnTolerance.value;
  const tolerance = toleranceRaw === 'none' ? null : Number.parseFloat(toleranceRaw);

  const match = matchRunsToValue(
    lastResult.runs.map((run) => ({ lab: run.lab, start: run.start, end: run.end })),
    ohms,
    tolerance,
    activePalette() ?? DEFAULT_PALETTE,
  );
  if (match === null) {
    elements.learnStatus.textContent =
      'この値のバンド列と対応付けできませんでした（バンド数を確認してください）';
    return;
  }
  if (match.cost > MAX_LEARN_COST) {
    elements.learnStatus.textContent =
      `対応付けの確度が低いため学習しません（コスト ${match.cost.toFixed(1)}）。映りを変えて再試行してください`;
    return;
  }

  observations = addObservations(observations, match.assignments);
  saveObservations(observations);
  const note = match.toleranceObserved ? '' : '（許容差バンドは検出できず、数字・倍率のみ）';
  elements.learnStatus.textContent =
    `学習しました: ${match.sequence.join('-')}${note}`;
  renderLearnCounts();
  analyzeSelection(); // 学習直後のパレットで読み直す
}

elements.learnButton.addEventListener('click', learnFromCurrent);

elements.stickyLearn.addEventListener('click', () => {
  // 入力欄が畳まれた位置にあってもすぐ打てるように、まず focus を移す
  if (elements.learnValue.value.trim() === '') {
    elements.learnValue.scrollIntoView({ behavior: 'smooth', block: 'center' });
    elements.learnValue.focus();
    return;
  }
  learnFromCurrent();
});

elements.learnValue.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') learnFromCurrent();
});

elements.learnExport.addEventListener('click', () => {
  const text = JSON.stringify(
    { generatedFrom: 'browser learning', colors: paletteOverrides(observations) },
    null,
    2,
  );
  copyOrShow(text, elements.labelJson, elements.learnStatus);
});

elements.learnClear.addEventListener('click', () => {
  observations = {};
  clearObservations();
  renderLearnCounts();
  elements.learnStatus.textContent = '学習データを消去しました';
  analyzeSelection();
});

elements.cameraButton.addEventListener('click', () => {
  if (camera !== null) {
    stopCamera();
    return;
  }
  void beginCamera();
});

elements.captureButton.addEventListener('click', () => {
  if (camera === null || source === null) return;
  // 現在のフレームを複製してから止める。止めた後も解析・ラベル付けを続けられる。
  const frozen = document.createElement('canvas');
  frozen.width = source.width;
  frozen.height = source.height;
  context2d(frozen).drawImage(source, 0, 0);
  stopCamera();
  elements.labelName.value = '';
  elements.formatStatus.textContent = '形式: カメラ静止画';
  setSource(frozen);
});

elements.cameraSelect.addEventListener('change', () => {
  void beginCamera(elements.cameraSelect.value);
});

elements.fileInput.accept = SUPPORTED_ACCEPT;

elements.fileInput.addEventListener('change', () => {
  const file = elements.fileInput.files?.[0];
  if (file === undefined) return;
  loadFile(file).catch((error: unknown) => {
    console.error(error);
    elements.roiHint.textContent = `画像を読み込めませんでした: ${String(error)}`;
  });
});

elements.sampleButton.addEventListener('click', () => {
  setSource(createSampleCanvas());
});

elements.adaptToggle.addEventListener('change', analyzeSelection);

elements.labelName.addEventListener('input', renderLabelJson);

elements.autoToggle.addEventListener('change', analyzeSelection);

elements.saveLabel.addEventListener('click', saveCurrentLabel);

elements.clearLabels.addEventListener('click', () => {
  savedLabels = {};
  saveLabels(savedLabels);
  elements.copyStatus.textContent = '保存済みラベルを消去しました';
  renderLabelJson();
});

elements.copyLabel.addEventListener('click', () => {
  copyOrShow(formatLabels(savedLabels), elements.labelJson, elements.copyStatus);
});

elements.sourceCanvas.addEventListener('pointerdown', (event) => {
  if (source === null) return;
  elements.sourceCanvas.setPointerCapture(event.pointerId);
  dragStart = toCanvasPoint(event);
});

elements.sourceCanvas.addEventListener('pointermove', (event) => {
  if (dragStart === null) return;
  const current = toCanvasPoint(event);
  selection = {
    x: Math.min(dragStart.x, current.x),
    y: Math.min(dragStart.y, current.y),
    width: Math.abs(current.x - dragStart.x),
    height: Math.abs(current.y - dragStart.y),
  };
  redrawSource();
});

elements.sourceCanvas.addEventListener('pointerup', (event) => {
  if (dragStart === null) return;
  elements.sourceCanvas.releasePointerCapture(event.pointerId);
  dragStart = null;
  analyzeSelection();
});

/**
 * タブが背面に回るとカメラのストリームは止まり、Wake Lock も解除される。
 * 復帰時に取り直す（iOS Safari では特に顕著）。
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (camera === null) return;
  void requestWakeLock();
  if (camera.video.paused) void camera.video.play().catch(() => undefined);
});

void loadPaletteFromServer();
renderLabelJson();
renderLearnCounts();
