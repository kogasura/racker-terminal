import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/appStore';
import type { UpdateInfo } from '../types';

export function UpdateDialog() {
  const open = useAppStore((s) => s.updateDialogOpen);
  const info = useAppStore((s) => s.updateInfo);
  const phase = useAppStore((s) => s.updatePhase);
  const progress = useAppStore((s) => s.updateProgress);
  const error = useAppStore((s) => s.updateError);
  const close = useAppStore((s) => s.closeUpdateDialog);
  const start = useAppStore((s) => s.startUpdateInstall);

  if (!info) return null;

  const isBusy = phase === 'downloading' || phase === 'installing';

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
              onClick={() => void start()}
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
          インストール中...再起動を待っています
        </p>
      );
    }

    if (phase === 'downloading') {
      const hasRatio = progress >= 0;
      return (
        <>
          <div className="update-dialog__progress">
            {hasRatio ? (
              <div
                className="update-dialog__progress-bar"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            ) : (
              <div className="update-dialog__progress-bar update-dialog__progress-bar--indeterminate" />
            )}
          </div>
          <p className="update-dialog__progress-label">
            {hasRatio ? `${Math.round(progress * 100)}%` : 'ダウンロード中...'}
          </p>
          <div className="dialog-actions">
            <button type="button" className="dialog-btn dialog-btn--cancel" disabled>
              あとで
            </button>
            <button type="button" className="dialog-btn dialog-btn--submit" disabled>
              今すぐ更新
            </button>
          </div>
        </>
      );
    }

    // phase === 'available' (default)
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
            onClick={() => void start()}
          >
            今すぐ更新
          </button>
        </div>
      </>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">
            アップデート {info.version} が利用可能
          </Dialog.Title>
          <Dialog.Description className="dialog-description">
            現在のバージョン: {info.currentVersion}
            {info.date ? ` — リリース: ${info.date}` : ''}
          </Dialog.Description>
          {renderBody(info)}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
