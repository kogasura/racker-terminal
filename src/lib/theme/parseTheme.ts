/**
 * ユーザーのテーマファイル（themes フォルダの *.json）を検証し、ベースのテーマとマージする。
 *
 * - 書かれたキーだけ上書きする。書かれていない色は appearance に応じたベース
 *   （dark は Tokyo Night、light は Racker Paper）から補う。
 * - 未知のキーは無視する。古い版で新しいファイルを読んでも壊れない。
 * - `backdrop.svg` は themes フォルダの SVG のファイル名。中身は呼び出し側が渡す対応表から引く。
 *   Windows のファイル名なので、完全に一致するものが無ければ大文字小文字を区別せずに探し直す。
 * - 値が読めないキーが 1 つでもあればファイル全体を無効にし、直せるよう具体的な理由を返す。
 *
 * I/O は持たない純関数。ファイルの読み込みは Rust 側（list_user_themes）が行う。
 *
 * @module theme/parseTheme
 */

import { RACKER_PAPER, TOKYO_NIGHT } from './builtinThemes';
import type {
  TerminalPalette,
  ThemeAppearance,
  ThemeBackdrop,
  ThemeDefinition,
  ThemeGlass,
  UiPalette,
} from './types';

export type ParseThemeResult =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; fileName: string; error: string };

/** テーマ名の上限（文字数）。設定画面の select に収まる長さ。 */
const NAME_MAX_LENGTH = 40;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** glass を省略したときの値。tint の既定は ui.bg。 */
const DEFAULT_GLASS_BLUR = 14;
const DEFAULT_GLASS_OPACITY = 0.4;
/** glass.blur の上限（px）。強いぼかしは描画が重くなる。 */
const GLASS_BLUR_MAX = 40;

type JsonObject = Record<string, unknown>;

/**
 * `backdrop.svg` が対応表に無かったときに、理由を出し分けるための手がかり。
 * 呼び出し側（themes フォルダを読んだ側）が分かる範囲で渡す。
 */
export interface SvgLookupHints {
  /**
   * フォルダにはあるが読めなかった SVG のファイル名（大きすぎる・UTF-8 でない・SVG として
   * 読めない など）。理由はその SVG のファイル名でエラー一覧に出ている
   */
  readonly unreadable?: ReadonlySet<string>;
  /**
   * 読んだファイルがファイル数の上限 (MAX_THEME_FILES) に達していたか。名前順で後ろの
   * ファイルを読んでいないかもしれない。読んでいないファイルの名前は分からないので、
   * 見つからないときの注記に使う
   */
  readonly truncated?: boolean;
}

/** themes フォルダで読むファイル数の上限（Rust の list_user_themes の MAX_FILES と同じ）。 */
export const MAX_THEME_FILES = 100;

/** 検証に失敗したことを表す。メッセージはそのまま設定画面に出す。 */
class ThemeFileError extends Error {}

/**
 * テーマファイルの中身を検証して ThemeDefinition にする。
 * @param fileName - themes フォルダ内のファイル名（例: `sunset.json`）。ID は `user:<stem>` になる
 * @param content - ファイルの中身（JSON 文字列）
 * @param svgFiles - themes フォルダの SVG のファイル名 → 中身。`backdrop.svg` をここから引く。
 *   省略すると空とみなす（backdrop の無いテーマは従来どおり読める）
 * @param hints - `backdrop.svg` が見つからないときの理由を出し分ける手がかり。省略可
 */
export function parseThemeFile(
  fileName: string,
  content: string,
  svgFiles: Readonly<Record<string, string>> = {},
  hints: SvgLookupHints = {},
): ParseThemeResult {
  try {
    return { ok: true, theme: buildTheme(fileName, content, svgFiles, hints) };
  } catch (e) {
    if (e instanceof ThemeFileError) return { ok: false, fileName, error: e.message };
    // 想定外の失敗でも 1 ファイルの問題に留める。投げると読み込み全体が止まる。
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, fileName, error: `テーマを読み込めませんでした: ${detail}` };
  }
}

function buildTheme(
  fileName: string,
  content: string,
  svgFiles: Readonly<Record<string, string>>,
  hints: SvgLookupHints,
): ThemeDefinition {
  const root = parseRoot(content);
  const name = readName(root.name);
  const appearance = readAppearance(root.appearance);
  const base = appearance === 'light' ? RACKER_PAPER : TOKYO_NIGHT;
  const uiInput = readSection(root, 'ui');
  const terminalInput = readSection(root, 'terminal');

  const ui = mergePalette<UiPalette>('ui', base.ui, uiInput);
  // terminal.background を省略したら、ターミナルの背景は枠の背景 (ui.bg) に揃える
  const terminalBase: TerminalPalette = {
    ...base.terminal,
    background: uiInput.bg === undefined ? base.terminal.background : ui.bg,
  };
  const terminal = mergePalette<TerminalPalette>('terminal', terminalBase, terminalInput);

  const theme: ThemeDefinition = {
    id: `user:${stemOf(fileName)}`,
    name,
    appearance,
    source: 'user',
    ui,
    terminal,
  };
  if (root.backdrop === undefined) return theme;
  const { backdrop, glass } = readBackdrop(root.backdrop, svgFiles, hints, ui.bg);
  return { ...theme, backdrop, glass };
}

/**
 * エラー文に載せる値の表記。
 * オブジェクトと配列は型名だけにする。深くネストした値を JSON.stringify すると
 * スタックを使い切って RangeError になるため。
 */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return '配列';
  if (typeof value === 'object' && value !== null) return 'オブジェクト';
  return JSON.stringify(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoot(content: string): JsonObject {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ThemeFileError(`JSON として読めません: ${detail}`);
  }
  if (!isObject(root)) {
    throw new ThemeFileError('ファイル全体を JSON のオブジェクト（{ ... }）にしてください');
  }
  return root;
}

function readName(value: unknown): string {
  if (value === undefined) {
    throw new ThemeFileError('name がありません。テーマの表示名を書いてください');
  }
  if (typeof value !== 'string') {
    throw new ThemeFileError(`name: ${describeValue(value)} は文字列で書いてください`);
  }
  const name = value.trim();
  if (name === '') throw new ThemeFileError('name が空です。テーマの表示名を書いてください');
  // サロゲートペア（絵文字など）を 1 文字と数える
  const length = Array.from(name).length;
  if (length > NAME_MAX_LENGTH) {
    throw new ThemeFileError(
      `name は ${NAME_MAX_LENGTH} 文字以内にしてください（いまは ${length} 文字）`,
    );
  }
  return name;
}

/** appearance は省略可（dark とみなす）。 */
function readAppearance(value: unknown): ThemeAppearance {
  if (value === undefined) return 'dark';
  if (value === 'dark' || value === 'light') return value;
  throw new ThemeFileError(
    `appearance: ${describeValue(value)} は "dark" か "light" のどちらかにしてください`,
  );
}

/** ui / terminal は省略可（空とみなす）。 */
function readSection(root: JsonObject, key: 'ui' | 'terminal'): JsonObject {
  const value = root[key];
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new ThemeFileError(`${key} はオブジェクト（{ ... }）で書いてください`);
  }
  return value;
}

/**
 * backdrop: { svg, glass? } を読む。
 * svg はファイル名だけを受け付け（フォルダを辿らせない）、svgFiles から中身を引く。
 * glass はキーごとに省略でき、省略したキーは既定値（blur 14・tint は ui.bg・opacity 0.4）になる。
 */
function readBackdrop(
  value: unknown,
  svgFiles: Readonly<Record<string, string>>,
  hints: SvgLookupHints,
  uiBg: string,
): { backdrop: ThemeBackdrop; glass: ThemeGlass } {
  if (!isObject(value)) {
    throw new ThemeFileError('backdrop はオブジェクト（{ ... }）で書いてください');
  }
  const svgName = readSvgFileName(value.svg);
  // __proto__ などの継承したキーを拾わないよう、自前のキー (Object.keys) だけから探す
  const found = findFileName(Object.keys(svgFiles), svgName);
  if (found === undefined) throw new ThemeFileError(missingSvgMessage(svgName, hints));
  const backdrop: ThemeBackdrop = { kind: 'user', fileName: found, svg: svgFiles[found] };
  return { backdrop, glass: readGlass(value.glass, uiBg) };
}

/**
 * ファイル名の一覧から name を探す。完全に一致するものを優先し、無ければ大文字小文字を
 * 区別せずに探す（Windows ではファイル名の大小を区別しないため）。
 */
function findFileName(names: Iterable<string>, name: string): string | undefined {
  const list = [...names];
  if (list.includes(name)) return name;
  const lower = name.toLowerCase();
  return list.find((candidate) => candidate.toLowerCase() === lower);
}

/** backdrop.svg が対応表に無いときのエラー文。読めなかったのか、無いのかで出し分ける。 */
function missingSvgMessage(svgName: string, hints: SvgLookupHints): string {
  const label = describeValue(svgName);
  const unreadable = findFileName(hints.unreadable ?? [], svgName);
  if (unreadable !== undefined) {
    return `backdrop.svg: ${label} を読めませんでした（${unreadable} のエラーを参照）`;
  }
  const missing = `backdrop.svg: ${label} が themes フォルダにありません`;
  if (!hints.truncated) return missing;
  return `${missing}（ファイルが ${MAX_THEME_FILES} 個を超えると、名前順で後ろのファイルは読みません）`;
}

/** backdrop.svg を読む。themes フォルダ内のファイル名だけを受け付ける。 */
function readSvgFileName(svgName: unknown): string {
  if (svgName === undefined) {
    throw new ThemeFileError(
      'backdrop.svg がありません。themes フォルダに置いた SVG のファイル名を書いてください',
    );
  }
  if (typeof svgName !== 'string' || svgName.trim() === '') {
    throw new ThemeFileError(
      `backdrop.svg: ${describeValue(svgName)} は SVG のファイル名（文字列）で書いてください`,
    );
  }
  if (svgName.includes('/') || svgName.includes('\\') || svgName.includes('..')) {
    throw new ThemeFileError(
      `backdrop.svg: ${describeValue(svgName)} にはフォルダを含めず、themes フォルダ内のファイル名だけを書いてください`,
    );
  }
  return svgName;
}

/** backdrop.glass を読む。省略したキーは既定値（tint は ui.bg）。 */
function readGlass(value: unknown, uiBg: string): ThemeGlass {
  const input = value === undefined ? {} : value;
  if (!isObject(input)) {
    throw new ThemeFileError('backdrop.glass はオブジェクト（{ ... }）で書いてください');
  }
  return {
    blur: readRange('backdrop.glass.blur', input.blur, DEFAULT_GLASS_BLUR, 0, GLASS_BLUR_MAX),
    tint: input.tint === undefined ? uiBg : normalizeColor('backdrop.glass.tint', input.tint),
    opacity: readRange('backdrop.glass.opacity', input.opacity, DEFAULT_GLASS_OPACITY, 0, 1),
  };
}

/** min〜max（両端を含む）の数を読む。省略なら fallback。 */
function readRange(
  path: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ThemeFileError(`${path}: ${describeValue(value)} は ${min}〜${max} の数で書いてください`);
  }
  return value;
}

/**
 * base のキーごとに、input に値があれば検証して上書きする。
 * base に無いキーは見ないので、未知のキーは自然に無視される。
 */
function mergePalette<T extends object>(section: string, base: T, input: JsonObject): T {
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof T & string)[]) {
    const value = input[key];
    if (value === undefined) continue;
    merged[key] = normalizeColor(`${section}.${key}`, value) as T[keyof T & string];
  }
  return merged;
}

/** `#rgb` / `#rrggbb` を受け付け、小文字の `#rrggbb` に揃える。 */
function normalizeColor(path: string, value: unknown): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new ThemeFileError(
      `${path}: ${describeValue(value)} は色として読めません（#rgb か #rrggbb で書いてください）`,
    );
  }
  const hex = value.slice(1).toLowerCase();
  if (hex.length === 6) return `#${hex}`;
  return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
}

/** ファイル名から拡張子 .json を除いたもの。 */
function stemOf(fileName: string): string {
  return fileName.replace(/\.json$/i, '');
}
