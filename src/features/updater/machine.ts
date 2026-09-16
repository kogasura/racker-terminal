/**
 * updater の Mediator 本体 — 自動更新フローのステートマシン。
 *
 * 以前は `updatePhase` / `updateDialogOpen` / `updateError` / `updateInfo` という
 * 独立したフラグの組み合わせで表していたため、「idle なのにダイアログが開いている」
 * 「error なのに updateError が null」といった、ありえない組み合わせを作れてしまった。
 * ここでは状態を判別可能なユニオンにして、その組み合わせを型で消している。
 *
 * ```
 *   idle ──check-requested──> checking ──(info あり)──> downloading
 *    ^                           |                          |
 *    |                      (info なし)              download-succeeded
 *    +---------------------------+                          |
 *    ^                                                      v
 *    +------------ download-failed ----------------------  ready <--+
 *                                                            |      | refresh-*
 *                                         apply-requested    +------+
 *                                                            v
 *                                                       installing
 *                                                            |
 *                                                     install-failed
 *                                                            v
 *                                                          error --apply-requested--> installing
 * ```
 *
 * `installFailure` と `manualCheck` は上のフローとは**直交**するリージョン。
 * 前回の更新が反映されなかった通知も、設定画面に出す手動チェックの結果も、
 * 今回の更新フローがどの状態にあるかとは独立に決まる。
 */

import type { Step, TransitionFn } from '../../architecture/machine';
import type { UpdateInfo, UpdateInstallFailure } from '../../types';
import type { UpdaterEvent } from './events';

/** 更新フローの状態。 */
export type FlowState =
  | { readonly status: 'idle' }
  /** `manual` は、この確認が設定画面のボタン由来かどうか。 */
  | { readonly status: 'checking'; readonly manual: boolean }
  | { readonly status: 'downloading'; readonly info: UpdateInfo; readonly progress: number }
  | {
      readonly status: 'ready';
      readonly info: UpdateInfo;
      readonly dialogOpen: boolean;
      /** より新しい版への差し替えを裏で走らせている最中か */
      readonly refreshing: boolean;
    }
  | { readonly status: 'installing'; readonly info: UpdateInfo; readonly dialogOpen: boolean }
  | {
      readonly status: 'error';
      readonly info: UpdateInfo;
      readonly message: string;
      readonly dialogOpen: boolean;
    };

/** 設定画面に出す、手動チェックの結果。 */
export type ManualCheckResult = 'none' | 'found' | 'no-update' | 'error';

export interface UpdaterState {
  readonly flow: FlowState;
  /** flow と直交。前回の更新が反映されなかったことの通知。 */
  readonly installFailure: UpdateInstallFailure | null;
  /** flow と直交。設定画面のメッセージ欄。 */
  readonly manualCheck: ManualCheckResult;
}

/** Mediator が「やってほしい」と言う副作用。実行は effects.ts の担当。 */
export type UpdaterEffect =
  | { readonly kind: 'check' }
  | { readonly kind: 'download'; readonly info: UpdateInfo }
  | { readonly kind: 'refresh'; readonly pending: UpdateInfo }
  | { readonly kind: 'install' };

export const initialState: UpdaterState = {
  flow: { status: 'idle' },
  installFailure: null,
  manualCheck: 'none',
};

/**
 * 進捗の量子化しきい値 (1%)。
 * ここで弾かないと DL 中に毎チャンク再描画が走る。
 */
const PROGRESS_EPSILON = 0.01;

/** 進捗を状態に反映する価値があるか。不明 (-1) と既知の行き来も変化として扱う。 */
function progressChanged(prev: number, next: number): boolean {
  if (next < 0 && prev >= 0) return true;
  if (next >= 0 && prev < 0) return true;
  return next >= 0 && Math.abs(next - prev) >= PROGRESS_EPSILON;
}

/** flow だけ差し替える (直交リージョンは保つ)。 */
function withFlow(
  state: UpdaterState,
  flow: FlowState,
  effects?: UpdaterEffect[],
): Step<UpdaterState, UpdaterEffect> {
  return { state: { ...state, flow }, effects };
}

/**
 * イベント 1 種類につき 1 つのハンドラ。
 *
 * 大きな switch にすると分岐が 1 関数に集まりすぎて読めなくなるので、表に開いている。
 * キーを `UpdaterEvent['type']` の写像型にしてあるので、イベントを足してここに
 * 書き忘れるとコンパイルが通らない (switch の網羅チェックと同じ効き目)。
 */
type Handler<K extends UpdaterEvent['type']> = (
  state: UpdaterState,
  event: Extract<UpdaterEvent, { type: K }>,
) => Step<UpdaterState, UpdaterEffect> | null;

type HandlerMap = { [K in UpdaterEvent['type']]: Handler<K> };

const handlers: HandlerMap = {
  // --- 直交リージョン: flow の状態に関係なく処理する -------------------------
  'updater/previous-attempt-detected': (state, event) => ({
    state: { ...state, installFailure: event.failure },
  }),

  'updater/failure-notice-dismissed': (state) =>
    state.installFailure ? { state: { ...state, installFailure: null } } : null,

  // --- チェック -------------------------------------------------------------
  'updater/check-requested': (state, event) => {
    // 手動チェックのたびに前回のメッセージは消す。
    const base = event.manual ? { ...state, manualCheck: 'none' as const } : state;
    const { flow } = state;

    if (flow.status === 'idle') {
      return withFlow(base, { status: 'checking', manual: event.manual }, [{ kind: 'check' }]);
    }
    // DL 済みで待機している間に、さらに新しい版が出ていることがある。ここで取り直さないと
    // 「再起動するたびに 1 バージョンずつしか上がらない」状態になる。バッジは出したままに
    // したいので ready から動かさず、裏で差し替える。
    if (flow.status === 'ready' && !flow.refreshing) {
      return withFlow(base, { ...flow, refreshing: true }, [{ kind: 'refresh', pending: flow.info }]);
    }
    // 確認中 / DL 中 / インストール中は走らせない (メッセージのクリアだけは反映する)。
    return base === state ? null : { state: base };
  },

  'updater/check-succeeded': (state, event) => {
    const { flow } = state;
    if (flow.status !== 'checking') return null;

    const manualCheck: ManualCheckResult = flow.manual
      ? (event.info ? 'found' : 'no-update')
      : state.manualCheck;
    const next = { ...state, manualCheck };

    if (!event.info) return withFlow(next, { status: 'idle' });
    return withFlow(next, { status: 'downloading', info: event.info, progress: 0 }, [
      { kind: 'download', info: event.info },
    ]);
  },

  'updater/check-failed': (state) => {
    const { flow } = state;
    if (flow.status !== 'checking') return null;
    const manualCheck: ManualCheckResult = flow.manual ? 'error' : state.manualCheck;
    return withFlow({ ...state, manualCheck }, { status: 'idle' });
  },

  // --- ダウンロード ---------------------------------------------------------
  'updater/download-progressed': (state, event) => {
    const { flow } = state;
    if (flow.status !== 'downloading') return null;
    if (!progressChanged(flow.progress, event.ratio)) return null;
    return withFlow(state, { ...flow, progress: event.ratio });
  },

  'updater/download-succeeded': (state) => {
    const { flow } = state;
    if (flow.status !== 'downloading') return null;
    return withFlow(state, { status: 'ready', info: flow.info, dialogOpen: false, refreshing: false });
  },

  // バックグラウンド DL の失敗はユーザーに見せず、次回起動でやり直す。
  'updater/download-failed': (state) =>
    state.flow.status === 'downloading' ? withFlow(state, { status: 'idle' }) : null,

  // --- 待機中の差し替え -----------------------------------------------------
  'updater/refresh-succeeded': (state, event) => {
    const { flow } = state;
    // 差し替えの最中にユーザーが適用を始めていたら (installing / error) 触らない。
    if (flow.status !== 'ready') return null;
    return withFlow(state, { ...flow, info: event.info, refreshing: false });
  },

  'updater/refresh-settled': (state) => {
    const { flow } = state;
    if (flow.status !== 'ready' || !flow.refreshing) return null;
    return withFlow(state, { ...flow, refreshing: false });
  },

  // --- ダイアログ -----------------------------------------------------------
  // バッジは ready / error のときだけ出している。
  'updater/badge-clicked': (state) => {
    const { flow } = state;
    if (flow.status !== 'ready' && flow.status !== 'error') return null;
    if (flow.dialogOpen) return null;
    return withFlow(state, { ...flow, dialogOpen: true });
  },

  // インストール中は閉じさせない (再起動待ちで、中断する手段がない)。
  'updater/dialog-dismissed': (state) => {
    const { flow } = state;
    if (flow.status !== 'ready' && flow.status !== 'error') return null;
    if (!flow.dialogOpen) return null;
    return withFlow(state, { ...flow, dialogOpen: false });
  },

  // --- 適用 -----------------------------------------------------------------
  // ready / error からのみ。再入と、DL 中の誤操作を弾く。
  'updater/apply-requested': (state) => {
    const { flow } = state;
    if (flow.status !== 'ready' && flow.status !== 'error') return null;
    return withFlow(state, { status: 'installing', info: flow.info, dialogOpen: true }, [
      { kind: 'install' },
    ]);
  },

  'updater/install-failed': (state, event) => {
    const { flow } = state;
    if (flow.status !== 'installing') return null;
    return withFlow(state, {
      status: 'error',
      info: flow.info,
      message: event.message,
      dialogOpen: true,
    });
  },

  'updater/error-reset': (state) =>
    state.flow.status === 'error' ? withFlow(state, { status: 'idle' }) : null,
};

/**
 * updater の遷移関数。純粋。
 *
 * 返り値が `null` のイベントは「今の状態では意味を持たない操作」で、黙って捨てる。
 * DL 中に再チェックが重なる、インストール中にダイアログを閉じようとする、といった
 * ケースの防御はすべて上のハンドラ表に集まっている。
 */
export const transition: TransitionFn<UpdaterState, UpdaterEvent, UpdaterEffect> = (state, event) => {
  // 写像型でキーと引数の対応は保証済み。ここだけは型を合わせるためのキャストが要る。
  const handler = handlers[event.type] as Handler<UpdaterEvent['type']>;
  return handler(state, event);
};
