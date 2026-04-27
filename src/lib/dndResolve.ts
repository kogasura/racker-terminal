import type { AppState } from '../types';

/**
 * GroupBody の useDroppable に渡す id のプレフィックス。
 * Sidebar の handleDragEnd / GroupSection の両方でこの定数を参照して文字列を統一する。
 */
export const GROUP_DROPPABLE_PREFIX = 'group-';

/**
 * dnd-kit の over.id を解析してドロップ先 (toGroupId / toIndex) を決定する純関数。
 *
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
