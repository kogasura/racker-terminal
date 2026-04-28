import type { AppState } from '../types';

/**
 * GroupBody の useDroppable に渡す id のプレフィックス。
 * Sidebar の handleDragEnd / GroupSection の両方でこの定数を参照して文字列を統一する。
 */
export const GROUP_DROPPABLE_PREFIX = 'group-';

/**
 * GroupSection ヘッダの auto-expand 用 useDroppable id のプレフィックス (B4a)。
 * handleDragEnd でグループ自体への drop と区別するために使用する。
 */
export const GROUP_HEADER_DROPPABLE_PREFIX = 'group-header-';

/**
 * 「新規グループとして drop」エリアの useDroppable id (B4b)。
 */
export const DROP_AS_NEW_GROUP_ID = 'drop-as-new-group';

/**
 * F-M6: D&D の kind を表す定数オブジェクト。
 * リテラル文字列から定数経由に変更することで typo を型レベルで検出できる。
 */
export const DRAG_KIND = {
  TAB: 'tab',
  GROUP: 'group',
  FAVORITE: 'favorite',
} as const;

/**
 * F-M6: D&D の kind 型。DRAG_KIND の値 union から導出する。
 */
export type DragKind = typeof DRAG_KIND[keyof typeof DRAG_KIND];

/**
 * F-M3: 既存グループのタイトルから "New Group N" の最大 N を求め、N+1 のタイトルを返す純関数。
 * 削除→追加による連番崩壊（重複）を防ぐ。
 */
export function nextNewGroupTitle(groups: { title: string }[]): string {
  const maxSuffix = groups
    .map((g) => /^New Group (\d+)$/.exec(g.title)?.[1])
    .reduce((max, s) => (s ? Math.max(max, parseInt(s, 10)) : max), 0);
  return `New Group ${maxSuffix + 1}`;
}

/**
 * dnd-kit の over.id を解析してドロップ先 (toGroupId / toIndex) を決定する純関数。
 *
 * - `'group-header-{groupId}'` 形式: auto-expand 専用のため drop ターゲット外 → null
 * - `'group-{groupId}'` 形式: 該当グループの末尾追加
 * - タブ ID 形式: そのタブの現在位置に挿入
 * - 不整合（グループ消滅・タブ不在・tabIds 内に over タブが存在しない）: null を返す
 *
 * handleDragEnd がこの関数の戻り値を受け取り、null の場合は no-op にする。
 */
export function resolveDropTarget(
  overId: string,
  state: Pick<AppState, 'groups' | 'tabs'>,
): { toGroupId: string; toIndex: number } | null {
  // F-M7: header (auto-expand 専用) は drop ターゲット外
  // 注意: GROUP_HEADER_DROPPABLE_PREFIX ('group-header-') は GROUP_DROPPABLE_PREFIX ('group-') の
  // サブストリングなので、header チェックを先に行う必要がある。
  if (overId.startsWith(GROUP_HEADER_DROPPABLE_PREFIX)) return null;

  if (overId.startsWith(GROUP_DROPPABLE_PREFIX)) {
    const toGroupId = overId.slice(GROUP_DROPPABLE_PREFIX.length);
    const g = state.groups.find((g) => g.id === toGroupId);
    if (!g) return null;
    return { toGroupId, toIndex: g.tabIds.length };
  }

  // タブ ID への drop: そのタブの位置に挿入
  const overTab = state.tabs[overId];
  if (!overTab) return null;
  const g = state.groups.find((gp) => gp.id === overTab.groupId);
  if (!g) return null;
  const idx = g.tabIds.indexOf(overId);
  if (idx === -1) return null;
  return { toGroupId: overTab.groupId, toIndex: idx };
}
