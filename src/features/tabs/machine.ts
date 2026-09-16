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
import type { DragKind, Favorite } from '../../types';
import type { NavigateDirection, TabsEvent } from './events';

export interface TabsState {
  /**
   * キーコマンドを受け付けるか。
   * コンテキストメニューが開いている間は `suspended` になる。
   */
  readonly input: 'accepting' | 'suspended';
  /**
   * D&D で何かを掴んでいるか。掴んでいなければ null。
   *
   * 以前は store の `dragId` / `dragKind` という 2 つのフラグだった。
   * 「id はあるが kind が無い」のような組み合わせを作れてしまっていたので、
   * 1 つの状態に畳んでいる。
   */
  readonly drag: { readonly dragId: string; readonly kind: DragKind | null } | null;
}

/** 裁定を通ったコマンド。実行は effects.ts の担当。 */
export type TabsEffect =
  | { readonly kind: 'close-active' }
  | { readonly kind: 'create-tab' }
  | { readonly kind: 'create-group' }
  | { readonly kind: 'activate-tab'; readonly tabId: string }
  | { readonly kind: 'close-tab'; readonly tabId: string }
  | { readonly kind: 'start-editing'; readonly tabId: string }
  | { readonly kind: 'rename-tab'; readonly tabId: string; readonly title: string }
  | { readonly kind: 'duplicate-tab'; readonly tabId: string }
  | { readonly kind: 'favorite-tab'; readonly tabId: string }
  | { readonly kind: 'clear-claude-session'; readonly tabId: string }
  | { readonly kind: 'move-tab'; readonly tabId: string; readonly toGroupId: string }
  | { readonly kind: 'move-tab-to-new-group'; readonly tabId: string }
  | { readonly kind: 'activate-group'; readonly groupId: string }
  | { readonly kind: 'start-editing-group'; readonly groupId: string }
  | { readonly kind: 'rename-group'; readonly groupId: string; readonly title: string }
  | { readonly kind: 'close-group'; readonly groupId: string }
  | { readonly kind: 'create-tab-in-group'; readonly groupId: string }
  | { readonly kind: 'spawn-favorite-by-id'; readonly favoriteId: string }
  | { readonly kind: 'remove-favorite'; readonly favoriteId: string }
  | { readonly kind: 'toggle-default-favorite'; readonly favoriteId: string }
  | { readonly kind: 'add-favorite'; readonly favorite: Omit<Favorite, 'id'> }
  | {
      readonly kind: 'update-favorite';
      readonly favoriteId: string;
      readonly favorite: Omit<Favorite, 'id'>;
    }
  /** 掴み始めたら、編集中の入力を確定 / 取り消しして D&D を優先する。 */
  | { readonly kind: 'stop-editing' }
  /** 落とした先を解決して反映する。 */
  | {
      readonly kind: 'apply-drop';
      readonly dragId: string;
      readonly dragKind: DragKind | null;
      readonly overId: string;
      readonly fromGroupId: string | undefined;
    }
  | { readonly kind: 'navigate'; readonly direction: NavigateDirection }
  | { readonly kind: 'restore' }
  | { readonly kind: 'spawn-default' }
  | { readonly kind: 'spawn-favorite'; readonly index: number };

export const initialState: TabsState = { input: 'accepting', drag: null };

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
  // --- D&D ------------------------------------------------------------------
  'tabs/drag-started': (state, event) => ({
    state: { ...state, drag: { dragId: event.dragId, kind: event.kind } },
    // InlineEdit が編集中なら確定 or キャンセルして D&D を優先する
    effects: [{ kind: 'stop-editing' }],
  }),

  'tabs/drag-ended': (state, event) => {
    const drag = state.drag;
    const cleared: TabsState = { ...state, drag: null };
    if (!drag) return { state: cleared };

    // どこにも落とさなかった / 同じものの上で離した場合は移動しない
    if (event.overId === null || event.overId === drag.dragId) return { state: cleared };

    return {
      state: cleared,
      effects: [
        {
          kind: 'apply-drop',
          dragId: drag.dragId,
          dragKind: drag.kind,
          overId: event.overId,
          fromGroupId: event.fromGroupId,
        },
      ],
    };
  },

  // --- 入力モード -----------------------------------------------------------
  'tabs/context-menu-opened': (state) =>
    state.input === 'suspended' ? null : { state: { ...state, input: 'suspended' } },

  'tabs/context-menu-closed': (state) =>
    state.input === 'accepting' ? null : { state: { ...state, input: 'accepting' } },

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

  'tabs/tab-activated': (state, event) =>
    dispatch(state, { kind: 'activate-tab', tabId: event.tabId }),

  'tabs/tab-close-requested': (state, event) =>
    dispatch(state, { kind: 'close-tab', tabId: event.tabId }),

  'tabs/tab-rename-started': (state, event) =>
    dispatch(state, { kind: 'start-editing', tabId: event.tabId }),

  'tabs/tab-renamed': (state, event) =>
    dispatch(state, { kind: 'rename-tab', tabId: event.tabId, title: event.title }),

  'tabs/tab-duplicate-requested': (state, event) =>
    dispatch(state, { kind: 'duplicate-tab', tabId: event.tabId }),

  'tabs/tab-favorite-requested': (state, event) =>
    dispatch(state, { kind: 'favorite-tab', tabId: event.tabId }),

  'tabs/claude-session-clear-requested': (state, event) =>
    dispatch(state, { kind: 'clear-claude-session', tabId: event.tabId }),

  'tabs/tab-move-requested': (state, event) =>
    dispatch(state, { kind: 'move-tab', tabId: event.tabId, toGroupId: event.toGroupId }),

  'tabs/tab-move-to-new-group-requested': (state, event) =>
    dispatch(state, { kind: 'move-tab-to-new-group', tabId: event.tabId }),

  'tabs/group-activated': (state, event) =>
    dispatch(state, { kind: 'activate-group', groupId: event.groupId }),

  'tabs/group-rename-started': (state, event) =>
    dispatch(state, { kind: 'start-editing-group', groupId: event.groupId }),

  'tabs/group-renamed': (state, event) =>
    dispatch(state, { kind: 'rename-group', groupId: event.groupId, title: event.title }),

  'tabs/group-close-requested': (state, event) =>
    dispatch(state, { kind: 'close-group', groupId: event.groupId }),

  'tabs/tab-create-in-group-requested': (state, event) =>
    dispatch(state, { kind: 'create-tab-in-group', groupId: event.groupId }),

  // Ctrl+T と同じ効果だが、こちらは入力モードで止めない
  'tabs/default-tab-open-requested': (state) => dispatch(state, { kind: 'spawn-default' }),

  'tabs/favorite-spawn-requested': (state, event) =>
    dispatch(state, { kind: 'spawn-favorite-by-id', favoriteId: event.favoriteId }),

  'tabs/favorite-remove-requested': (state, event) =>
    dispatch(state, { kind: 'remove-favorite', favoriteId: event.favoriteId }),

  'tabs/favorite-default-toggled': (state, event) =>
    dispatch(state, { kind: 'toggle-default-favorite', favoriteId: event.favoriteId }),

  'tabs/favorite-added': (state, event) =>
    dispatch(state, { kind: 'add-favorite', favorite: event.favorite }),

  'tabs/favorite-updated': (state, event) =>
    dispatch(state, {
      kind: 'update-favorite',
      favoriteId: event.favoriteId,
      favorite: event.favorite,
    }),
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
