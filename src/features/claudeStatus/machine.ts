/**
 * ステータスバーの Mediator。
 *
 * 状態遷移は素直だが、**同じ値での更新を弾く**ところにこの機械の存在意義がある。
 * 会話ログは数秒ごと、利用量は数分ごとに引き直され、その大半は前回と同じ値になる。
 * 素通しすると画面下の 1 行のためにアプリ全体が再描画され続ける。
 *
 * 以前は store の `setClaudeMeta` / `setClaudeUsage` が同じ判定を持っていた。
 * 遷移が `null` を返す＝「状態も通知も動かさない」という仕組みに乗せ替えたので、
 * 値ごとの比較だけがここに残っている。
 */

import type { Step, TransitionFn } from '../../architecture/machine';
import type { ClaudeTranscriptMeta, ClaudeUsageLimits } from '../../lib/claudeMeta';
import type { ClaudeStatusEvent } from './events';

export interface ClaudeStatusState {
  /** いま表示対象になっているタブ。 */
  readonly activeTabId: string | null;
  /** アクティブタブで動いている Claude の情報。紐づくセッションが無ければ null。 */
  readonly meta: { readonly tabId: string; readonly meta: ClaudeTranscriptMeta } | null;
  /** プランの利用量。タブに依らずアカウント単位。 */
  readonly usage: ClaudeUsageLimits | null;
}

/** この機能に副作用はない (利用量の取得は Root が回している)。 */
export type ClaudeStatusEffect = never;

export const initialState: ClaudeStatusState = {
  activeTabId: null,
  meta: null,
  usage: null,
};

/** 描画に効く値が同じか。ここが true なら状態を動かさない。 */
function sameMeta(a: ClaudeTranscriptMeta, b: ClaudeTranscriptMeta): boolean {
  return a.model === b.model && a.effort === b.effort && a.contextTokens === b.contextTokens;
}

function sameUsage(a: ClaudeUsageLimits, b: ClaudeUsageLimits): boolean {
  return (
    a.fiveHourPercent === b.fiveHourPercent &&
    a.sevenDayPercent === b.sevenDayPercent &&
    a.fiveHourResetsAt === b.fiveHourResetsAt &&
    a.sevenDayResetsAt === b.sevenDayResetsAt
  );
}

type Handler<K extends ClaudeStatusEvent['type']> = (
  state: ClaudeStatusState,
  event: Extract<ClaudeStatusEvent, { type: K }>,
) => Step<ClaudeStatusState, ClaudeStatusEffect> | null;

type HandlerMap = { [K in ClaudeStatusEvent['type']]: Handler<K> };

const handlers: HandlerMap = {
  'claude-status/meta-observed': (state, event) => {
    if (event.meta === null) {
      return state.meta === null ? null : { state: { ...state, meta: null } };
    }
    // 同じタブで同じ値なら参照ごと据え置く (数秒ごとの再描画を防ぐ)
    if (state.meta && state.meta.tabId === event.tabId && sameMeta(state.meta.meta, event.meta)) {
      return null;
    }
    return { state: { ...state, meta: { tabId: event.tabId, meta: event.meta } } };
  },

  'claude-status/usage-observed': (state, event) => {
    if (event.usage === null) {
      return state.usage === null ? null : { state: { ...state, usage: null } };
    }
    if (state.usage && sameUsage(state.usage, event.usage)) return null;
    return { state: { ...state, usage: event.usage } };
  },

  'claude-status/active-tab-changed': (state, event) => {
    if (state.activeTabId === event.tabId) return null;
    return { state: { ...state, activeTabId: event.tabId } };
  },
};

export const transition: TransitionFn<ClaudeStatusState, ClaudeStatusEvent, ClaudeStatusEffect> = (
  state,
  event,
) => {
  const handler = handlers[event.type] as Handler<ClaudeStatusEvent['type']>;
  return handler(state, event);
};
