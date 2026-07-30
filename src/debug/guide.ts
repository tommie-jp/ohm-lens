import type { OrientedBox } from '../core/locate.js';
import type { Rect } from './viewMapping.js';

/**
 * 手動読み取り用のガイド枠（自動検出 OFF のとき）。
 *
 * 画面の高さ方向中央に抵抗器を模した水平の赤い長方形を出し、利用者が
 * そこへ抵抗器を合わせる。カラーコードの読み取りもこの枠をそのまま
 * `OrientedBox` として使うので、「見えている枠 = 解析する範囲」になる。
 *
 * 基準にするのはフレーム全体ではなく**実際に画面へ出ている範囲**
 * （`coverVisibleRect`）。映像は画面いっぱいに出すため左右または上下が
 * 切り落とされており、フレーム全体を基準にすると枠が画面外へはみ出す。
 */

/** ガイドの長さ（可視範囲の幅に対する割合）。 */
export const GUIDE_LENGTH_RATIO = 0.6;

/** 抵抗器本体の縦横比（長さ : 太さ）。実写サンプルのおよその比率。 */
export const GUIDE_ASPECT_RATIO = 3.5;

/**
 * 枠を置く高さ（可視範囲の上端からの割合）。
 * 中央だと下部の操作バーと視線がぶつかるので、やや上に寄せる。
 */
export const GUIDE_CENTER_Y_RATIO = 0.3;

/** 縦に潰れた可視範囲でも枠がはみ出さないよう、高さに対する上限を設ける。 */
const MAX_THICKNESS_RATIO = 0.5;

/** 可視範囲の上から 30% の高さに置く水平のガイド枠。 */
export function guideBox(visible: Rect): OrientedBox {
  const length = visible.width * GUIDE_LENGTH_RATIO;
  const thickness = Math.min(length / GUIDE_ASPECT_RATIO, visible.height * MAX_THICKNESS_RATIO);
  return {
    centerX: visible.x + visible.width / 2,
    centerY: visible.y + visible.height * GUIDE_CENTER_Y_RATIO,
    angleDeg: 0,
    length,
    thickness,
  };
}
