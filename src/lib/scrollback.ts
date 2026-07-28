import { invoke } from '@tauri-apps/api/core';

/**
 * タブの画面内容を保存・復元する。
 *
 * PTY のスクロールバックはプロセスと一蓮托生で、アプリを再起動すると失われる。
 * 「タブは戻るが中身は空」を避けるため、xterm でシリアライズした画面内容を
 * ファイルへ保存しておき、復元時に書き戻す。
 *
 * 保存先が localStorage ではなくファイルなのは、localStorage の容量制限
 * (5〜10MB) を超えるとタブ構成やお気に入りの永続化まで巻き添えで失敗するため。
 */

/**
 * 保存する scrollback の行数。
 *
 * 目的は「直前の作業が見えること」であり、履歴全部を残す必要はない。
 * 行数を絞ることで保存サイズとシリアライズのコストを抑える。
 */
export const SAVE_SCROLLBACK_LINES = 1000;

/**
 * 復元した内容と、これから始まる新しいセッションの境目に挟む区切り。
 *
 * 区切りが無いと、復元された過去の出力を「いま動いているプロセスの出力」だと
 * 誤解してしまう。灰色 (90) で目立たせすぎず、しかし明確に区切る。
 */
export const RESTORE_BANNER =
  '\r\n\x1b[90m──────── ここまでが前回の内容（プロセスは終了しています） ────────\x1b[0m\r\n\r\n';

/** タブの画面内容を保存する。失敗は無視する（付加機能のため）。 */
export async function saveScrollback(tabId: string, content: string): Promise<void> {
  if (content.length === 0) return;
  try {
    await invoke('save_scrollback', { tabId, content });
  } catch (e) {
    console.warn('[scrollback] save failed:', e);
  }
}

/** 保存された画面内容を読み出す。無ければ null。 */
export async function loadScrollback(tabId: string): Promise<string | null> {
  try {
    return await invoke<string | null>('load_scrollback', { tabId });
  } catch (e) {
    console.warn('[scrollback] load failed:', e);
    return null;
  }
}

/** タブを閉じたときに保存内容を捨てる。 */
export async function deleteScrollback(tabId: string): Promise<void> {
  try {
    await invoke('delete_scrollback', { tabId });
  } catch (e) {
    console.warn('[scrollback] delete failed:', e);
  }
}

/**
 * 現存しないタブの保存ファイルを掃除する。
 * クラッシュ等で削除できなかったぶんが残り続けるため、起動時に一度呼ぶ。
 */
export async function pruneScrollback(keepTabIds: string[]): Promise<void> {
  try {
    await invoke('prune_scrollback', { keepTabIds });
  } catch (e) {
    console.warn('[scrollback] prune failed:', e);
  }
}
