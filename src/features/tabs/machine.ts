/**
 * タブ操作の Mediator — キーコマンドを受け付けるかどうかを裁定するステートマシン。
 *
 * ```
 *   accepting ──context-menu-opened──> suspended
 *       ^                                  |
 *       +────────context-menu-closed───────+
 * ```
 *
 * `suspended` の間に届いたコマンドは黙って捨てます。以前はこの抑止が store の
 * `contextMenuOpen` フラグとして置かれ、キーハンドラが `getState()` で直接覗いて
 * いました。「メニューが開いている」と「キーコマンドを止める」は同じ 1 つの関心なので、
 * フラグではなく状態として持たせています。
 *
 * **タブそのもののデータ (groups / tabs / favorites) は、まだ store が持っています。**
 * ここが裁定するのは「コマンドを通すか」までで、通ったコマンドは効果として store の
 * アクションに落ちます (effects.ts)。データ自体の移設は次の段階です。
 */

import type { Step, TransitionFn } from '../../architecture/machine';
import type { NavigateDirection, TabsEvent } from './events';

export interface TabsState {
  /**
   * キーコマンドを受け付けるか。
   * コンテキストメニューが開いている間は `suspended` になる。
   */
  readonly input: 'accepting' | 'suspended';
}

/** 裁定を通ったコマンド。実行は effects.ts の担当。 */
export type TabsEffect =
  | { readonly kind: 'close-active' }
  | { readonly kind: 'create-tab' }
  | { readonly kind: 'create-group' }
  | { readonly kind: 'navigate'; readonly direction: NavigateDirection }
  | { readonly kind: 'restore' }
  | { readonly kind: 'spawn-default' }
  | { readonly kind: 'spawn-favorite'; readonly index: number };

export const initialState: TabsState = { input: 'accepting' };

/** 状態を変えずに効果だけ出す (コマンドは状態を持たない)。 */
function dispatch(state: TabsState, effect: TabsEffect): Step<TabsState, TabsEffect> {
  return { state, effects: [effect] };
}

type Handler<K extends TabsEvent['type']> = (
  state: TabsState,
  event: Extract<TabsEvent, { type: K }>,
) => Step<TabsState, TabsEffect> | null;

type HandlerMap = { [K in TabsEvent['type']]: Handler<K> };

/** コマンドを通してよい状態か。 */
function accepting(state: TabsState): boolean {
  return state.input === 'accepting';
}

const handlers: HandlerMap = {
  // --- 入力モード -----------------------------------------------------------
  'tabs/context-menu-opened': (state) =>
    state.input === 'suspended' ? null : { state: { input: 'suspended' } },

  'tabs/context-menu-closed': (state) =>
    state.input === 'accepting' ? null : { state: { input: 'accepting' } },

  // --- コマンド -------------------------------------------------------------
  'tabs/close-active-requested': (state) =>
    accepting(state) ? dispatch(state, { kind: 'close-active' }) : null,

  'tabs/navigate-requested': (state, event) =>
    accepting(state) ? dispatch(state, { kind: 'navigate', direction: event.direction }) : null,

  'tabs/restore-requested': (state) =>
    accepting(state) ? dispatch(state, { kind: 'restore' }) : null,

  'tabs/spawn-default-requested': (state) =>
    accepting(state) ? dispatch(state, { kind: 'spawn-default' }) : null,

  'tabs/spawn-favorite-requested': (state, event) =>
    accepting(state) ? dispatch(state, { kind: 'spawn-favorite', index: event.index }) : null,

  // --- ポインタ由来。入力モードで止めない (events.ts の TabsPointerIntent 参照) -----
  'tabs/tab-create-requested': (state) => dispatch(state, { kind: 'create-tab' }),

  'tabs/group-create-requested': (state) => dispatch(state, { kind: 'create-group' }),
};

/**
 * タブ操作の遷移関数。純粋。
 *
 * `null` は「今の状態ではそのイベントは意味を持たない」という意思表示で、
 * 状態も通知も動かしません。
 */
export const transition: TransitionFn<TabsState, TabsEvent, TabsEffect> = (state, event) => {
  const handler = handlers[event.type] as Handler<TabsEvent['type']>;
  return handler(state, event);
};
