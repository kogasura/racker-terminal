import { memo } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import {
  resolveDropTarget,
  GROUP_DROPPABLE_PREFIX,
  GROUP_HEADER_DROPPABLE_PREFIX,
  DROP_AS_NEW_GROUP_ID,
  DRAG_KIND,
  type DragKind,
  nextNewGroupTitle,
} from '../lib/dndResolve';
import { getTabDisplayTitle, type AgentState, type TabStatus } from '../types';
import { statusDotClassName } from './TabItem';

/** B1: グループ自体の並び替え。
 * テスト容易性のため export する。 */
export function dropGroup(groupId: string, overIdStr: string): void {
  // F-M1: header (auto-expand 専用) は並び替え対象外
  // 注意: 'group-header-' は 'group-' のサブストリングなので header チェックを先に行う
  if (overIdStr.startsWith(GROUP_HEADER_DROPPABLE_PREFIX)) return;

  // F-M1: 'group-{id}' (droppable) でも生 groupId でもターゲット解決可能にする
  const overGroupId = overIdStr.startsWith(GROUP_DROPPABLE_PREFIX)
    ? overIdStr.slice(GROUP_DROPPABLE_PREFIX.length)
    : overIdStr;

  const toIdx = useAppStore.getState().groups.findIndex((g) => g.id === overGroupId);
  if (toIdx === -1) return;
  useAppStore.getState().moveGroup(groupId, toIdx);
}

/** B2: お気に入りの並び替え。
 * テスト容易性のため export する。 */
export function dropFavorite(favId: string, overFavId: string): void {
  const toIdx = useAppStore.getState().favorites.findIndex((f) => f.id === overFavId);
  if (toIdx === -1) return;
  useAppStore.getState().moveFavorite(favId, toIdx);
}

/** タブの D&D。グループ間移動と、新規グループとしての drop (B4b) を扱う。
 * テスト容易性のため export する。 */
export function dropTab(active: DragEndEvent['active'], overIdStr: string): void {
  const activeTabId = active.id as string;
  const fromGroupId = active.data.current?.groupId as string | undefined;
  if (!fromGroupId) return;

  // B4b: 新規グループとして drop
  if (overIdStr === DROP_AS_NEW_GROUP_ID) {
    // F-M3: max suffix + 1 で連番崩壊を防ぐ
    const newTitle = nextNewGroupTitle(useAppStore.getState().groups);
    const newGroupId = useAppStore.getState().createGroup(newTitle);
    useAppStore.getState().moveTab(activeTabId, newGroupId, 0);
    return;
  }

  const target = resolveDropTarget(overIdStr, useAppStore.getState());
  if (!target) return;
  useAppStore.getState().moveTab(activeTabId, target.toGroupId, target.toIndex);
}

/** ドラッグプレビュー用に必要な最小タブ情報 */
interface TabPreviewData {
  id: string;
  displayTitle: string;
  status: TabStatus;
  agentState?: AgentState;
}

/** ドラッグ中に Portal 描画される最小プレビュー（status dot + title） */
function TabItemPreview({ tab }: { tab: TabPreviewData }) {
  return (
    <div className="tab-item tab-item--drag-overlay">
      {/* ドットの class 生成は TabItem と共有する（見た目を一致させるため） */}
      <span className={statusDotClassName(tab.status, tab.agentState)} />
      <span className="tab-item__title">{tab.displayTitle}</span>
    </div>
  );
}

/** B1: グループ D&D プレビュー */
function GroupHeaderPreview({ title }: { title: string }) {
  return (
    <div className="group-header group-header--drag-overlay">
      <span className="group-header__drag-handle">⠿</span>
      <span className="group-header__title">{title}</span>
    </div>
  );
}

/** B2: お気に入り D&D プレビュー */
function FavoriteItemPreview({ title }: { title: string }) {
  return (
    <div className="favorite-item favorite-item--drag-overlay">
      <span className="favorite-item__icon">★</span>
      <span className="favorite-item__title">{title}</span>
    </div>
  );
}

/**
 * アプリ全体の D&D を受け持つ Provider。
 *
 * **Sidebar ではなく App 直下に置く理由:** タブは横タブバー (TabBar) に並び、
 * グループはサイドバーに並ぶ。「TabBar のタブをサイドバーのグループ行へドロップして
 * 別グループへ移す」操作を成立させるには、両者が同一の DndContext に属している
 * 必要がある。
 *
 * ドラッグ中の id / kind は store (dragId / dragKind) に置く。Sidebar の
 * 「新規グループとして追加」エリアなど、離れた位置のコンポーネントが
 * ドラッグ中かどうかを購読する必要があるため。
 */
export const DragDropProvider = memo(function DragDropProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const dragId = useAppStore((s) => s.dragId);
  const dragKind = useAppStore((s) => s.dragKind);

  // F2: useShallow で id/displayTitle/status/agentState の 4 フィールドのみ抽出する。
  // Tab オブジェクト全体を返すと OSC タイトル更新等で再レンダーされ、
  // DndContext の collision 計算が走り直す問題を防ぐ。
  const activeDragTab = useAppStore(
    useShallow((s) => {
      if (!dragId || dragKind !== DRAG_KIND.TAB) return null;
      const t = s.tabs[dragId];
      return t
        ? {
            id: t.id,
            displayTitle: getTabDisplayTitle(t),
            status: t.status,
            agentState: t.agentState,
          }
        : null;
    }),
  );

  // B1: ドラッグ中のグループタイトルを取得（DragOverlay 用）
  const activeDragGroupTitle = useAppStore(
    useShallow((s) => {
      if (!dragId || dragKind !== DRAG_KIND.GROUP) return null;
      const g = s.groups.find((g) => g.id === dragId);
      return g ? g.title : null;
    }),
  );

  // B2: ドラッグ中のお気に入りタイトルを取得（DragOverlay 用）
  const activeDragFavoriteTitle = useAppStore(
    useShallow((s) => {
      if (!dragId || dragKind !== DRAG_KIND.FAVORITE) return null;
      const f = s.favorites.find((f) => f.id === dragId);
      return f ? f.title : null;
    }),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 8px 未満の微小移動では D&D を起動しない（誤発火防止）
      activationConstraint: { distance: 8 },
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
    // F-M6: DragKind 型（dndResolve.ts 由来）でキャスト
    const kind = event.active.data.current?.kind as DragKind | undefined;
    useAppStore.getState().setDragState(id, kind ?? null);
    // InlineEdit が編集中なら確定 or キャンセルして D&D を優先する
    // 注意: GroupSection の useSortable に disabled: isEditingGroup を追加済み (F-M4) のため、
    // グループ編集中はここに到達しないが、タブ編集中のケースでは引き続き stopEditing が有効。
    useAppStore.getState().stopEditing();
  }

  function handleDragEnd(event: DragEndEvent) {
    useAppStore.getState().setDragState(null, null);

    const { active, over } = event;
    if (!over) return;
    // 同一要素上での drop は no-op（group sentinel 上の drop は別経路で末尾追加扱い）
    if (active.id === over.id) return;

    // F-M6: DragKind 型（dndResolve.ts 由来）でキャスト
    const activeKind = active.data.current?.kind as DragKind | undefined;
    const overIdStr = over.id as string;

    if (activeKind === DRAG_KIND.GROUP) {
      dropGroup(active.id as string, overIdStr);
    } else if (activeKind === DRAG_KIND.FAVORITE) {
      dropFavorite(active.id as string, overIdStr);
    } else {
      dropTab(active, overIdStr);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {children}

      {/* DragOverlay: sidebar / tab bar の overflow に影響されないよう body に Portal 描画 */}
      {createPortal(
        <DragOverlay>
          {dragKind === DRAG_KIND.TAB && activeDragTab && (
            <TabItemPreview tab={activeDragTab} />
          )}
          {dragKind === DRAG_KIND.GROUP && activeDragGroupTitle && (
            <GroupHeaderPreview title={activeDragGroupTitle} />
          )}
          {dragKind === DRAG_KIND.FAVORITE && activeDragFavoriteTitle && (
            <FavoriteItemPreview title={activeDragFavoriteTitle} />
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
});
