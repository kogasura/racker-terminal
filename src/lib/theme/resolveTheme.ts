/**
 * テーマのカタログ（組み込み + ユーザー）の構築、ID の解決、xterm の配色への変換。
 *
 * @module theme/resolveTheme
 */

import type { ITheme } from '@xterm/xterm';
import { BUILTIN_THEMES, TOKYO_NIGHT } from './builtinThemes';
import type { ThemeDefinition } from './types';

/** 選択肢の一覧。組み込みが先、ユーザーのテーマが後。 */
export function buildCatalog(userThemes: ThemeDefinition[]): ThemeDefinition[] {
  return [...BUILTIN_THEMES, ...userThemes];
}

/**
 * ID からテーマを引く。見つからない（ファイルを消した・未指定など）ときは Tokyo Night。
 * 設定値そのものは書き換えない（ファイルを戻せば元のテーマに戻る）ので、ここでは表示用に返すだけ。
 */
export function resolveTheme(
  catalog: readonly ThemeDefinition[],
  id: string | undefined,
): ThemeDefinition {
  return catalog.find((theme) => theme.id === id) ?? TOKYO_NIGHT;
}

/**
 * xterm の theme オプションに変換する。
 * background は含めない。透明度を反映した背景は terminalRegistry の computeBackground が作る。
 */
export function toXtermTheme(theme: ThemeDefinition): ITheme {
  const { background: _background, ...rest } = theme.terminal;
  return { ...rest };
}
