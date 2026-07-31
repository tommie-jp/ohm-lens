import type { AnalysisRequest, AnalysisResponse } from './protocol.js';

/**
 * 解析 Worker とのやりとりを Promise にくるむ。
 *
 * 送るのは**同時に 1 本だけ**。順番待ちも**1 枠だけ**持ち、新しい依頼が来たら
 * 古い待機を捨てる（keep-latest）。積み上げないのは、追い越された依頼を
 * 解析しても結果は捨てられるうえ、依頼が握っている画像（静止画は元解像度
 * なので 1 枚数十 MB になりうる）を待ち行列のぶんだけ抱え込むため。
 *
 * ライブ映像のフレーム間引きはここではなく `camera.ts` が持つ。実測
 * （`frameBudget.ts`）を握っているのがあちらなので、捨てる判断も同じ側に置く。
 */

/**
 * クライアントが必要とする最小の通信路。
 *
 * `Worker` を直接受け取らないのは、DOM の無い node のテストから
 * 偽物を挿し込めるようにするため。実体は {@link workerPort} と
 * {@link inlinePort} の 2 つ。
 */
export interface AnalysisPort {
  /** 依頼を送る。`transfer` のバッファはゼロコピーで渡す（送信側は detach される）。 */
  send(request: AnalysisRequest, transfer: ArrayBuffer[]): void;
  /** 応答と失敗の受け取り口を登録する。 */
  listen(
    onResponse: (response: AnalysisResponse) => void,
    onError: (error: unknown) => void,
  ): void;
}

export interface AnalysisClient {
  /**
   * 解析を依頼する。解析中なら順番待ちに置く。
   *
   * 待っている間にさらに新しい依頼が来たら、こちらは送られずに `null` で
   * 解決する（結果は捨てられるので、解析させるだけ無駄）。
   */
  analyze(request: AnalysisRequest): Promise<AnalysisResponse | null>;
}

interface Pending {
  readonly resolve: (response: AnalysisResponse | null) => void;
  readonly reject: (error: unknown) => void;
}

export function createAnalysisClient(port: AnalysisPort): AnalysisClient {
  /** 応答待ちの依頼。常に 1 本以下。 */
  let inflight: (Pending & { readonly frameId: number }) | null = null;
  /** 順番待ち。1 枠だけ。 */
  let waiting: (Pending & { readonly request: AnalysisRequest }) | null = null;

  port.listen(
    (response) => {
      // 知らない frameId は捨てる。停止・再起動をまたいで遅れて届いた応答が
      // 別のフレームの結果として表示されるのを防ぐ
      if (inflight === null || inflight.frameId !== response.frameId) return;
      const done = inflight;
      inflight = null;
      done.resolve(response);
      pump();
    },
    (error) => {
      // どの依頼が落ちたか分からないので、待っているものを失敗させる。
      // 握ったままにすると以後の依頼が永久に順番待ちのまま止まる
      const failed = inflight;
      inflight = null;
      failed?.reject(error);
      pump();
    },
  );

  function dispatch(request: AnalysisRequest, pending: Pending): void {
    inflight = { frameId: request.frameId, ...pending };
    port.send(request, [request.image.pixels]);
  }

  /** 順番待ちがあれば送り出す。 */
  function pump(): void {
    if (inflight !== null || waiting === null) return;
    const next = waiting;
    waiting = null;
    dispatch(next.request, next);
  }

  return {
    analyze(request) {
      return new Promise<AnalysisResponse | null>((resolve, reject) => {
        if (inflight === null) {
          dispatch(request, { resolve, reject });
          return;
        }
        // 追い越された待機は送らずに捨てる（画像もここで手放す）
        waiting?.resolve(null);
        waiting = { request, resolve, reject };
      });
    },
  };
}

/** 実際の Worker を通信路にする。 */
export function workerPort(worker: Worker): AnalysisPort {
  return {
    send(request, transfer) {
      worker.postMessage(request, transfer);
    },
    listen(onResponse, onError) {
      worker.onmessage = (event: MessageEvent<AnalysisResponse>): void => {
        onResponse(event.data);
      };
      worker.onmessageerror = (): void => {
        onError(new Error('解析結果を受け取れませんでした'));
      };
      worker.onerror = (event): void => {
        onError(event instanceof ErrorEvent ? (event.error ?? event.message) : event);
      };
    },
  };
}

/**
 * 解析クライアントを作る。Worker を作れない環境ではメインスレッドに落とす。
 *
 * 自動での作り直しはしない（Worker が動き出してから落ちた場合は、
 * 待機中の依頼を失敗させて呼び出し側に知らせる）。落ちる要因は CSP か
 * file:// くらいで、対象ブラウザでは起こらない想定。
 */
export function createDefaultClient(): AnalysisClient {
  try {
    const worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), {
      type: 'module',
    });
    return createAnalysisClient(workerPort(worker));
  } catch (error) {
    console.warn('解析 Worker を作れませんでした。メインスレッドで解析します', error);
    return createAnalysisClient(inlinePort());
  }
}

/**
 * Worker を作れなかったときの代わり。メインスレッドで同じ経路を回す。
 *
 * **解析本体は動的 import で引く。** 静的に import すると、Worker へ追い出した
 * はずのパイプライン一式（検出・切り出し・色帯解析）がメインのバンドルにも
 * 入ってしまい、起動時に 25kB ぶん（gzip 9kB・モジュール約 30 本）を余計に
 * 読み込んで parse することになる。まず通らない経路のために全員が払う額ではない。
 *
 * 応答が非同期なのは Worker と同じ（`send` の契約どおり）。
 */
export function inlinePort(): AnalysisPort {
  let onResponse: ((response: AnalysisResponse) => void) | null = null;
  let onError: ((error: unknown) => void) | null = null;

  return {
    send(request) {
      void import('./runAnalysis.js').then(
        ({ runAnalysis }) => {
          let result: AnalysisResponse;
          try {
            result = runAnalysis(request);
          } catch (error) {
            onError?.(error);
            return;
          }
          onResponse?.(result);
        },
        (error: unknown) => {
          onError?.(error);
        },
      );
    },
    listen(response, error) {
      onResponse = response;
      onError = error;
    },
  };
}
