/**
 * 状態 → ステータスバーの描画パラメータ。純粋関数。
 *
 * 「バーを出すかどうか」「左側 (Claude 情報) を出すか」「右側 (利用量) を出すか」の
 * 判断をここに集める。View は受け取ったものを並べるだけになる。
 *
 * ポーリングの往復中にタブが切り替わったとき、前のタブの値を出さないための
 * 突き合わせもここでやる。以前は View の中で `claudeMeta?.tabId === activeTabId` を
 * 見ていた。
 */

import { hasAnythingToShow, type ClaudeTranscriptMeta, type ClaudeUsageLimits } from '../../lib/claudeMeta';
import type { ClaudeStatusState } from './machine';

export interface StatusBarViewModel {
  /** バーごと出すか。出すものが何も無ければ空の帯を残さない。 */
  readonly visible: boolean;
  /** 左側に出す Claude の情報。無ければ null。 */
  readonly meta: ClaudeTranscriptMeta | null;
  /** 右側に出すプラン利用量。無ければ null。 */
  readonly usage: ClaudeUsageLimits | null;
}

const HIDDEN: StatusBarViewModel = { visible: false, meta: null, usage: null };

/**
 * @param enabled 設定でステータスバーが有効か (未設定は有効として扱う)。
 */
export function selectStatusBar(state: ClaudeStatusState, enabled: boolean): StatusBarViewModel {
  if (!enabled) return HIDDEN;

  // ポーリングの往復中にタブが切り替わったとき、前のタブの値を出さない
  const meta = state.meta?.tabId === state.activeTabId ? (state.meta?.meta ?? null) : null;
  const usage = state.usage;

  if (!hasAnythingToShow(meta, usage)) return HIDDEN;
  return { visible: true, meta, usage };
}
