/**
 * シャッターの合図（音）。
 *
 * 音声ファイルは置かず、WebAudio で「ピピッ」を合成する（アセットを
 * 増やさない・外部 CDN に依存しないという方針に合わせる）。
 *
 * AudioContext はユーザー操作の中でしか始められないので、最初の
 * シャッターで作って以後は使い回す。音が出せない環境では黙って諦める
 * （撮影自体は続く）。
 */

const BEEP_MS = 60;
const GAP_MS = 90;
const FIRST_HZ = 1400;
const SECOND_HZ = 1900;
const PEAK_GAIN = 0.22;

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context !== null) return context;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

function beep(target: AudioContext, at: number, frequency: number): void {
  const oscillator = target.createOscillator();
  const gain = target.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = frequency;

  // 立ち上がり・立ち下がりを丸めてプチッというノイズを避ける
  const seconds = BEEP_MS / 1000;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

  oscillator.connect(gain);
  gain.connect(target.destination);
  oscillator.start(at);
  oscillator.stop(at + seconds + 0.02);
}

/** 「ピピッ」と鳴らす。ユーザー操作の中から呼ぶこと。 */
export function playShutterSound(): void {
  const target = audioContext();
  if (target === null) return;
  try {
    // タブが背面に回ったあとは suspended になっている
    void target.resume();
    const now = target.currentTime;
    beep(target, now, FIRST_HZ);
    beep(target, now + GAP_MS / 1000, SECOND_HZ);
  } catch {
    // 音が出せなくても撮影は続ける
  }
}
