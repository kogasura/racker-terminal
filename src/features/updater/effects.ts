/**
 * Mediator が要求した副作用を実行する層。ここだけが I/O を持つ。
 *
 * Tauri の Update ハンドルは直列化できないうえ、状態として持つ意味もない
 * (描画にも遷移判断にも使わない) ので、state ではなくこの層に閉じ込める。
 * Mediator から見えるのは「install してほしい」という意図だけで、
 * どのハンドルを使うかは知らない。
 */

import {
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  installAndRelaunch,
  type UpdateAvailable,
} from '../../lib/updater';
import type { UpdaterEvent } from './events';
import type { UpdaterEffect } from './machine';

export interface EffectDeps {
  checkForUpdate: typeof checkForUpdate;
  downloadUpdate: typeof downloadUpdate;
  installAndRelaunch: typeof installAndRelaunch;
}

const defaultDeps: EffectDeps = { checkForUpdate, downloadUpdate, installAndRelaunch };

/**
 * 副作用の実行係を作る。
 *
 * 待機中のハンドルはこのクロージャが持つ。テストでは `deps` を差し替える。
 */
export function createEffectRunner(deps: EffectDeps = defaultDeps) {
  /** DL 済みで適用を待っているハンドル。 */
  let pending: UpdateAvailable | null = null;

  return function run(effect: UpdaterEffect, send: (event: UpdaterEvent) => void): void {
    switch (effect.kind) {
      case 'check':
        void (async () => {
          const found = await deps.checkForUpdate();
          if (!found) {
            send({ type: 'updater/check-succeeded', info: null });
            return;
          }
          pending = found;
          const { _handle: _omit, ...info } = found;
          send({ type: 'updater/check-succeeded', info });
        })();
        return;

      case 'download':
        void (async () => {
          const handle = pending;
          if (!handle) {
            send({ type: 'updater/download-failed' });
            return;
          }
          try {
            await deps.downloadUpdate(handle, (p) => {
              send({ type: 'updater/download-progressed', ratio: p.ratio ?? -1 });
            });
            send({ type: 'updater/download-succeeded' });
          } catch (e) {
            // バックグラウンドの失敗はユーザーに見せない。次回起動でやり直す。
            console.warn('[updater] background download failed:', e);
            pending = null;
            send({ type: 'updater/download-failed' });
          }
        })();
        return;

      case 'refresh':
        void (async () => {
          try {
            const latest = await deps.checkForUpdate();
            // 取得できない (ネットワーク不通など) ときは既存の pending をそのまま残す。
            if (!latest) {
              send({ type: 'updater/refresh-settled' });
              return;
            }
            if (pending && compareVersions(latest.version, pending.version) <= 0) {
              send({ type: 'updater/refresh-settled' });
              return;
            }
            // バッジ表示中なので進捗 UI は不要。完全に裏で落とす。
            await deps.downloadUpdate(latest, () => {});
            pending = latest;
            const { _handle: _omit, ...info } = latest;
            send({ type: 'updater/refresh-succeeded', info });
          } catch (e) {
            // 差し替えに失敗しても、古い pending で更新はできる。黙って諦める。
            console.warn('[updater] refresh failed:', e);
            send({ type: 'updater/refresh-settled' });
          }
        })();
        return;

      case 'install':
        void (async () => {
          if (!pending) {
            send({
              type: 'updater/install-failed',
              message: '更新ハンドルが失われました。アプリを再起動してください。',
            });
            return;
          }
          try {
            await deps.installAndRelaunch(pending);
            // relaunch 後は到達しない
          } catch (e) {
            send({
              type: 'updater/install-failed',
              message: (e as Error)?.message ?? String(e),
            });
          }
        })();
        return;

      default: {
        const exhaustive: never = effect;
        void exhaustive;
      }
    }
  };
}
