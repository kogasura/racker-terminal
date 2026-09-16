/**
 * 更新ダイアログの Passive View。
 *
 * 受け取った View モデルを並べ、操作をチェーンへ投げるだけ。状態も判断も持たない。
 * 「インストール中は閉じられない」といった規則は Mediator 側にあり、ここは
 * `dismissible` を見て閉じる操作を上げるかどうかだけを決める
 * (それすら判断と呼ぶなら、Radix に閉じる意思を渡さないための配線にすぎない)。
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useEmit } from '../../../architecture/chain';
import type { UpdaterEvent } from '../events';
import type { DialogViewModel } from '../viewModel';

export interface UpdateDialogViewProps {
  readonly vm: DialogViewModel;
}

export function UpdateDialogView({ vm }: UpdateDialogViewProps) {
  const emit = useEmit<UpdaterEvent>();

  if (!vm.open) return null;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (next) return;
        if (!vm.dismissible) return;
        emit({ type: 'updater/dialog-dismissed' });
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">{vm.title}</Dialog.Title>
          <Dialog.Description className="dialog-description">{vm.description}</Dialog.Description>

          {vm.body === 'installing' && (
            <p className="update-dialog__installing">再起動して新バージョンを起動します...</p>
          )}

          {vm.body === 'error' && (
            <>
              <p className="dialog-error">{vm.errorMessage}</p>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="dialog-btn dialog-btn--cancel"
                  onClick={() => emit({ type: 'updater/dialog-dismissed' })}
                >
                  {vm.secondaryLabel}
                </button>
                <button
                  type="button"
                  className="dialog-btn dialog-btn--submit"
                  onClick={() => emit({ type: 'updater/apply-requested' })}
                >
                  {vm.primaryLabel}
                </button>
              </div>
            </>
          )}

          {vm.body === 'ready' && (
            <>
              {vm.notes && (
                <div className="update-dialog__notes">
                  <pre className="update-dialog__notes-pre">{vm.notes}</pre>
                </div>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="dialog-btn dialog-btn--cancel"
                  onClick={() => emit({ type: 'updater/dialog-dismissed' })}
                >
                  {vm.secondaryLabel}
                </button>
                <button
                  type="button"
                  className="dialog-btn dialog-btn--submit"
                  onClick={() => emit({ type: 'updater/apply-requested' })}
                >
                  {vm.primaryLabel}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
