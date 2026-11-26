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
import type { QuickAccessFolder, Settings } from '../types';

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

function listed(paths: readonly string[] | undefined, path: string): boolean {
  return (paths ?? []).some((p) => samePath(p, path));
}

/** フォルダごとの起動方法を決める設定（どちらもパスの一覧で持つ）。 */
export type QuickAccessSettings = Pick<
  Settings,
  'quickAccessShellOnlyPaths' | 'quickAccessBypassPaths'
>;

/** クイックアクセスのフォルダをクリックしたときの起動方法。 */
export interface QuickAccessMode {
  /** claude を起動するか。 */
  readonly launchClaude: boolean;
  /** 権限バイパスを付けるか。claude を起動しないフォルダでは常に false。 */
  readonly bypass: boolean;
}

/**
 * クイックアクセスのフォルダをクリックしたときの起動方法を返す純関数。
 *
 * - claude は既定で起動する。quickAccessShellOnlyPaths に載っているフォルダだけ、シェルだけを開く。
 * - 権限バイパスは既定で付けない。quickAccessBypassPaths に載っているフォルダだけ付ける
 *   （任意のフォルダを 1 クリックで開く導線なので、緩めるのは明示したフォルダに限る）。
 */
export function quickAccessMode(path: string, settings: QuickAccessSettings): QuickAccessMode {
  const launchClaude = !listed(settings.quickAccessShellOnlyPaths, path);
  return { launchClaude, bypass: launchClaude && listed(settings.quickAccessBypassPaths, path) };
}

/**
 * パスの一覧でフォルダを切り替えた後の一覧を返す純関数
 * （quickAccessShellOnlyPaths / quickAccessBypassPaths の両方に使う）。
 * 載っていれば外し、載っていなければ足す。外すときは大文字小文字の表記ゆれも外す。
 */
export function toggleQuickAccessPath(
  paths: readonly string[] | undefined,
  path: string,
): string[] {
  const current = paths ?? [];
  if (!listed(current, path)) return [...current, path];
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
  /** 権限バイパス。付けないときは undefined（お気に入りのタブと同じ持ち方）。 */
  bypassPermissions?: true;
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
 * `mode.launchClaude` が false ならシェルだけを開く（移動してから自分で claude を打つ用途）。
 * `mode.bypass` が true なら claude を権限バイパス付きで起動する（タブに残るので、
 * 再起動後の再開にも付く）。
 */
export function buildQuickAccessLaunch(
  folder: QuickAccessFolder,
  mode: QuickAccessMode,
): QuickAccessLaunch {
  const claude = {
    launchClaude: mode.launchClaude,
    ...(mode.launchClaude && mode.bypass ? { bypassPermissions: true as const } : {}),
  };
  const wsl = parseWslUncPath(folder.path);
  if (wsl) {
    return {
      userTitle: folder.name,
      shell: 'wsl.exe',
      args: buildWslArgs(wsl.distro, wsl.dir),
      ...claude,
    };
  }
  return { userTitle: folder.name, cwd: folder.path, ...claude };
}
