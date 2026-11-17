/**
 * 最後に当てたテーマの CSS 変数を localStorage に覚えておき、起動時に描画前に当て直す。
 *
 * テーマの適用は React の描画後（ThemeRoot）で、自作テーマはさらに themes フォルダの
 * 読み込みを待つ。何もしないと、起動のたびに variables.css の初期値 (Tokyo Night) が
 * 一瞬見えてから切り替わる。main.tsx で描画前に applyCachedThemeVars() を呼んで防ぐ。
 *
 * 枠の色だけでなく、ターミナルの配色も自作テーマを引けないと Tokyo Night で描かれる。
 * そのため、読み込んだ自作テーマの定義も覚えておき、起動直後のカタログに入れる
 * （saveUserThemesCache / loadCachedUserThemes）。
 *
 * localStorage が使えない・中身が壊れている場合は何もしない（初期値のまま描画する）。
 */

import { parseThemeFile } from '../../lib/theme/parseTheme';
import type { ThemeDefinition } from '../../lib/theme/types';

/** localStorage のキー。 */
export const THEME_CACHE_KEY = 'racker-theme-cache';

/** 読み込んだ自作テーマの定義を覚えておく localStorage のキー。 */
export const USER_THEMES_CACHE_KEY = 'racker-user-themes-cache';

/** キャッシュから取り出す自作テーマの上限。themes フォルダで読むファイル数の上限と同じ。 */
const MAX_CACHED_THEMES = 100;

const USER_THEME_ID_PREFIX = 'user:';

/** CSS のカスタムプロパティ名だけを受け付ける（壊れた値で別のプロパティを触らない）。 */
const CUSTOM_PROPERTY = /^--[a-z0-9-]+$/;

/** CSS 変数一式を documentElement に当てる。 */
export function applyThemeVars(vars: Record<string, string>): void {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(vars)) {
    style.setProperty(name, value);
  }
}

/** 当てた CSS 変数一式を保存する。失敗しても無視する（次回の起動でちらつくだけ）。 */
export function saveThemeCache(vars: Record<string, string>): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(vars));
  } catch (e) {
    console.warn('[theme] cache save failed:', e);
  }
}

/** 保存された中身を検証して取り出す。使えなければ null。 */
function readThemeCache(): Record<string, string> | null {
  const raw = localStorage.getItem(THEME_CACHE_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (CUSTOM_PROPERTY.test(name) && typeof value === 'string') vars[name] = value;
  }
  return vars;
}

/** 前回当てた CSS 変数一式を当て直す。main.tsx で描画前に 1 度だけ呼ぶ。 */
export function applyCachedThemeVars(): void {
  try {
    const vars = readThemeCache();
    if (vars) applyThemeVars(vars);
  } catch (e) {
    console.warn('[theme] cache load failed:', e);
  }
}

/**
 * 読み込んだ自作テーマの定義を保存する。失敗しても無視する（次回の起動でちらつくだけ）。
 *
 * テーマファイルと同じ形 (name / appearance / ui / terminal) で保存し、取り出すときに
 * parseThemeFile で検証し直す。壊れた値をそのままカタログに入れないため。
 */
export function saveUserThemesCache(themes: readonly ThemeDefinition[]): void {
  const entries = themes.map(({ id, name, appearance, ui, terminal }) => ({
    id,
    name,
    appearance,
    ui,
    terminal,
  }));
  try {
    localStorage.setItem(USER_THEMES_CACHE_KEY, JSON.stringify(entries));
  } catch (e) {
    console.warn('[theme] user themes cache save failed:', e);
  }
}

/** キャッシュの 1 件を検証してテーマに戻す。使えなければ null。 */
function restoreUserTheme(entry: unknown): ThemeDefinition | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const { id, ...file } = entry as Record<string, unknown>;
  if (typeof id !== 'string' || !id.startsWith(USER_THEME_ID_PREFIX)) return null;
  // ID は `user:<stem>`。stem をファイル名に戻して検証すると、同じ ID が作り直される。
  const fileName = `${id.slice(USER_THEME_ID_PREFIX.length)}.json`;
  const result = parseThemeFile(fileName, JSON.stringify(file));
  return result.ok && result.theme.id === id ? result.theme : null;
}

/**
 * 前回の起動で読み込んだ自作テーマを取り出す。
 * ThemeRoot が theme machine の初期状態に入れる。無い・壊れていれば空。
 */
export function loadCachedUserThemes(): ThemeDefinition[] {
  try {
    const raw = localStorage.getItem(USER_THEMES_CACHE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, MAX_CACHED_THEMES)
      .map(restoreUserTheme)
      .filter((theme): theme is ThemeDefinition => theme !== null);
  } catch (e) {
    console.warn('[theme] user themes cache load failed:', e);
    return [];
  }
}
