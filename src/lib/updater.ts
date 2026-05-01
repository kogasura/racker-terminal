import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

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
 * Update._handle.install() を呼んでから relaunch() する。
 */
export async function installAndRelaunch(
  update: UpdateAvailable,
): Promise<void> {
  await update._handle.install();
  await relaunch();
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}
