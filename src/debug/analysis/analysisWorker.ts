/// <reference lib="webworker" />
import { runAnalysis } from './runAnalysis.js';
import type { AnalysisRequest } from './protocol.js';

/**
 * 解析 Worker の入口。
 *
 * 処理そのものは `runAnalysis`（DOM 非依存）に置いて、ここは受け渡しだけに
 * する。こうしておくと解析の中身は node のテストからそのまま呼べる。
 */

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<AnalysisRequest>): void => {
  const response = runAnalysis(event.data);
  // ROI の画素はゼロコピーで返す（クローンすると 1 枚ぶん丸ごと複製になる）
  self.postMessage(response, response.roi === null ? [] : [response.roi.pixels]);
};
