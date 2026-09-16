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

/** View から上がる操作。 */
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
 * 入力モードの変化。
 *
 * コンテキストメニューが開いている間はキーコマンドを止める。以前は store の
 * `contextMenuOpen` を各所から書き換え、キーハンドラが `getState()` で覗いていた。
 * 表示されているメニューとキー入力の可否は同じ 1 つの関心なので、Mediator に集めた。
 */
export type TabsModeChange =
  | { readonly type: 'tabs/context-menu-opened' }
  | { readonly type: 'tabs/context-menu-closed' };

export type TabsEvent = TabsIntent | TabsModeChange;

/** チェーンに流せることを型で確かめておく。 */
const _assertChainEvent: ChainEvent = { type: 'tabs/restore-requested' } satisfies TabsEvent;
void _assertChainEvent;
