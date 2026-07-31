import { describe, expect, it } from 'vitest';
import {
  recoverFromGap,
  recoverFromPair,
  recoverRuns,
  recoverToleranceRun,
} from '../../src/core/bands/recover.js';
import { srgb255ToLab } from '../../src/core/color/colorSpace.js';
import { BAND_SRGB, BODY_SRGB } from '../../src/core/color/colors.js';
import type { BandColor, LabColor, ProfileSample } from '../../src/types.js';
import type { ColorRun } from '../../src/core/bands/runs.js';

/**
 * 見つからなかった許容差バンドの拾い直し。
 *
 * 位置を絞ったうえで本体色との差を見るので、全体のラン分割より弱い基準で
 * 拾える。ただし**条件を満たさないときに何もしない**ことが同じくらい大事で、
 * 無理に 4 本目を作ると誤読が増える。
 */

const BODY: LabColor = srgb255ToLab(...(BODY_SRGB.beige as [number, number, number]));
const bandLab = (color: BandColor): LabColor =>
  srgb255ToLab(...(BAND_SRGB[color] as [number, number, number]));

/** 本体色で埋めたプロファイルの、指定範囲だけ色を差し替える。 */
function profileWith(
  length: number,
  patches: readonly { start: number; end: number; lab: LabColor }[],
): ProfileSample[] {
  return Array.from({ length }, (_, x) => {
    const patch = patches.find((p) => x >= p.start && x < p.end);
    return { x, lab: patch === undefined ? BODY : patch.lab };
  });
}

function runOf(start: number, end: number, color: BandColor): ColorRun {
  return { start, end, lab: bandLab(color) };
}

/** 中心 23 / 51 / 65 / 79。最初の間隔だけ 28 で、他は 14。 */
const WIDE_FIRST: ColorRun[] = [
  runOf(20, 26, 'brown'),
  runOf(48, 54, 'black'),
  runOf(62, 68, 'black'),
  runOf(76, 82, 'brown'),
];

/** 広すぎる間隔（26..48）の中央に銀が実在する並び。 */
const WITH_SILVER = profileWith(100, [
  { start: 20, end: 26, lab: bandLab('brown') },
  { start: 34, end: 40, lab: bandLab('silver') },
  { start: 48, end: 54, lab: bandLab('black') },
  { start: 62, end: 68, lab: bandLab('black') },
  { start: 76, end: 82, lab: bandLab('brown') },
]);

describe('recoverToleranceRun', () => {
  /** 100 列の本体に、3 本のバンドと 1 本の金バンドを置いた並び。 */
  const THREE: ColorRun[] = [runOf(20, 26, 'brown'), runOf(34, 40, 'black'), runOf(48, 54, 'red')];

  it('3 本目の先に色の変化があれば 4 本目として拾う', () => {
    // Arrange: 3 本目の中心 51、間隔 14 なので探索窓は 65..79。そこに金を置く
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('red') },
      { start: 68, end: 74, lab: bandLab('gold') },
    ]);

    // Act
    const runs = recoverToleranceRun(profile, THREE);

    // Assert
    expect(runs).toHaveLength(4);
    expect((runs[3] as ColorRun).start).toBeGreaterThanOrEqual(65);
    expect((runs[3] as ColorRun).end).toBeLessThanOrEqual(80);
  });

  it('探索窓に色の変化が無ければ足さない', () => {
    // Arrange: バンドは 3 本だけ（先は本体色のまま）
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('red') },
    ]);

    // Act / Assert
    expect(recoverToleranceRun(profile, THREE)).toHaveLength(3);
  });

  it('ランが 3 本でなければ何もしない', () => {
    const profile = profileWith(100, []);

    expect(recoverToleranceRun(profile, THREE.slice(0, 2))).toHaveLength(2);
    expect(recoverToleranceRun(profile, [...THREE, runOf(68, 74, 'gold')])).toHaveLength(4);
  });

  it('3 本目が本体の中央付近に無ければ探さない', () => {
    // Arrange: 3 本が右に寄っていて、3 本目が 80% の位置にある
    const shifted = [runOf(50, 56, 'brown'), runOf(64, 70, 'black'), runOf(78, 84, 'red')];
    const profile = profileWith(100, [{ start: 92, end: 98, lab: bandLab('gold') }]);

    // Act / Assert: 先に場所が残っていないので拾わない
    expect(recoverToleranceRun(profile, shifted)).toHaveLength(3);
  });

  it('拾ったランの色はその区間の中央値になる', () => {
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('red') },
      { start: 68, end: 74, lab: bandLab('green') },
    ]);

    const runs = recoverToleranceRun(profile, THREE);

    expect((runs[3] as ColorRun).lab.a).toBeCloseTo(bandLab('green').a, 1);
  });

  it('空のプロファイルでも落ちない', () => {
    expect(recoverToleranceRun([], THREE)).toHaveLength(3);
  });
});

/**
 * ランが 2 本しか出なかったときの拾い直し。
 *
 * 2 本では `MIN_BANDS` に届かず読み取り不能なので、**何を足しても既存の
 * 正しい読み取りを壊せない**。値が変わらない位置に限るという
 * `recoverToleranceRun` の制約は、ここには当てはまらない。
 */
describe('recoverFromPair', () => {
  /** 100 列の本体に 2 本だけ見つかった状態（中心 23 と 37、刻み 14）。 */
  const PAIR: ColorRun[] = [runOf(20, 26, 'brown'), runOf(34, 40, 'green')];

  it('刻みの 1 倍・2 倍先に色の変化があれば 2 本まで拾う', () => {
    // Arrange: 予測位置は 51 と 65。金は本体と明度しか違わず、
    //          全体のラン分割（ΔE 20）では切れない距離に置く
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('green') },
      { start: 48, end: 54, lab: bandLab('gold') },
      { start: 62, end: 68, lab: bandLab('gold') },
    ]);

    // Act
    const runs = recoverFromPair(profile, PAIR);

    // Assert
    expect(runs).toHaveLength(4);
    expect((runs[2] as ColorRun).start).toBeGreaterThanOrEqual(44);
    expect((runs[3] as ColorRun).end).toBeLessThanOrEqual(72);
  });

  it('拾ったランは位置順に並ぶ', () => {
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('green') },
      { start: 48, end: 54, lab: bandLab('gold') },
      { start: 62, end: 68, lab: bandLab('gold') },
    ]);

    const runs = recoverFromPair(profile, PAIR);

    const starts = runs.map((run) => run.start);
    expect(starts).toStrictEqual([...starts].sort((a, b) => a - b));
  });

  it('先に色の変化が無ければ足さない', () => {
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('green') },
    ]);

    expect(recoverFromPair(profile, PAIR)).toHaveLength(2);
  });

  it('ランが 2 本でなければ何もしない', () => {
    const profile = profileWith(100, [{ start: 48, end: 54, lab: bandLab('gold') }]);

    expect(recoverFromPair(profile, PAIR.slice(0, 1))).toHaveLength(1);
    expect(recoverFromPair(profile, [...PAIR, runOf(48, 54, 'gold')])).toHaveLength(3);
  });

  it('先に場所が残っていなければ探さない', () => {
    // Arrange: 2 本が右端に寄っていて、刻み 1 つぶんの余地も無い
    const shifted = [runOf(70, 76, 'brown'), runOf(84, 90, 'green')];
    const profile = profileWith(100, [{ start: 92, end: 98, lab: bandLab('gold') }]);

    expect(recoverFromPair(profile, shifted)).toHaveLength(2);
  });

  it('空のプロファイルでも落ちない', () => {
    expect(recoverFromPair([], PAIR)).toHaveLength(2);
  });
});

/**
 * 隣接間隔が 1 つだけ異常に広いときの、中間への挿入。
 *
 * `recoverToleranceRun` は末尾にしか足さないので値が変わらないが、こちらは
 * **数字・倍率の位置に挿入する**ので値が直接変わる（`docs/11` §3.5.1 で
 * 格子の内挿が悪化したのと同じ刃）。だから発火条件を「他の間隔と比べて
 * 明らかに広い」に絞り、挿入したランには金属容疑の印をつけて数字に化ける
 * 経路を閉じる。
 */
describe('recoverFromGap', () => {
  /** 中心 23 / 37 / 51 / 65。間隔はすべて 14。 */
  const EVEN: ColorRun[] = [
    runOf(20, 26, 'brown'),
    runOf(34, 40, 'black'),
    runOf(48, 54, 'black'),
    runOf(62, 68, 'brown'),
  ];

  it('広すぎる間隔の中央に色の変化があれば 1 本挿入する', () => {
    const runs = recoverFromGap(WITH_SILVER, WIDE_FIRST);

    expect(runs).toHaveLength(5);
    expect((runs[1] as ColorRun).start).toBeGreaterThanOrEqual(30);
    expect((runs[1] as ColorRun).end).toBeLessThanOrEqual(44);
  });

  it('挿入したランは位置順に並ぶ', () => {
    const starts = recoverFromGap(WITH_SILVER, WIDE_FIRST).map((run) => run.start);

    expect(starts).toStrictEqual([...starts].sort((a, b) => a - b));
  });

  it('挿入したランには金属容疑の印がつく', () => {
    // 位置からの推測で足したランは、数字に化けると桁が壊れる。
    // 本体に飲み込まれるほど本体に近かった以上、金・銀にしかなりえない。
    const runs = recoverFromGap(WITH_SILVER, WIDE_FIRST);

    expect((runs[1] as ColorRun).metallicOnly).toBe(true);
    // 元からあったランには印をつけない
    expect((runs[0] as ColorRun).metallicOnly).toBeUndefined();
  });

  it('間隔が揃っていれば何もしない', () => {
    // Arrange: 間隔は 14 で揃っている。先に色の変化があっても足さない
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('black') },
      { start: 62, end: 68, lab: bandLab('brown') },
      { start: 76, end: 82, lab: bandLab('silver') },
    ]);

    expect(recoverFromGap(profile, EVEN)).toHaveLength(4);
  });

  it('間隔が広くても色の変化が無ければ足さない', () => {
    // Arrange: 間隔 28 の内側は本体色のまま
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 48, end: 54, lab: bandLab('black') },
      { start: 62, end: 68, lab: bandLab('black') },
      { start: 76, end: 82, lab: bandLab('brown') },
    ]);

    expect(recoverFromGap(profile, WIDE_FIRST)).toHaveLength(4);
  });

  it('周りのバンドより極端に太い区間は挿入しない', () => {
    // Arrange: 間隔の内側がまるごと本体色から外れている。バンドではなく
    //          本体の陰や肩の照り返しなので、幅で弾く（実測 09-82Ω が該当）
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 28, end: 46, lab: bandLab('silver') },
      { start: 48, end: 54, lab: bandLab('black') },
      { start: 62, end: 68, lab: bandLab('black') },
      { start: 76, end: 82, lab: bandLab('brown') },
    ]);

    expect(recoverFromGap(profile, WIDE_FIRST)).toHaveLength(4);
  });

  it('間隔を比べる相手が足りなければ（ラン 3 本以下）何もしない', () => {
    // 間隔が 2 つしか無いと「他より広い」を中央値で言えない
    const three = [runOf(20, 26, 'brown'), runOf(48, 54, 'black'), runOf(62, 68, 'black')];

    expect(recoverFromGap(WITH_SILVER, three)).toHaveLength(3);
  });

  it('すでにバンドが多すぎるときは挿入しない', () => {
    // Arrange: 6 本も出ているのは過分割であって、不足ではない
    //          （実測 07-10Ω はカーペットの模様で 8 本に割れている）
    const many: ColorRun[] = [
      runOf(10, 16, 'brown'),
      runOf(38, 44, 'black'),
      runOf(52, 58, 'black'),
      runOf(66, 72, 'brown'),
      runOf(80, 86, 'red'),
      runOf(94, 100, 'red'),
    ];
    const profile = profileWith(120, [{ start: 24, end: 30, lab: bandLab('silver') }]);

    expect(recoverFromGap(profile, many)).toHaveLength(6);
  });

  it('空のプロファイルでも落ちない', () => {
    expect(recoverFromGap([], WIDE_FIRST)).toHaveLength(4);
  });
});

/**
 * 3 つの拾い直しを本番の順序で通す合成。
 *
 * 解析と較正がそれぞれ手で合成していた時期に経路が分岐したので、順序と
 * 組み合わせは `recoverRuns` にしか書かない。
 */
describe('recoverRuns', () => {
  it('ラン 4 本で間隔が広ければ中間挿入が働く', () => {
    const runs = recoverRuns(WITH_SILVER, WIDE_FIRST);

    expect(runs).toHaveLength(5);
    expect((runs[1] as ColorRun).metallicOnly).toBe(true);
  });

  it('ラン 3 本なら中間挿入は働かず、末尾の拾い直しに回る', () => {
    // 中間挿入は 4 本以上でしか発火しないので、3 本の写真は従来どおり
    const three = [runOf(20, 26, 'brown'), runOf(34, 40, 'black'), runOf(48, 54, 'red')];
    const profile = profileWith(100, [
      { start: 20, end: 26, lab: bandLab('brown') },
      { start: 34, end: 40, lab: bandLab('black') },
      { start: 48, end: 54, lab: bandLab('red') },
      { start: 68, end: 74, lab: bandLab('gold') },
    ]);

    const runs = recoverRuns(profile, three);

    expect(runs).toHaveLength(4);
    // 末尾に足したランは推測ではなく走査の結果なので印はつかない
    expect((runs[3] as ColorRun).metallicOnly).toBeUndefined();
  });
});
