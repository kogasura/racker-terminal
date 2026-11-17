/**
 * 最後に当てたテーマの CSS 変数を localStorage に覚えておき、起動時に描画前に当て直す。
 *
 * テーマの適用は React の描画後（ThemeRoot）で、自作テーマはさらに themes フォルダの
 * 読み込みを待つ。何もしないと、起動のたびに variables.css の初期値 (Tokyo Night) が
 * 一瞬見えてから切り替わる。main.tsx で描画前に applyCachedThemeVars() を呼んで防ぐ。
 *
 * 枠の色だけでなく、ターミナルの配色も自作テーマを引けないと Tokyo Night で描かれる。
 * そのため、読み込んだ自作テーマの定義も覚えておき、起動直後のカタログに入れる
 * （saveUserThemesCache / loadCachedUserThemes）。自作の背景は、使っているテーマのものだけ
 * SVG の中身も覚えておく（合計 1 MiB まで）。
 *
 * 窓に当てたテーマの ID も覚えておく（loadCachedWindowThemeId）。設定の復元を待たずに、
 * 初回の描画から背景を出すため。組み込みのシーンは ID からすぐ描ける。
 *
 * localStorage が使えない・中身が壊れている場合は何もしない（初期値のまま描画する）。
 */

import { parseThemeFile } from '../../lib/theme/parseTheme';
import type { ThemeDefinition } from '../../lib/theme/types';

/** localStorage のキー。 */
export const THEME_CACHE_KEY = 'racker-theme-cache';

/** 窓に当てたテーマの ID を覚えておく localStorage のキー。 */
export const WINDOW_THEME_CACHE_KEY = 'racker-window-theme-cache';

/** 読み込んだ自作テーマの定義を覚えておく localStorage のキー。 */
export const USER_THEMES_CACHE_KEY = 'racker-user-themes-cache';

/** キャッシュから取り出す自作テーマの上限。themes フォルダで読むファイル数の上限と同じ。 */
const MAX_CACHED_THEMES = 100;

/** キャッシュに入れる背景の SVG の上限（バイト）。themes フォルダで読む SVG の上限と同じ。 */
export const MAX_CACHED_SVG_BYTES = 256 * 1024;

/**
 * キャッシュに入れる背景の SVG の合計の上限（バイト）。localStorage は 1 オリジンで数 MiB
 * しか無く、ほかの保存（設定・タブ）と分け合うので、SVG はこの合計までにする。
 */
export const MAX_CACHED_SVG_TOTAL_BYTES = 1024 * 1024;

/** テーマ ID の上限（文字数）。壊れた値で長い文字列を抱えない。 */
const MAX_THEME_ID_LENGTH = 256;

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

/**
 * 当てた CSS 変数一式と、窓に当てたテーマの ID を保存する。
 * 失敗しても無視する（次回の起動でちらつくだけ）。
 */
export function saveThemeCache(vars: Record<string, string>, windowThemeId?: string): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(vars));
    if (windowThemeId !== undefined) localStorage.setItem(WINDOW_THEME_CACHE_KEY, windowThemeId);
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
 * 前回、窓に当てたテーマの ID。無い・使えなければ null。
 * ThemeRoot が、設定の復元や themes フォルダの読み込みを待たずに背景を出すのに使う。
 */
export function loadCachedWindowThemeId(): string | null {
  try {
    const id = localStorage.getItem(WINDOW_THEME_CACHE_KEY);
    if (id === null || id === '' || id.length > MAX_THEME_ID_LENGTH) return null;
    return id;
  } catch (e) {
    console.warn('[theme] window theme cache load failed:', e);
    return null;
  }
}

/** SVG のバイト数（UTF-8）。 */
function svgBytes(svg: string): number {
  return new TextEncoder().encode(svg).length;
}

/** キャッシュの 1 件。テーマファイルと同じ形 + ID + 背景の SVG の中身。 */
interface CachedUserTheme {
  id: string;
  name: string;
  appearance: ThemeDefinition['appearance'];
  ui: ThemeDefinition['ui'];
  terminal: ThemeDefinition['terminal'];
  backdrop?: { svg: string; glass: NonNullable<ThemeDefinition['glass']> };
  /** backdrop.svg のファイルの中身 */
  backdropSvg?: string;
}

/**
 * テーマをキャッシュの 1 件にする。
 * withSvg が true のときだけ背景の SVG も入れる。false のときは背景を外して配色だけを
 * 覚える（読み込みが終われば背景付きに戻る）。
 */
function toCacheEntry(theme: ThemeDefinition, withSvg: boolean): CachedUserTheme {
  const { id, name, appearance, ui, terminal, backdrop, glass } = theme;
  const entry: CachedUserTheme = { id, name, appearance, ui, terminal };
  if (withSvg && backdrop?.kind === 'user' && glass !== undefined) {
    entry.backdrop = { svg: backdrop.fileName, glass };
    entry.backdropSvg = backdrop.svg;
  }
  return entry;
}

/**
 * 背景の SVG もキャッシュに入れるテーマの ID。
 *
 * 使っているテーマ (usedThemeIds) の自作の背景だけを、usedThemeIds の順に入れていく。
 * 1 つの SVG が MAX_CACHED_SVG_BYTES を超えるもの、合計が MAX_CACHED_SVG_TOTAL_BYTES を
 * 超えてしまうものは入れない（配色だけを覚える）。
 */
function themesWithCachedSvg(
  themes: readonly ThemeDefinition[],
  usedThemeIds: readonly string[],
): Set<string> {
  const withSvg = new Set<string>();
  let total = 0;
  for (const id of usedThemeIds) {
    if (withSvg.has(id)) continue;
    const backdrop = themes.find((theme) => theme.id === id)?.backdrop;
    if (backdrop?.kind !== 'user') continue;
    const bytes = svgBytes(backdrop.svg);
    if (bytes > MAX_CACHED_SVG_BYTES || total + bytes > MAX_CACHED_SVG_TOTAL_BYTES) continue;
    total += bytes;
    withSvg.add(id);
  }
  return withSvg;
}

/**
 * 読み込んだ自作テーマの定義を保存する。失敗しても無視する（次回の起動でちらつくだけ）。
 *
 * テーマファイルと同じ形 (name / appearance / ui / terminal / backdrop) で保存し、取り出すときに
 * parseThemeFile で検証し直す。壊れた値をそのままカタログに入れないため。
 * 背景の SVG は使っているテーマのものだけを、合計の上限まで入れる（themesWithCachedSvg）。
 * 使っていないテーマの背景は、次の起動直後は配色だけになり、themes フォルダを読み終えると
 * 背景付きに戻る。それでも容量を超える場合は、SVG を外して配色だけを保存し直す。
 * @param themes - 読み込んだ自作テーマ
 * @param usedThemeIds - 使っているテーマの ID（アプリの設定のテーマ・各タブの上書き）。
 *   先に並べたものから SVG を入れる
 */
export function saveUserThemesCache(
  themes: readonly ThemeDefinition[],
  usedThemeIds: readonly string[],
): void {
  const withSvg = themesWithCachedSvg(themes, usedThemeIds);
  const save = (includeSvg: boolean) =>
    localStorage.setItem(
      USER_THEMES_CACHE_KEY,
      JSON.stringify(themes.map((theme) => toCacheEntry(theme, includeSvg && withSvg.has(theme.id)))),
    );
  try {
    save(true);
  } catch (e) {
    console.warn('[theme] user themes cache save failed, retrying without backdrops:', e);
    try {
      save(false);
    } catch (e2) {
      console.warn('[theme] user themes cache save failed:', e2);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * キャッシュの 1 件から、parseThemeFile に渡す SVG の対応表を作る。
 * 背景の SVG は、テーマファイルが参照する名前 (backdrop.svg) の中身として渡す。
 */
function cachedSvgFiles(backdrop: unknown, backdropSvg: unknown): Record<string, string> {
  if (!isPlainObject(backdrop) || typeof backdropSvg !== 'string') return {};
  const svgName = backdrop.svg;
  if (typeof svgName !== 'string' || svgBytes(backdropSvg) > MAX_CACHED_SVG_BYTES) return {};
  return { [svgName]: backdropSvg };
}

/** キャッシュの 1 件を検証してテーマに戻す。使えなければ null。 */
function restoreUserTheme(entry: unknown): ThemeDefinition | null {
  if (!isPlainObject(entry)) return null;
  const { id, backdropSvg, ...file } = entry;
  if (typeof id !== 'string' || !id.startsWith(USER_THEME_ID_PREFIX)) return null;
  // ID は `user:<stem>`。stem をファイル名に戻して検証すると、同じ ID が作り直される。
  const fileName = `${id.slice(USER_THEME_ID_PREFIX.length)}.json`;
  const svgFiles = cachedSvgFiles(file.backdrop, backdropSvg);
  const result = parseThemeFile(fileName, JSON.stringify(file), svgFiles);
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
