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

/** buildQuickAccessLaunch が返す、createTab へ渡すためのタブ設定。 */
export interface QuickAccessLaunch {
  userTitle: string;
  /** 未指定 (undefined) の場合は Rust 側デフォルト (nushell) を使う。 */
  shell?: string;
  cwd?: string;
  args?: string[];
  launchClaude: true;
}

/**
 * クイックアクセスのフォルダで claude を起動するタブ設定を組み立てる純関数。
 *
 * - WSL のフォルダ → その distro の中で開く (`wsl.exe -d <distro> --cd <Linux パス>`)。
 *   Windows 側のシェルで UNC パスを cwd にすると、claude が Windows 版として動いて
 *   しまい、WSL 側の設定やセッションと噛み合わないため。
 * - それ以外 → 既定のシェルで、そのフォルダを cwd にして開く。
 *
 * 権限バイパスは付けない。任意のフォルダを 1 クリックで開く導線なので、
 * 明示的に設定したお気に入りと同じ扱いにはしない。
 */
export function buildQuickAccessLaunch(folder: QuickAccessFolder): QuickAccessLaunch {
  const wsl = parseWslUncPath(folder.path);
  if (wsl) {
    return {
      userTitle: folder.name,
      shell: 'wsl.exe',
      args: buildWslArgs(wsl.distro, wsl.dir),
      launchClaude: true,
    };
  }
  return { userTitle: folder.name, cwd: folder.path, launchClaude: true };
}
