/**
 * 状態 → View モデルの射影と、どのテーマを当てるかの判断。純関数。
 *
 * 設定ダイアログ・お気に入りダイアログの選択肢、ThemeRoot が画面の枠に当てるテーマ、
 * 各タブのターミナルに当てるテーマは、すべてここで決める。
 */

import { buildCatalog, resolveTheme } from '../../lib/theme/resolveTheme';
import type { ThemeDefinition, ThemeSource } from '../../lib/theme/types';
import type { ThemeFileError } from './events';
import type { ThemeState } from './machine';

/** select に並べる選択肢 1 件。 */
export interface ThemeOption {
  readonly id: string;
  readonly name: string;
  readonly source: ThemeSource;
}

export interface ThemeViewModel {
  /** 選択肢。組み込みが先、ユーザーのテーマが後 */
  readonly options: ThemeOption[];
  /** 読み込めなかったテーマファイル（ファイル名と理由） */
  readonly errors: ThemeFileError[];
  /** ユーザーのテーマをまだ読み込み中か（起動直後・再読み込み中） */
  readonly loading: boolean;
  /** テーマの定義一覧。ID からテーマを引くのに使う */
  readonly catalog: ThemeDefinition[];
}

export function selectThemeView(state: ThemeState): ThemeViewModel {
  // idle でもキャッシュ済みのテーマはカタログに入れる (起動直後のちらつき対策)
  const catalog = buildCatalog([...state.themes]);
  return {
    options: catalog.map(({ id, name, source }) => ({ id, name, source })),
    errors: state.status === 'idle' ? [] : [...state.errors],
    loading: state.status !== 'loaded',
    catalog,
  };
}

/**
 * 画面の枠に当てるテーマ。
 *
 * 読み込みが終わる前に、選んでいる ID がカタログに無ければ null（＝まだ当てない）。
 * 起動直後は自作テーマがまだ読めていないだけなので、ここで Tokyo Night に
 * フォールバックすると、起動時のキャッシュで当てた色が一瞬 Tokyo Night に戻ってしまう。
 * 読み込み後も見つからなければ、そのときは Tokyo Night にフォールバックする。
 */
export function selectAppTheme(view: ThemeViewModel, themeId: string): ThemeDefinition | null {
  if (view.loading && !view.catalog.some((theme) => theme.id === themeId)) return null;
  return resolveTheme(view.catalog, themeId);
}

/**
 * タブのターミナルに当てるテーマ。
 * タブの上書き (themeId) がカタログにあればそれ。無い (未指定・ファイルを消した) ときは
 * アプリの設定のテーマに従い、それも見つからなければ Tokyo Night。
 */
export function resolveTabTheme(
  catalog: readonly ThemeDefinition[],
  tabThemeId: string | undefined,
  appThemeId: string,
): ThemeDefinition {
  const override = catalog.find((theme) => theme.id === tabThemeId);
  return override ?? resolveTheme(catalog, appThemeId);
}

/**
 * 開いている各ターミナルに当てるテーマを決める。
 * runtime はあるのにタブが無い (閉じている途中など) ときは、アプリの設定のテーマにする。
 * @param entries - tabId と runtime の組 (terminalRegistry の getAllRuntimeEntries)
 * @param tabs - いまのタブ。tabId で引き、上書き (themeId) を見る
 */
export function resolveRuntimeThemes<R>(
  entries: readonly (readonly [string, R])[],
  tabs: Readonly<Record<string, { readonly themeId?: string } | undefined>>,
  catalog: readonly ThemeDefinition[],
  appThemeId: string,
): [R, ThemeDefinition][] {
  return entries.map(([tabId, runtime]) => [
    runtime,
    resolveTabTheme(catalog, tabs[tabId]?.themeId, appThemeId),
  ]);
}
