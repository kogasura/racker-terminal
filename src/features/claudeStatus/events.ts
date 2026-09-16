/**
 * ステータスバー (Claude の状態表示) のイベント定義。
 *
 * 会話ログの読み取りはタブのセッション巡回にぶら下がっているため、
 * 読めた結果はその巡回側からイベントとして流れてくる。プランの利用量は
 * この機能の Root が自分で引く。
 */

import type { ChainEvent } from '../../architecture/chain';
import type { ClaudeTranscriptMeta, ClaudeUsageLimits } from '../../lib/claudeMeta';

export type ClaudeStatusEvent =
  /**
   * アクティブタブの会話ログを読み直した結果。
   * `meta` が null なら、そのタブに Claude のセッションが紐づいていない (表示を消す)。
   */
  | {
      readonly type: 'claude-status/meta-observed';
      readonly tabId: string;
      readonly meta: ClaudeTranscriptMeta | null;
    }
  /** プラン利用量を引き直した結果。 */
  | { readonly type: 'claude-status/usage-observed'; readonly usage: ClaudeUsageLimits | null }
  /** 表示対象のタブが変わった (前のタブの値を出し続けないため)。 */
  | { readonly type: 'claude-status/active-tab-changed'; readonly tabId: string | null };

/** チェーンに流せる形であることを型で確かめておく (実行時のコードは生まない)。 */
type _AssertChainEvent = ClaudeStatusEvent extends ChainEvent ? true : never;
export type { _AssertChainEvent };
