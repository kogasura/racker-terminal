/**
 * 設定ダイアログの「バージョン情報」欄の Passive View。
 *
 * 以前はこの中で `updatePhase` を見て分岐し、`runUpdateCheck()` を await してから
 * store を覗いて結果を判定していた。判断も手順もすべて Mediator へ移したので、
 * ここは押されたことを上へ流すだけになっている。
 *
 * 設定ダイアログ自体を閉じるかどうかは updater の外側の関心なので、
 * 呼び出し側にコールバックで返す。
 */

import { useEmit } from '../../../architecture/chain';
import type { UpdaterEvent } from '../events';
import type { SettingsSectionViewModel } from '../viewModel';

export interface UpdateSettingsSectionViewProps {
  readonly vm: SettingsSectionViewModel;
  /** アプリのバージョン。取得できていなければ null。 */
  readonly appVersion: string | null;
  /** 更新ダイアログへ遷移するとき、設定ダイアログを閉じてもらうための通知。 */
  readonly onLeaveForDialog: () => void;
}

export function UpdateSettingsSectionView({
  vm,
  appVersion,
  onLeaveForDialog,
}: UpdateSettingsSectionViewProps) {
  const emit = useEmit<UpdaterEvent>();

  function handleClick() {
    // ready / error のときは更新ダイアログへ渡す。ready なら、さらに新しい版が
    // 出ていないかの確認も一緒に投げる (待たずに開く。差し替わったら表示が追従する)。
    emit({ type: 'updater/check-requested', manual: true });
    if (vm.opensDialog) {
      emit({ type: 'updater/badge-clicked' });
      onLeaveForDialog();
    }
  }

  return (
    <div className="dialog-field">
      <span className="dialog-label">バージョン情報</span>
      <div className="settings-version-row">
        <span className="settings-version-text">現在のバージョン: {appVersion ?? '—'}</span>
        <button
          type="button"
          className="dialog-btn dialog-btn--cancel"
          onClick={handleClick}
          disabled={vm.buttonDisabled}
        >
          {vm.buttonLabel}
        </button>
      </div>
      {vm.message && <small className="dialog-hint">{vm.message}</small>}
    </div>
  );
}
