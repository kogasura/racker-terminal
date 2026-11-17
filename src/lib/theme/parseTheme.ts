/**
 * ユーザーのテーマファイル（themes フォルダの *.json）を検証し、ベースのテーマとマージする。
 *
 * - 書かれたキーだけ上書きする。書かれていない色は appearance に応じたベース
 *   （dark は Tokyo Night、light は Racker Paper）から補う。
 * - 未知のキー（第 2 段の `effect` など）は無視する。古い版で新しいファイルを読んでも壊れない。
 * - 値が読めないキーが 1 つでもあればファイル全体を無効にし、直せるよう具体的な理由を返す。
 *
 * I/O は持たない純関数。ファイルの読み込みは Rust 側（list_user_themes）が行う。
 *
 * @module theme/parseTheme
 */

import { RACKER_PAPER, TOKYO_NIGHT } from './builtinThemes';
import type { TerminalPalette, ThemeAppearance, ThemeDefinition, UiPalette } from './types';

export type ParseThemeResult =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; fileName: string; error: string };

/** テーマ名の上限（文字数）。設定画面の select に収まる長さ。 */
const NAME_MAX_LENGTH = 40;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

type JsonObject = Record<string, unknown>;

/** 検証に失敗したことを表す。メッセージはそのまま設定画面に出す。 */
class ThemeFileError extends Error {}

/**
 * テーマファイルの中身を検証して ThemeDefinition にする。
 * @param fileName - themes フォルダ内のファイル名（例: `sunset.json`）。ID は `user:<stem>` になる
 * @param content - ファイルの中身（JSON 文字列）
 */
export function parseThemeFile(fileName: string, content: string): ParseThemeResult {
  try {
    return { ok: true, theme: buildTheme(fileName, content) };
  } catch (e) {
    if (e instanceof ThemeFileError) return { ok: false, fileName, error: e.message };
    throw e;
  }
}

function buildTheme(fileName: string, content: string): ThemeDefinition {
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

  return { id: `user:${stemOf(fileName)}`, name, appearance, source: 'user', ui, terminal };
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
    throw new ThemeFileError(`name: ${JSON.stringify(value)} は文字列で書いてください`);
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
    `appearance: ${JSON.stringify(value)} は "dark" か "light" のどちらかにしてください`,
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
      `${path}: ${JSON.stringify(value)} は色として読めません（#rgb か #rrggbb で書いてください）`,
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
