import type { AppState } from '../types';

/**
 * グループ本体を drop ターゲットにする際の useDroppable id プレフィックス。
 *
 * 現在のレイアウト（サイドバーはグループ 1 行のみ）では、グループ行の
 * useSortable が登録する droppable（id は**生の groupId**）がそのまま
 * タブの drop ターゲットを兼ねるため、この形式で登録している要素は無い。
 * 過去のレイアウトで使っていた形式を resolveDropTarget / dropGroup が
 * 引き続き解釈できるよう定数として残す。
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
 * F-M6: D&D の kind を表す定数オブジェクトと型。
 *
 * 定義の実体は types/index.ts にある (AppState がドラッグ中の種別を保持するため、
 * types → lib への import になると循環する)。利用側の import 文を変えずに済むよう
 * ここから re-export する。
 */
export { DRAG_KIND, type DragKind } from '../types';

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
 * - **生の `groupId`**: 該当グループの末尾追加。サイドバーのグループ行は
 *   useSortable（グループ並び替え用）の droppable を兼ねており、タブをその行へ
 *   落としたときの over.id はこの形式になる
 * - `'group-{groupId}'` 形式: 同上（過去のレイアウト互換。dropGroup と対称）
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

  // グループ行 (useSortable の droppable) への drop: そのグループの末尾へ追加する
  const overGroup = state.groups.find((g) => g.id === overId);
  if (overGroup) {
    return { toGroupId: overId, toIndex: overGroup.tabIds.length };
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
