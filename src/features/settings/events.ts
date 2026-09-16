/**
 * 設定のイベント定義。
 *
 * 設定ダイアログは「変わったぶんだけ」を送る。開いている間に外から settings が
 * 変わった場合でも、丸ごと上書きして相手の変更を消さないため (lost update 対策)。
 */

import type { ChainEvent } from '../../architecture/chain';
import type { Settings } from '../../types';

export type SettingsEvent = {
  readonly type: 'settings/changed';
  readonly patch: Partial<Settings>;
};

/** チェーンに流せる形であることを型で確かめておく (実行時のコードは生まない)。 */
type _AssertChainEvent = SettingsEvent extends ChainEvent ? true : never;
export type { _AssertChainEvent };
