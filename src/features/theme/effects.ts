/**
 * Mediator が要求した副作用を実行する層。ここだけが I/O を持つ。
 *
 * - load: themes フォルダの *.json と *.svg を読み、*.json を parseThemeFile で検証して
 *   使えるテーマと読めなかったファイルに分ける。*.svg は背景の中身として JSON から参照される
 * - open-folder: themes フォルダを Explorer で開く
 * - create-with-claude: themes フォルダを cwd にして claude タブを開く。
 *   フォルダには形式の説明書 (CLAUDE.md) が置かれるので、claude はそれを読んでテーマを作れる
 */

import { buildQuickAccessLaunch } from '../../lib/quickAccess';
import { extractSvgRoot } from '../../lib/theme/backdropDocument';
import { MAX_THEME_FILES, parseThemeFile } from '../../lib/theme/parseTheme';
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

/** 背景の SVG のファイルか（拡張子で見分ける。Windows のファイル名なので大小は問わない）。 */
function isSvgFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.svg');
}

/** *.svg を読み分けた結果。 */
interface SvgFiles {
  /** SVG として読めたもの。ファイル名 → ルートの `<svg>` 要素だけの文字列 */
  readonly readable: Record<string, string>;
  /** フォルダにあるが読めなかったもののファイル名 */
  readonly unreadable: Set<string>;
  /** 読めなかった理由。ファイル名 → 理由（Rust 側で読めなかったものは入れない） */
  readonly invalid: Map<string, string>;
}

/**
 * *.svg を、SVG として読めたものと読めなかったものに分ける。
 * 読めたものは extractSvgRoot でルートの `<svg>` 要素だけにしておく（外側に書かれたものを
 * テーマに持ち込まない）。
 */
function collectSvgFiles(files: readonly UserThemeFile[]): SvgFiles {
  const readable: Record<string, string> = {};
  const unreadable = new Set<string>();
  const invalid = new Map<string, string>();
  for (const file of files) {
    if (!isSvgFile(file.fileName)) continue;
    if (file.content === null || file.error !== null) {
      unreadable.add(file.fileName);
      continue;
    }
    const root = extractSvgRoot(file.content);
    if (root.ok) {
      readable[file.fileName] = root.svg;
    } else {
      unreadable.add(file.fileName);
      invalid.set(file.fileName, root.error);
    }
  }
  return { readable, unreadable, invalid };
}

/**
 * 読み込んだファイルを検証し、使えるテーマとエラーに分ける純関数。
 *
 * - Rust 側で読めなかったもの（大きすぎる・読み取りエラー）はそのまま errors へ。
 * - *.svg はテーマではなく背景の中身。SVG として読めないもの（整形式でない・ルートが svg で
 *   ない）は errors へ。読めたものはファイル名 → 中身の対応表にして parseThemeFile に渡し、
 *   JSON の `backdrop.svg` から引けるようにする（どの JSON からも参照されない SVG は使わない）。
 *   読めなかった SVG の名前も渡し、参照した JSON のエラー文を出し分ける。
 * - エラーはファイルの並び順のまま返す。
 */
export function partitionThemeFiles(files: readonly UserThemeFile[]): {
  themes: ThemeDefinition[];
  errors: ThemeFileError[];
} {
  const svgFiles = collectSvgFiles(files);
  const hints = { unreadable: svgFiles.unreadable, truncated: files.length >= MAX_THEME_FILES };
  const themes: ThemeDefinition[] = [];
  const errors: ThemeFileError[] = [];
  for (const file of files) {
    if (file.error !== null || file.content === null) {
      errors.push({ fileName: file.fileName, error: file.error ?? 'ファイルを読めませんでした' });
      continue;
    }
    if (isSvgFile(file.fileName)) {
      const error = svgFiles.invalid.get(file.fileName);
      if (error !== undefined) errors.push({ fileName: file.fileName, error });
      continue;
    }
    const result = parseThemeFile(file.fileName, file.content, svgFiles.readable, hints);
    if (result.ok) themes.push(result.theme);
    else errors.push({ fileName: result.fileName, error: result.error });
  }
  return { themes, errors };
}

/**
 * themes フォルダを読んで検証する。失敗しても投げずに、理由を errors に入れて返す。
 * 投げると `theme/loaded` が届かず、Mediator が loading のまま止まってしまうため。
 */
async function loadThemes(deps: EffectDeps): Promise<{
  themes: ThemeDefinition[];
  errors: ThemeFileError[];
}> {
  try {
    return partitionThemeFiles(await deps.listUserThemes());
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      themes: [],
      errors: [{ fileName: 'themes', error: `テーマを読み込めませんでした: ${detail}` }],
    };
  }
}

/** 副作用の実行係を作る。テストでは `deps` を差し替える。 */
export function createEffectRunner(deps: EffectDeps = defaultDeps) {
  return function run(effect: ThemeEffect, send: (event: ThemeEvent) => void): void {
    switch (effect.kind) {
      case 'load':
        void (async () => {
          send({ type: 'theme/loaded', ...(await loadThemes(deps)) });
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
