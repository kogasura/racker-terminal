import { invoke } from '@tauri-apps/api/core';

/**
 * タブの作業ディレクトリに対応する GitHub PR の状態。
 *
 * Claude Code on the web はセッションに紐づく PR の作成・マージ状況を追跡している。
 * racker はローカルアプリなので、同じことを **作業ディレクトリのブランチから引く**形で行う。
 * 「いま Claude に作らせた PR がマージされたか」がタブを見るだけで分かる。
 */

/** Rust の `get_pr_status` が返す情報。 */
export interface PrInfo {
  /** 現在のブランチ名。PR が無くてもこれは入る */
  branch: string;
  number?: number;
  /** 'OPEN' | 'MERGED' | 'CLOSED' */
  state?: string;
  url?: string;
  isDraft?: boolean;
}

/** バッジの見た目を決める区分。 */
export type PrBadgeKind = 'draft' | 'open' | 'merged' | 'closed';

/** `state` 文字列 → バッジ区分。未知の値は対応表に無いので null になる。 */
const STATE_TO_KIND: Record<string, PrBadgeKind> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
};

/**
 * PR の状態からバッジの区分を決める。
 *
 * draft は state が `OPEN` のまま `isDraft` が立つので、open より先に判定する。
 * PR 番号が無い（ブランチはあるが PR 未作成）場合は null を返し、何も表示しない。
 */
export function prBadgeKind(pr: PrInfo | null | undefined): PrBadgeKind | null {
  if (pr?.number === undefined) return null;
  if (pr.isDraft === true && pr.state === 'OPEN') return 'draft';
  return STATE_TO_KIND[pr.state ?? ''] ?? null;
}

/** バッジの tooltip 文言。ブランチ名まで出して、どのブランチの PR か分かるようにする。 */
export function prTooltip(pr: PrInfo): string {
  const kind = prBadgeKind(pr);
  const label =
    kind === 'draft' ? '下書き'
    : kind === 'open' ? 'オープン'
    : kind === 'merged' ? 'マージ済み'
    : kind === 'closed' ? 'クローズ'
    : '';
  return `PR #${pr.number} (${label}) — ${pr.branch}`;
}

/**
 * WSL タブなど、Windows の git から辿れない作業ディレクトリを除外する。
 *
 * WSL タブの cwd は Linux パス (`/home/...`) で、Windows 側の `git` では扱えない。
 * ドライブレター始まり (`C:\...` / `C:/...`) のときだけ対象にする。
 */
export function isWindowsPath(cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  return /^[A-Za-z]:[\\/]/.test(cwd.trim());
}

/**
 * 作業ディレクトリごとにタブをまとめる。
 *
 * 同じリポジトリを複数タブで開いていることは多いので、cwd 単位で 1 回だけ
 * `git` / `gh` を叩けば済むようにする（`gh` はネットワークを伴うため回数を抑えたい）。
 */
export function groupTabsByCwd(
  tabs: { id: string; cwd?: string }[],
): Map<string, string[]> {
  const byCwd = new Map<string, string[]>();
  for (const tab of tabs) {
    if (!isWindowsPath(tab.cwd)) continue;
    const key = tab.cwd as string;
    const list = byCwd.get(key);
    if (list === undefined) byCwd.set(key, [tab.id]);
    else list.push(tab.id);
  }
  return byCwd;
}

/**
 * この tick で PR 状態を引くべきかを決める純関数。
 *
 * PR バッジは**見た目だけの情報**で、通知には使わない。ウィンドウを見ていない
 * 間に更新しても誰も気付かず、`git` と `gh` のプロセス起動とネットワーク往復
 * だけが残る。実測では 90 秒あたり git 2 回 + gh 3 回が走っていた。
 * ノート PC では、その都度ネットワークを起こすのは無視できない。
 *
 * そこでウィンドウが前面にある間だけ引く。裏に回っている間は止め、
 * 戻ってきた時点で引き直すので、見るときには最新になっている。
 *
 * @param isFocused - ウィンドウが前面にあるか
 * @param hasEverPolled - 一度でも取得したことがあるか
 *
 * 起動直後はフォーカスが確定していないことがあるため、未取得のうちは
 * フォーカス状態によらず 1 回は引く（初回のバッジが出ないのを防ぐ）。
 */
export function shouldPollPr(isFocused: boolean, hasEverPolled: boolean): boolean {
  if (!hasEverPolled) return true;
  return isFocused;
}

/**
 * 作業ディレクトリの PR 状態を取得する。
 *
 * `git` や `gh` が無い環境、未認証、リポジトリでない場合はすべて null を返す。
 * PR 追跡は「あると嬉しい」機能なので、失敗しても何も表示しないだけにする。
 */
export async function getPrStatus(cwd: string): Promise<PrInfo | null> {
  try {
    return await invoke<PrInfo | null>('get_pr_status', { cwd });
  } catch (e) {
    console.warn('[prStatus] get_pr_status failed:', e);
    return null;
  }
}
