/**
 * ビルド時に差し込まれる値の型。
 *
 * 実体は `vite.config.ts` の `define`。package.json の version をそのまま
 * 埋めているので、版を上げるのは package.json だけでよい。
 */
declare const __APP_VERSION__: string;
