/**
 * タブ操作コマンドのイベント定義。
 *
 * キーボードショートカットは、たまたまターミナル面の上で押されるだけで、
 * ターミナルとは関係のないアプリ操作です。押されたことだけを上へ流し、
 * 実行するかどうかは Mediator が決めます。
 */

import type { ChainEvent } from '../../architecture/chain';
import type { Favorite } from '../../types';

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
  | { readonly type: 'tabs/group-create-requested' }
  /** タブをクリックして選んだ */
  | { readonly type: 'tabs/tab-activated'; readonly tabId: string }
  /** タブを閉じる (× ボタン / メニューの「閉じる」) */
  | { readonly type: 'tabs/tab-close-requested'; readonly tabId: string }
  /** タイトルの編集を始める (ダブルクリック / メニューの「リネーム」) */
  | { readonly type: 'tabs/tab-rename-started'; readonly tabId: string }
  /** タイトルの編集を確定した */
  | { readonly type: 'tabs/tab-renamed'; readonly tabId: string; readonly title: string }
  /** タブを複製する */
  | { readonly type: 'tabs/tab-duplicate-requested'; readonly tabId: string }
  /** タブの内容をお気に入りに登録する */
  | { readonly type: 'tabs/tab-favorite-requested'; readonly tabId: string }
  /** Claude セッションの紐付けを切り離す */
  | { readonly type: 'tabs/claude-session-clear-requested'; readonly tabId: string }
  /** タブを別のグループの末尾へ移す */
  | {
      readonly type: 'tabs/tab-move-requested';
      readonly tabId: string;
      readonly toGroupId: string;
    }
  /** 新しいグループを作ってそこへ移す */
  | { readonly type: 'tabs/tab-move-to-new-group-requested'; readonly tabId: string }
  /** グループ行をクリックして選んだ */
  | { readonly type: 'tabs/group-activated'; readonly groupId: string }
  /** グループ名の編集を始める */
  | { readonly type: 'tabs/group-rename-started'; readonly groupId: string }
  /** グループ名の編集を確定した */
  | { readonly type: 'tabs/group-renamed'; readonly groupId: string; readonly title: string }
  /** グループを閉じる */
  | { readonly type: 'tabs/group-close-requested'; readonly groupId: string }
  /** 指定グループに新しいタブを足す (グループの右クリックメニュー) */
  | { readonly type: 'tabs/tab-create-in-group-requested'; readonly groupId: string }
  /** お気に入りからタブを開く */
  | { readonly type: 'tabs/favorite-spawn-requested'; readonly favoriteId: string }
  /** お気に入りを削除する */
  | { readonly type: 'tabs/favorite-remove-requested'; readonly favoriteId: string }
  /** 既定のお気に入りを切り替える (既定なら解除、そうでなければ設定) */
  | { readonly type: 'tabs/favorite-default-toggled'; readonly favoriteId: string }
  /** お気に入りを新規登録する */
  | { readonly type: 'tabs/favorite-added'; readonly favorite: Omit<Favorite, 'id'> }
  /** お気に入りの内容を書き換える */
  | {
      readonly type: 'tabs/favorite-updated';
      readonly favoriteId: string;
      readonly favorite: Omit<Favorite, 'id'>;
    };

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
