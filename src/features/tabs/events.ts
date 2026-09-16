/**
 * タブ操作コマンドのイベント定義。
 *
 * キーボードショートカットは、たまたまターミナル面の上で押されるだけで、
 * ターミナルとは関係のないアプリ操作です。押されたことだけを上へ流し、
 * 実行するかどうかは Mediator が決めます。
 */

import type { ChainEvent } from '../../architecture/chain';

/** タブの移動方向。 */
export type NavigateDirection = 'next' | 'prev';

/**
 * キーボード由来の操作。
 *
 * コンテキストメニューが開いている間は Mediator が捨てる。メニュー表示中でも
 * キーイベントはターミナルまで届いてしまうため、ここで止める必要がある。
 */
export type TabsIntent =
  /** アクティブなタブを閉じる (Ctrl+Shift+W) */
  | { readonly type: 'tabs/close-active-requested' }
  /** 次 / 前のタブへ移動する (Ctrl+Tab / Ctrl+Shift+Tab) */
  | { readonly type: 'tabs/navigate-requested'; readonly direction: NavigateDirection }
  /** 最後に閉じたタブを復元する (Ctrl+Shift+T) */
  | { readonly type: 'tabs/restore-requested' }
  /** 既定タブを開く (Ctrl+T) */
  | { readonly type: 'tabs/spawn-default-requested' }
  /** お気に入りの index 番目を開く (Ctrl+Shift+1..9 → 0..8) */
  | { readonly type: 'tabs/spawn-favorite-requested'; readonly index: number };

/**
 * ポインタ由来の操作。
 *
 * キーボード由来と違い、コンテキストメニュー表示中でも止めない。メニューが開いて
 * いるときにボタンを押せば、まずメニューが閉じてからクリックが届く — 誤爆の経路が
 * そもそも無いため、止める理由がない。
 */
export type TabsPointerIntent =
  /** 選択中グループに新しいタブを足す (タブバーの +) */
  | { readonly type: 'tabs/tab-create-requested' }
  /** 新しいグループを作って選択する (サイドバーの + New Group) */
  | { readonly type: 'tabs/group-create-requested' };

/**
 * 入力モードの変化。
 *
 * コンテキストメニューが開いている間はキーコマンドを止める。以前は store の
 * `contextMenuOpen` を各所から書き換え、キーハンドラが `getState()` で覗いていた。
 * 表示されているメニューとキー入力の可否は同じ 1 つの関心なので、Mediator に集めた。
 */
export type TabsModeChange =
  | { readonly type: 'tabs/context-menu-opened' }
  | { readonly type: 'tabs/context-menu-closed' };

export type TabsEvent = TabsIntent | TabsPointerIntent | TabsModeChange;

/** チェーンに流せる形であることを型で確かめておく (実行時のコードは生まない)。 */
type _AssertChainEvent = TabsEvent extends ChainEvent ? true : never;
export type { _AssertChainEvent };
