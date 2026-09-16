/**
 * updater 機能のイベント定義。
 *
 * Passive View から上がってくる「操作」と、副作用から返ってくる「結果」を
 * 同じチェーンに流し、Mediator に裁定させる。View 側のイベントは
 * *何が起きたか* だけを言い、*何をすべきか* は言わない
 * (`apply-requested` であって `install` ではない)。
 */

import type { ChainEvent } from '../../architecture/chain';
import type { UpdateInfo, UpdateInstallFailure } from '../../types';

/** View から上がる操作。 */
export type UpdaterIntent =
  /**
   * 更新の確認。`manual` は設定画面のボタン由来かどうか。
   * 定期チェックの結果を設定画面のメッセージ欄に出してしまわないよう区別する。
   */
  | { readonly type: 'updater/check-requested'; readonly manual: boolean }
  /** タイトルバーのバッジが押された */
  | { readonly type: 'updater/badge-clicked' }
  /** ダイアログを閉じようとした (× / あとで / オーバーレイ) */
  | { readonly type: 'updater/dialog-dismissed' }
  /** 「今すぐ再起動」/「リトライ」 */
  | { readonly type: 'updater/apply-requested' }
  /** エラー状態を捨てて最初からやり直す */
  | { readonly type: 'updater/error-reset' }
  /** 前回の更新が反映されなかった通知を閉じた */
  | { readonly type: 'updater/failure-notice-dismissed' };

/** 副作用から返る結果。 */
export type UpdaterOutcome =
  | { readonly type: 'updater/check-succeeded'; readonly info: UpdateInfo | null }
  | { readonly type: 'updater/check-failed' }
  | { readonly type: 'updater/download-progressed'; readonly ratio: number }
  | { readonly type: 'updater/download-succeeded' }
  | { readonly type: 'updater/download-failed' }
  /** 待機中の版より新しいものに差し替えられた */
  | { readonly type: 'updater/refresh-succeeded'; readonly info: UpdateInfo }
  /** 差し替えは起きなかった (最新だった / 取得できなかった / DL に失敗した) */
  | { readonly type: 'updater/refresh-settled' }
  | { readonly type: 'updater/install-failed'; readonly message: string }
  | {
      readonly type: 'updater/previous-attempt-detected';
      readonly failure: UpdateInstallFailure;
    };

export type UpdaterEvent = UpdaterIntent | UpdaterOutcome;

/** チェーンに流せることを型で確かめておく。 */
const _assertChainEvent: ChainEvent = {
  type: 'updater/badge-clicked',
} satisfies UpdaterEvent;
void _assertChainEvent;
