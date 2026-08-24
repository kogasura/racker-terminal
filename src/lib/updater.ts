import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import type { UpdateInstallFailure } from '../types';

export interface UpdateAvailable {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
  /** 内部用。store には入れない */
  _handle: Update;
}

export interface DownloadProgress {
  /** 0..1。contentLength 不明時は undefined */
  ratio: number | undefined;
  downloaded: number;
  contentLength?: number;
}

export async function checkForUpdate(): Promise<UpdateAvailable | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      // update.body は string | undefined (型定義確認済み) → ?? '' で空文字列にフォールバック
      notes: update.body ?? '',
      date: update.date,
      _handle: update,
    };
  } catch (e) {
    // Tauri 環境外 (vite dev) やネットワーク不通の場合は null を返してフォールバック
    console.warn('[updater] checkForUpdate failed:', e);
    return null;
  }
}

/**
 * ダウンロードのみ実行する。完了したら resolve する。
 * Update._handle.download() を使用し、インストールは行わない。
 */
export async function downloadUpdate(
  update: UpdateAvailable,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let contentLength: number | undefined;

  // event.event が discriminator (DownloadEvent 型定義確認済み)
  await update._handle.download((event) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength;
        downloaded = 0;
        onProgress({
          ratio: contentLength ? 0 : undefined,
          downloaded,
          contentLength,
        });
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress({
          ratio: contentLength ? downloaded / contentLength : undefined,
          downloaded,
          contentLength,
        });
        break;
      case 'Finished':
        onProgress({ ratio: 1, downloaded, contentLength });
        break;
    }
  });
}

/**
 * インストールして再起動する。downloadUpdate() 完了後に呼ぶ。
 *
 * Windows では `install()` が返ってこない。updater プラグインはインストーラを
 * `ShellExecuteW` で起動した直後に `std::process::exit(0)` するので、そこで
 * プロセスごと終わる。あとはインストーラが `/R` でアプリを起動し直す。
 * 続く `relaunch()` は Windows 以外のための保険。
 */
export async function installAndRelaunch(
  update: UpdateAvailable,
): Promise<void> {
  // インストーラは racker の子プロセスとして起動するため、何もしなければ
  // racker の Job Object (KILL_ON_JOB_CLOSE) に自動編入され、直後の exit(0) で
  // **起動した瞬間に道連れで殺される**。job.rs 参照。
  // 起動前に Job から抜けられるようにしておく。
  const brokeAway = await invoke<boolean>('allow_process_breakaway').catch((e: unknown) => {
    // 失敗しても更新自体は試す (Job を使えていない環境なら元から問題にならない)
    console.warn('[updater] allow_process_breakaway failed:', e);
    return false;
  });

  // 「適用を試みた」ことを残す。次の起動でバージョンが変わっていなければ、
  // 無言で失敗したと判断してユーザーに知らせる。
  recordUpdateAttempt(update.version);

  try {
    await update._handle.install();
  } catch (e) {
    // インストーラを起動できずアプリが生き残った。緩めた Job を締め直さないと、
    // 以降に開いたタブのシェルが孤児になりうる。
    clearUpdateAttempt();
    if (brokeAway) {
      await invoke('restore_process_confinement').catch((err: unknown) => {
        console.warn('[updater] restore_process_confinement failed:', err);
      });
    }
    throw e;
  }
  await relaunch();
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}

// --- 更新が反映されなかったことの検知 ---
//
// Windows では install() が失敗してもアプリ側には何も返らない (プロセスが
// exit(0) で消えるだけ)。実際、Job Object の道連れでインストーラが即死し、
// v1.9.2 のまま「再起動しても更新されない」状態が誰にも気付かれず続いた。
// 適用を試みたバージョンを残しておき、起動時に実際のバージョンと突き合わせる。

/** 適用を試みたバージョンの保存先 (localStorage)。 */
const UPDATE_ATTEMPT_KEY = 'racker.update.attempt';

/** 適用を試みたことを記録する。 */
export function recordUpdateAttempt(version: string): void {
  try {
    localStorage.setItem(UPDATE_ATTEMPT_KEY, version);
  } catch (e) {
    // localStorage が使えなくても更新自体は進めてよい (検知が効かなくなるだけ)
    console.warn('[updater] recordUpdateAttempt failed:', e);
  }
}

/** 記録を消す。 */
export function clearUpdateAttempt(): void {
  try {
    localStorage.removeItem(UPDATE_ATTEMPT_KEY);
  } catch (e) {
    console.warn('[updater] clearUpdateAttempt failed:', e);
  }
}

/**
 * 前回の更新適用が反映されたかを判定する。記録は読んだ時点で消す (通知は 1 度きり)。
 *
 * - 記録がない / バージョンが一致した (= 適用できた) → `null`
 * - バージョンが変わっていない → 失敗として情報を返す
 *
 * 現在バージョンを取れないとき (Tauri 環境外) も `null`。誤検知して驚かせるより黙る。
 */
export async function takeFailedUpdateAttempt(): Promise<UpdateInstallFailure | null> {
  let attempted: string | null = null;
  try {
    attempted = localStorage.getItem(UPDATE_ATTEMPT_KEY);
  } catch (e) {
    console.warn('[updater] takeFailedUpdateAttempt failed:', e);
    return null;
  }
  if (!attempted) return null;
  clearUpdateAttempt();

  let currentVersion: string;
  try {
    currentVersion = await getVersion();
  } catch (e) {
    console.warn('[updater] getVersion failed:', e);
    return null;
  }

  if (currentVersion === attempted) return null;
  return { version: attempted, currentVersion };
}
