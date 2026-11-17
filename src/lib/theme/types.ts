/**
 * テーマ（配色）の型。
 *
 * テーマは宣言的なデータだけで表す。色の値はすべて `#rrggbb`（小文字）に揃えた文字列。
 * JSON のキーは camelCase、CSS 変数は `--rk-<kebab>`（対応は cssVars.ts）。
 *
 * @module theme/types
 */

/** 画面の枠（サイドバー・タブ・タイトルバー・ダイアログなど）の色。19 個。 */
export interface UiPalette {
  /** 本文の背景。タイトルバー・グループ見出しにも使う */
  bg: string;
  /** サイドバーの背景 */
  bgSidebar: string;
  /** ダイアログ・メニューなど浮いている面の背景 */
  bgElevated: string;
  /** 入力欄など一段沈んだ面の背景 */
  bgInset: string;
  /** ホバー中の項目の背景 */
  bgHover: string;
  /** 選択中の項目の背景 */
  bgActive: string;
  /** 本文の文字 */
  fg: string;
  /** 補足の文字 */
  fgMuted: string;
  /** さらに控えめな文字（ヒント・無効） */
  fgDim: string;
  /** 控えめな仕切り線 */
  border: string;
  /** はっきりした仕切り線（パネル間など） */
  borderStrong: string;
  /** 強調色（フォーカス・選択・リンク） */
  accent: string;
  /** 2 番目の強調色 */
  accent2: string;
  /** accent の上に置く文字 */
  onAccent: string;
  /** 危険・エラー */
  danger: string;
  /** 注意 */
  warning: string;
  /** 成功・完了 */
  success: string;
  /** エージェントの応答待ち */
  agentBlocked: string;
  /** エージェントの実行中 */
  agentWorking: string;
}

/** ターミナル（xterm）の配色。ANSI 16 色を含む。 */
export interface TerminalPalette {
  /** ターミナルの背景。JSON で省略したときは ui.bg になる */
  background: string;
  foreground: string;
  cursor: string;
  /** カーソルの上の文字 */
  cursorAccent: string;
  /** 選択範囲。xterm は不透明な色を 30% の濃さで重ねる */
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** 明暗。書かれていない色をどのテーマから補うか、hoverTint などの自動色を決める。 */
export type ThemeAppearance = 'dark' | 'light';

/** 組み込みか、ユーザーが themes フォルダに置いたものか。 */
export type ThemeSource = 'builtin' | 'user';

export interface ThemeDefinition {
  /** 組み込みは `tokyo-night` などの固定値、ユーザーのテーマは `user:<ファイル名の stem>` */
  id: string;
  /** 表示名 */
  name: string;
  appearance: ThemeAppearance;
  source: ThemeSource;
  ui: UiPalette;
  terminal: TerminalPalette;
}
