/**
 * 「フォルダを選んで開く」機能の純ロジック。
 *
 * ネイティブのフォルダ選択ダイアログ（Windows のエクスプローラー UI）で選んだ
 * Windows パスと、選択したシェルのテンプレート（Nushell / PowerShell / cmd /
 * Git Bash / WSL:<distro>）から、新しいタブを spawn するための設定を組み立てる。
 *
 * WSL の場合は、選択した Windows パスを `wsl.exe --cd <Windowsパス>` に渡す。
 * wsl.exe は絶対 Windows パスを受け取ると自動で Linux パスに変換して着地するため、
 * `/mnt/c/...` への手動変換は行わない（automount 設定が既定でない環境でも正しく着地する）。
 *
 * @module openFolder
 */

import type { ProfileTemplate } from './profileTemplates';
import { isWslShell, buildWslArgs, parseWslArgs } from './profileTemplates';

/** buildFolderLaunch が返す、createTab へ渡すためのタブ設定。 */
export interface FolderLaunch {
  /** 未指定 (undefined) の場合は Rust 側デフォルト (nushell) を使う。 */
  shell?: string;
  /** Windows ネイティブシェルのときのみ設定。WSL は --cd で着地するため undefined。 */
  cwd?: string;
  /** shell 起動引数（WSL は `-d <distro> --cd <path>`）。 */
  args?: string[];
  /** タブ表示名（選んだフォルダ名）。 */
  title: string;
}

/**
 * パス末尾のフォルダ名を返す純関数（Windows `\` / POSIX `/` 両対応）。
 * ドライブ直下（例: `C:\`）や取得できない場合は 'Terminal' にフォールバックする。
 */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0 && p !== '~');
  const last = parts[parts.length - 1];
  if (!last || /^[A-Za-z]:$/.test(last)) return 'Terminal';
  return last;
}

/**
 * 選択したシェルテンプレートと Windows パスから、新規タブの spawn 設定を組み立てる。
 *
 * - `template` が null（＝既定 Nushell）→ shell 未指定・cwd に選択パス。
 * - WSL テンプレート → `-d <distro> --cd <選択パス(Windows パス)>` を組み立てる。
 * - その他 Windows ネイティブシェル → template.shell / template.args を引き継ぎ cwd に選択パス。
 *
 * @param template 選択したシェルのテンプレート（null = 既定 Nushell）
 * @param winPath  フォルダ選択ダイアログで選んだ Windows パス
 */
export function buildFolderLaunch(
  template: ProfileTemplate | null,
  winPath: string,
): FolderLaunch {
  const title = folderName(winPath);

  // WSL: 選択した Windows パスを --cd に渡す（wsl.exe が Linux パスへ自動変換）。
  if (template && isWslShell(template.shell)) {
    const { distro } = parseWslArgs(template.args);
    return {
      shell: template.shell,
      args: buildWslArgs(distro, winPath),
      cwd: undefined,
      title,
    };
  }

  // Windows ネイティブシェル / 既定 Nushell
  return {
    shell: template?.shell, // null → undefined = Rust 側の nushell 既定
    args: template?.args ? [...template.args] : undefined,
    cwd: winPath,
    title,
  };
}
