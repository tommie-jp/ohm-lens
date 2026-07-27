/**
 * 人間が入力する抵抗値の表記を Ω に変換する。
 *
 * 学習フローでは「カメラに映した抵抗の正解値をタイプする」ので、
 * 現場で使われる表記を広めに受け付ける:
 * - 素の数値: "220" "4.7" "0.47"
 * - 接頭辞: "4.7k" "10M"
 * - 部品表記（接頭辞が小数点を兼ねる）: "4k7" "1M2" "4R7" "R47"
 * - 単位や全角: "220Ω" "4.7 kΩ" "１０ｋ"
 */

const MULTIPLIERS: Record<string, number> = {
  r: 1,
  k: 1e3,
  m: 1e6,
  g: 1e9,
};

/** 全角英数字を半角へ寄せ、単位表記を落とす。 */
function normalize(input: string): string {
  return input
    .replace(/[０-９ａ-ｚＡ-Ｚ．]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/ω|Ω|ohms?|オーム/giu, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 抵抗値の表記を Ω に変換する。解釈できなければ null。
 * 0 以下は抵抗値として扱わない（0Ω ジャンパは学習対象外）。
 */
export function parseOhms(input: string): number | null {
  const text = normalize(input);
  if (text === '') return null;

  // 部品表記: 4k7 / 1M2 / 4R7 / R47（接頭辞が小数点を兼ねる）
  const component = /^(\d*)([rkmg])(\d*)$/.exec(text);
  if (component !== null) {
    const [, whole = '', prefix = 'r', fraction = ''] = component;
    if (whole === '' && fraction === '') return null;
    const value = Number.parseFloat(`${whole === '' ? '0' : whole}.${fraction === '' ? '0' : fraction}`);
    const ohms = value * (MULTIPLIERS[prefix] as number);
    return ohms > 0 ? ohms : null;
  }

  // 通常表記: 4.7k / 220
  const plain = /^(\d+(?:\.\d+)?)([rkmg]?)$/.exec(text);
  if (plain === null) return null;

  const [, digits = '', prefix] = plain;
  const ohms = Number.parseFloat(digits) * (MULTIPLIERS[prefix === '' ? 'r' : (prefix as string)] as number);
  return Number.isFinite(ohms) && ohms > 0 ? ohms : null;
}
