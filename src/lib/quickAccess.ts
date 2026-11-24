/**
 * エクスプローラーの「クイックアクセス」のフォルダを扱う。
 *
 * 一覧の取得 (Rust 側の `list_quick_access`) と、選んだフォルダで claude を
 * 起動するタブ設定の組み立て (純関数) を置いてある。
 *
 * @module quickAccess
 */

import { invoke } from '@tauri-apps/api/core';
import { buildWslArgs } from './profileTemplates';
import type { QuickAccessFolder } from '../types';

/**
 * クイックアクセスのフォルダ一覧を取得する。
 * 取得に失敗したら空配列を返す (セクションごと出さなければ済むため、エラーにしない)。
 */
export async function listQuickAccess(): Promise<QuickAccessFolder[]> {
  try {
    return (await invoke<QuickAccessFolder[] | null>('list_quick_access')) ?? [];
  } catch (e) {
    console.warn('[quickAccess] list_quick_access failed:', e);
    return [];
  }
}

/** WSL のフォルダを指す UNC パス (`\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...`)。 */
const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)((?:\\.*)?)$/i;

/**
 * WSL の UNC パスを distro と Linux パスに分ける純関数。WSL のパスでなければ null。
 *
 * 例: `\\wsl.localhost\Ubuntu-22.04\home\me\dev` → { distro: 'Ubuntu-22.04', dir: '/home/me/dev' }
 */
export function parseWslUncPath(path: string): { distro: string; dir: string } | null {
  const m = WSL_UNC.exec(path);
  if (!m) return null;
  const dir = m[2].replace(/\\+/g, '/').replace(/\/+$/, '');
  return { distro: m[1], dir: dir === '' ? '/' : dir };
}

/** Windows のパスは大文字小文字を区別しないので、比較はそろえてから行う。 */
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * クイックアクセスのフォルダをクリックしたときに claude を起動するか。
 *
 * 既定は起動する。`shellOnlyPaths`（設定の quickAccessShellOnlyPaths）に
 * 載っているフォルダだけ、シェルだけを開く。
 */
export function isQuickAccessClaude(
  path: string,
  shellOnlyPaths: readonly string[] | undefined,
): boolean {
  return !(shellOnlyPaths ?? []).some((p) => samePath(p, path));
}

/**
 * フォルダの claude 起動を切り替えた後の quickAccessShellOnlyPaths を返す純関数。
 * 載っていれば外し (claude を起動する側へ)、載っていなければ足す (シェルだけ側へ)。
 */
export function toggleQuickAccessClaude(
  shellOnlyPaths: readonly string[] | undefined,
  path: string,
): string[] {
  const current = shellOnlyPaths ?? [];
  if (isQuickAccessClaude(path, current)) return [...current, path];
  return current.filter((p) => !samePath(p, path));
}

/** buildQuickAccessLaunch が返す、createTab へ渡すためのタブ設定。 */
export interface QuickAccessLaunch {
  userTitle: string;
  /** 未指定 (undefined) の場合は Rust 側デフォルト (nushell) を使う。 */
  shell?: string;
  cwd?: string;
  args?: string[];
  launchClaude: boolean;
}

/**
 * クイックアクセスのフォルダを開くタブ設定を組み立てる純関数。
 *
 * - WSL のフォルダ → その distro の中で開く (`wsl.exe -d <distro> --cd <Linux パス>`)。
 *   Windows 側のシェルで UNC パスを cwd にすると、claude が Windows 版として動いて
 *   しまい、WSL 側の設定やセッションと噛み合わないため。claude を起動しない場合も
 *   同じ理由で distro の中に開く（そこで自分で claude を打つことがあるため）。
 * - それ以外 → 既定のシェルで、そのフォルダを cwd にして開く。
 *
 * `launchClaude` が false ならシェルだけを開く（移動してから自分で claude を打つ用途）。
 *
 * 権限バイパスは付けない。任意のフォルダを 1 クリックで開く導線なので、
 * 明示的に設定したお気に入りと同じ扱いにはしない。
 */
export function buildQuickAccessLaunch(
  folder: QuickAccessFolder,
  launchClaude: boolean,
): QuickAccessLaunch {
  const wsl = parseWslUncPath(folder.path);
  if (wsl) {
    return {
      userTitle: folder.name,
      shell: 'wsl.exe',
      args: buildWslArgs(wsl.distro, wsl.dir),
      launchClaude,
    };
  }
  return { userTitle: folder.name, cwd: folder.path, launchClaude };
}
