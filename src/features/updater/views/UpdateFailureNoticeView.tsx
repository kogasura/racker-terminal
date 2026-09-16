/**
 * 前回の更新が反映されなかったことを知らせるダイアログの Passive View。
 *
 * 通常の更新フローとは独立している。Windows ではインストーラの起動失敗がアプリ側に
 * 一切返らないため、次の起動でバージョンを突き合わせて初めて分かる
 * (lib/updater.ts の takeFailedUpdateAttempt を参照)。
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useEmit } from '../../../architecture/chain';
import type { UpdaterEvent } from '../events';
import type { FailureNoticeViewModel } from '../viewModel';

export interface UpdateFailureNoticeViewProps {
  readonly vm: FailureNoticeViewModel;
}

export function UpdateFailureNoticeView({ vm }: UpdateFailureNoticeViewProps) {
  const emit = useEmit<UpdaterEvent>();

  if (!vm.visible) return null;

  const dismiss = () => emit({ type: 'updater/failure-notice-dismissed' });

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
          <Dialog.Title className="dialog-title">アップデートが適用されませんでした</Dialog.Title>
          <Dialog.Description className="dialog-description">
            {vm.version} をインストールしようとしましたが、{vm.currentVersion} のまま起動しています。
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
