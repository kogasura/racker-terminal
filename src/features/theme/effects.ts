/**
 * Mediator が要求した副作用を実行する層。ここだけが I/O を持つ。
 *
 * - load: themes フォルダの *.json を読み、parseThemeFile で検証して
 *   使えるテーマと読めなかったファイルに分ける
 * - open-folder: themes フォルダを Explorer で開く
 * - create-with-claude: themes フォルダを cwd にして claude タブを開く。
 *   フォルダには形式の説明書 (CLAUDE.md) が置かれるので、claude はそれを読んでテーマを作れる
 */

import { buildQuickAccessLaunch } from '../../lib/quickAccess';
import { parseThemeFile } from '../../lib/theme/parseTheme';
import type { ThemeDefinition } from '../../lib/theme/types';
import {
  ensureThemesDir,
  listUserThemes,
  openThemesDir,
  type UserThemeFile,
} from '../../lib/themeFiles';
import { useAppStore } from '../../store/appStore';
import type { ThemeEvent, ThemeFileError } from './events';
import type { ThemeEffect } from './machine';

export interface EffectDeps {
  listUserThemes: typeof listUserThemes;
  ensureThemesDir: typeof ensureThemesDir;
  openThemesDir: typeof openThemesDir;
  /** 指定フォルダを cwd にした claude タブを開く。 */
  openClaudeTab: (path: string) => void;
}

/** themes フォルダで claude を開く。クイックアクセスと同じ開き方にする。テスト用に export する。 */
export function openClaudeTab(path: string): void {
  useAppStore.getState().createTab(undefined, buildQuickAccessLaunch({ name: 'themes', path }));
}

const defaultDeps: EffectDeps = { listUserThemes, ensureThemesDir, openThemesDir, openClaudeTab };

/**
 * 読み込んだファイルを検証し、使えるテーマとエラーに分ける純関数。
 * Rust 側で読めなかったもの（大きすぎる・読み取りエラー）はそのまま errors へ。
 */
export function partitionThemeFiles(files: readonly UserThemeFile[]): {
  themes: ThemeDefinition[];
  errors: ThemeFileError[];
} {
  const themes: ThemeDefinition[] = [];
  const errors: ThemeFileError[] = [];
  for (const file of files) {
    if (file.error !== null || file.content === null) {
      errors.push({ fileName: file.fileName, error: file.error ?? 'ファイルを読めませんでした' });
      continue;
    }
    const result = parseThemeFile(file.fileName, file.content);
    if (result.ok) themes.push(result.theme);
    else errors.push({ fileName: result.fileName, error: result.error });
  }
  return { themes, errors };
}

/** 副作用の実行係を作る。テストでは `deps` を差し替える。 */
export function createEffectRunner(deps: EffectDeps = defaultDeps) {
  return function run(effect: ThemeEffect, send: (event: ThemeEvent) => void): void {
    switch (effect.kind) {
      case 'load':
        void (async () => {
          const files = await deps.listUserThemes();
          send({ type: 'theme/loaded', ...partitionThemeFiles(files) });
        })();
        return;

      case 'open-folder':
        void deps.openThemesDir();
        return;

      case 'create-with-claude':
        void (async () => {
          const path = await deps.ensureThemesDir();
          // フォルダを用意できなければ開く先が無い。失敗は themeFiles 側でログ済み。
          if (path === null) return;
          deps.openClaudeTab(path);
        })();
        return;

      default: {
        const exhaustive: never = effect;
        void exhaustive;
      }
    }
  };
}
