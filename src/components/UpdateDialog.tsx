import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/appStore';
import type { UpdateInfo } from '../types';

/**
 * 前回の更新が反映されなかったことを知らせるダイアログ。
 *
 * 通常の更新フロー (updatePhase) とは独立している。Windows ではインストーラの
 * 起動失敗がアプリ側に一切返らないため、次の起動でバージョンを突き合わせて
 * 初めて分かる (lib/updater.ts の takeFailedUpdateAttempt を参照)。
 */
function UpdateInstallFailureDialog() {
  const failure = useAppStore((s) => s.updateInstallFailure);
  const dismiss = useAppStore((s) => s.dismissUpdateInstallFailure);

  if (!failure) return null;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">
            アップデートが適用されませんでした
          </Dialog.Title>
          <Dialog.Description className="dialog-description">
            {failure.version} をインストールしようとしましたが、{failure.currentVersion}{' '}
            のまま起動しています。
          </Dialog.Description>
          <p className="update-dialog__failure-hint">
            インストーラが最後まで走らなかったようです。もう一度お試しください。
            続くようであれば、リリースページからインストーラを直接実行してください。
          </p>
          <div className="dialog-actions">
            <button type="button" className="dialog-btn dialog-btn--submit" onClick={dismiss}>
              閉じる
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function UpdateDialog() {
  const open = useAppStore((s) => s.updateDialogOpen);
  const info = useAppStore((s) => s.updateInfo);
  const phase = useAppStore((s) => s.updatePhase);
  const error = useAppStore((s) => s.updateError);
  const close = useAppStore((s) => s.closeUpdateDialog);
  const apply = useAppStore((s) => s.applyUpdate);

  // idle / checking / downloading のときは更新ダイアログを出さない。
  // 失敗通知は phase と独立しているので、そのときも描画する。
  if (phase === 'idle' || phase === 'checking' || phase === 'downloading' || !info) {
    return <UpdateInstallFailureDialog />;
  }

  const isBusy = phase === 'installing';

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && isBusy) return;
    if (!nextOpen) close();
  }

  function renderBody(currentInfo: UpdateInfo) {
    if (phase === 'error') {
      return (
        <>
          <p className="dialog-error">{error ?? 'アップデートに失敗しました。'}</p>
          <div className="dialog-actions">
            <button type="button" className="dialog-btn dialog-btn--cancel" onClick={close}>
              閉じる
            </button>
            <button
              type="button"
              className="dialog-btn dialog-btn--submit"
              onClick={() => void apply()}
            >
              リトライ
            </button>
          </div>
        </>
      );
    }

    if (phase === 'installing') {
      return (
        <p className="update-dialog__installing">
          再起動して新バージョンを起動します...
        </p>
      );
    }

    // phase === 'ready': メイン UI
    return (
      <>
        {currentInfo.notes && (
          <div className="update-dialog__notes">
            <pre className="update-dialog__notes-pre">{currentInfo.notes}</pre>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn dialog-btn--cancel" onClick={close}>
            あとで
          </button>
          <button
            type="button"
            className="dialog-btn dialog-btn--submit"
            onClick={() => void apply()}
          >
            今すぐ再起動
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <UpdateInstallFailureDialog />
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title className="dialog-title">
              アップデートが利用可能です ({info.currentVersion} → {info.version})
            </Dialog.Title>
            <Dialog.Description className="dialog-description">
              {phase === 'ready'
                ? '新しいバージョンのダウンロードが完了しました。再起動して適用しますか?'
                : `現在のバージョン: ${info.currentVersion}${info.date ? ` — リリース: ${info.date}` : ''}`}
            </Dialog.Description>
            {renderBody(info)}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
