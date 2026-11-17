/**
 * 最後に当てたテーマの CSS 変数を localStorage に覚えておき、起動時に描画前に当て直す。
 *
 * テーマの適用は React の描画後（ThemeRoot）で、自作テーマはさらに themes フォルダの
 * 読み込みを待つ。何もしないと、起動のたびに variables.css の初期値 (Tokyo Night) が
 * 一瞬見えてから切り替わる。main.tsx で描画前に applyCachedThemeVars() を呼んで防ぐ。
 *
 * localStorage が使えない・中身が壊れている場合は何もしない（初期値のまま描画する）。
 */

/** localStorage のキー。 */
export const THEME_CACHE_KEY = 'racker-theme-cache';

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
