import { describe, expect, it } from 'vitest';
import { createSampleImage } from '../../src/debug/sampleImage.js';
import {
  toTransferImage,
  type AnalysisRequest,
  type AnalysisResponse,
} from '../../src/debug/analysis/protocol.js';
import { runAnalysis } from '../../src/debug/analysis/runAnalysis.js';
import {
  createAnalysisClient,
  inlinePort,
  type AnalysisPort,
} from '../../src/debug/analysis/analysisClient.js';

let nextFrameId = 0;

function requestFor(): AnalysisRequest {
  nextFrameId += 1;
  return {
    frameId: nextFrameId,
    image: toTransferImage(createSampleImage()),
    mode: { kind: 'auto' },
    paletteColors: null,
  };
}

/**
 * 応答のタイミングを手で制御できる偽の通信路。
 * `flush` を呼ぶまで応答しないので、解析中のふるまいを試せる。
 */
function fakePort(): {
  port: AnalysisPort;
  sent: AnalysisRequest[];
  transfers: ArrayBuffer[][];
  flush: () => void;
  respond: (response: AnalysisResponse) => void;
  fail: (error: unknown) => void;
} {
  const sent: AnalysisRequest[] = [];
  const transfers: ArrayBuffer[][] = [];
  let onResponse: ((response: AnalysisResponse) => void) | null = null;
  let onError: ((error: unknown) => void) | null = null;

  return {
    sent,
    transfers,
    port: {
      send(request, transfer) {
        sent.push(request);
        transfers.push(transfer);
      },
      listen(response, error) {
        onResponse = response;
        onError = error;
      },
    },
    flush() {
      for (const request of sent.splice(0)) onResponse?.(runAnalysis(request));
    },
    respond(response) {
      onResponse?.(response);
    },
    fail(error) {
      onError?.(error);
    },
  };
}

/** 順番待ちの依頼が実際に送られるまでマイクロタスクを回す。 */
async function settle(fake: { sent: AnalysisRequest[] }): Promise<void> {
  for (let i = 0; i < 10 && fake.sent.length === 0; i += 1) await Promise.resolve();
}

describe('createAnalysisClient', () => {
  it('依頼を送り、応答を frameId で突き合わせて返す', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const request = requestFor();

    // Act
    const pending = client.analyze(request);
    fake.flush();
    const response = await pending;

    // Assert
    expect(response?.frameId).toBe(request.frameId);
    expect(response?.analysis?.reading?.ohms).toBeCloseTo(4700, 6);
  });

  it('送信時に transfer リストを渡す（ゼロコピー転送）', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const request = requestFor();

    // Act
    const pending = client.analyze(request);

    // Assert
    expect(fake.transfers[0]).toEqual([request.image.pixels]);
    fake.flush();
    await pending;
  });

  it('知らない frameId の応答は捨てる（停止後に届いた分など）', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const request = requestFor();
    const pending = client.analyze(request);

    // Act: 別フレームの応答が先に届く
    fake.respond({
      frameId: request.frameId + 999,
      box: null,
      roi: null,
      analysis: null,
      durationMs: 0,
    });
    fake.flush();

    // Assert: 本来の応答で解決する
    expect((await pending)?.frameId).toBe(request.frameId);
  });

  it('解析中の依頼は順番待ちにして、終わってから送る', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const first = client.analyze(requestFor());
    const secondRequest = requestFor();
    const second = client.analyze(secondRequest);

    // Act / Assert: 2 本目は 1 本目が終わるまで送られない
    expect(fake.sent).toHaveLength(1);
    fake.flush();
    await first;
    await settle(fake);

    // 送られたのは 2 本目だけ（同時に 2 本は流れない）
    expect(fake.sent).toEqual([secondRequest]);
    fake.flush();
    expect((await second)?.analysis?.reading?.ohms).toBeCloseTo(4700, 6);
  });

  it('順番待ちは 1 枠だけ。追い越された依頼は送らずに null で解決する', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const first = client.analyze(requestFor());
    const superseded = client.analyze(requestFor());
    const latestRequest = requestFor();
    const latest = client.analyze(latestRequest);

    // Act
    fake.flush();
    await first;
    await settle(fake);

    // Assert: 追い越された依頼は解析されない（結果は捨てられるので無駄）
    expect(await superseded).toBeNull();
    expect(fake.sent).toEqual([latestRequest]);
    fake.flush();
    expect((await latest)?.frameId).toBe(latestRequest.frameId);
  });

  it('通信路のエラーで待機中の依頼を失敗させる', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const pending = client.analyze(requestFor());

    // Act
    fake.fail(new Error('worker が落ちました'));

    // Assert
    await expect(pending).rejects.toThrow('worker が落ちました');
  });

  it('エラーの後も次の依頼を受け付ける（待機は残さない）', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const failed = client.analyze(requestFor());
    fake.fail(new Error('一時的な失敗'));
    await expect(failed).rejects.toThrow();
    fake.sent.splice(0); // 失敗した依頼にはもう応答しない

    // Act
    const nextRequest = requestFor();
    const next = client.analyze(nextRequest);

    // Assert
    expect(fake.sent).toEqual([nextRequest]);
    fake.flush();
    expect(await next).not.toBeNull();
  });

  it('エラーで待機が詰まらない（順番待ちは繰り上がる）', async () => {
    // Arrange
    const fake = fakePort();
    const client = createAnalysisClient(fake.port);
    const failing = client.analyze(requestFor());
    const nextRequest = requestFor();
    const next = client.analyze(nextRequest);

    // Act
    fake.fail(new Error('1 本目が落ちた'));
    await expect(failing).rejects.toThrow();

    // Assert: 順番待ちが繰り上がって送られる
    expect(fake.sent.at(-1)).toBe(nextRequest);
    fake.sent.splice(0, 1); // 失敗した 1 本目にはもう応答しない
    fake.flush();
    expect((await next)?.frameId).toBe(nextRequest.frameId);
  });
});

describe('inlinePort', () => {
  it('Worker を使えない環境でも同じ経路で解析できる', async () => {
    // Arrange
    const client = createAnalysisClient(inlinePort());

    // Act
    const response = await client.analyze(requestFor());

    // Assert
    expect(response?.analysis?.reading?.ohms).toBeCloseTo(4700, 6);
  });

  it('Worker と同じく応答は必ず非同期（同期で解決しない）', async () => {
    // Arrange
    const client = createAnalysisClient(inlinePort());

    // Act: 送った直後は解析中なので、次の依頼は順番待ちになる
    const first = client.analyze(requestFor());
    const superseded = client.analyze(requestFor());
    const latest = client.analyze(requestFor());

    // Assert
    expect(await superseded).toBeNull();
    expect((await first)?.analysis?.reading?.ohms).toBeCloseTo(4700, 6);
    expect((await latest)?.analysis?.reading?.ohms).toBeCloseTo(4700, 6);
  });
});
