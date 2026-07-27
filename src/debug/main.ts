import { analyzeRoi, type AnalysisResult } from '../core/pipeline.js';
import { formatOhms, formatReading, MIN_REPORTABLE_CONFIDENCE } from '../core/format.js';
import { clamp } from '../core/math.js';
import type { Band, BandColor, LabColor } from '../types.js';
import { createSampleCanvas } from './sample.js';
import { drawProfile } from './profileView.js';
import { context2d } from './canvas.js';

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
};

/** 選択肢に出すバンド色。 */
const BAND_COLORS: readonly BandColor[] = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green',
  'blue', 'violet', 'grey', 'white', 'gold', 'silver',
];

/** 手動修正の結果。推測を上書きして学習に回す。 */
let correctedColors: BandColor[] = [];

let source: HTMLCanvasElement | null = null;
let selection: Rect | null = null;
let dragStart: { x: number; y: number } | null = null;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`要素が見つかりません: ${selector}`);
  return element;
}

function setSource(canvas: HTMLCanvasElement): void {
  source = canvas;
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
  if (selection === null) return;

  context.strokeStyle = '#00b0ff';
  context.lineWidth = 2;
  context.strokeRect(selection.x, selection.y, selection.width, selection.height);
}

function analyzeSelection(): void {
  if (source === null || selection === null) return;
  if (selection.width < 1 || selection.height < 1) return;

  redrawSource();

  const roi = context2d(source, { willReadFrequently: true }).getImageData(
    Math.round(selection.x),
    Math.round(selection.y),
    Math.round(selection.width),
    Math.round(selection.height),
  );

  elements.roiCanvas.width = roi.width;
  elements.roiCanvas.height = roi.height;
  context2d(elements.roiCanvas).putImageData(roi, 0, 0);

  const result = analyzeRoi(
    { width: roi.width, height: roi.height, data: roi.data },
    { adaptWhiteBalance: elements.adaptToggle.checked },
  );

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

/** labels.json に貼り付けられる形で正解ラベルを出す。 */
function renderLabelJson(): void {
  if (correctedColors.length === 0) {
    elements.labelJson.textContent = '（バンドを検出すると表示されます）';
    return;
  }
  const name = elements.labelName.value.trim() || '<ファイル名>';
  elements.labelJson.textContent = `  ${JSON.stringify(name)}: ${JSON.stringify(correctedColors)}`;
}

function renderReading(result: AnalysisResult): void {
  elements.reading.textContent = formatReading(result.reading);

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
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  context2d(canvas).drawImage(bitmap, 0, 0);
  bitmap.close();
  elements.labelName.value = file.name;
  setSource(canvas);
}

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

elements.copyLabel.addEventListener('click', () => {
  const text = elements.labelJson.textContent ?? '';
  navigator.clipboard.writeText(text).then(
    () => {
      elements.copyStatus.textContent = 'コピーしました';
    },
    (error: unknown) => {
      console.error(error);
      elements.copyStatus.textContent = 'コピーできませんでした（手動で選択してください）';
    },
  );
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
