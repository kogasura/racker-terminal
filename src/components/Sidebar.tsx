import { memo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { GroupSection } from './GroupSection';
import { FavoritesSection } from './FavoritesSection';
import {
  resolveDropTarget,
  GROUP_DROPPABLE_PREFIX,
  GROUP_HEADER_DROPPABLE_PREFIX,
  DROP_AS_NEW_GROUP_ID,
  DRAG_KIND,
  type DragKind,
  nextNewGroupTitle,
} from '../lib/dndResolve';
import { getTabDisplayTitle, type TabStatus } from '../types';
import '../styles/sidebar.css';

/** ドラッグ中に Portal 描画される最小プレビュー（status dot + title） */
const STATUS_DOT_CLASS: Record<TabStatus, string> = {
  live: 'tab-item__status-dot tab-item__status-dot--live',
  spawning: 'tab-item__status-dot tab-item__status-dot--spawning',
  crashed: 'tab-item__status-dot tab-item__status-dot--crashed',
};

/** ドラッグプレビュー用に必要な最小タブ情報 */
interface TabPreviewData {
  id: string;
  displayTitle: string;
  status: TabStatus;
}

function TabItemPreview({ tab }: { tab: TabPreviewData }) {
  return (
    <div className="tab-item tab-item--drag-overlay">
      <span className={STATUS_DOT_CLASS[tab.status]} />
      <span className="tab-item__title">{tab.displayTitle}</span>
    </div>
  );
}

/** B1: グループ D&D プレビュー */
function GroupHeaderPreview({ title }: { title: string }) {
  return (
    <div className="group-header group-header--drag-overlay">
      <span className="group-header__drag-handle">⠿</span>
      <span className="group-header__chevron">▼</span>
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

/** B4b: タブドラッグ中のみ表示する「新規グループとして追加」drop エリア */
function DropAsNewGroupArea() {
  const { setNodeRef, isOver } = useDroppable({ id: DROP_AS_NEW_GROUP_ID });
  return (
    <div
      ref={setNodeRef}
      className={`drop-as-new-group${isOver ? ' drop-as-new-group--over' : ''}`}
    >
      + 新規グループに追加
    </div>
  );
}

// F-M6: DragKind 型は dndResolve.ts から import して使用する（型の一元管理）

export const Sidebar = memo(function Sidebar() {
  // beta P1: id 配列のみ subscribe（グループ内の title/collapsed 変化で Sidebar が再レンダーされない）
  // F-M3: nextNewGroupTitle のために groups 全体（title のみ）を subscribe する
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const groupTitles = useAppStore(useShallow((s) => s.groups.map((g) => g.title)));
  const createGroup = useAppStore((s) => s.createGroup);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // B1/B2/B4: ドラッグ中の kind を管理（DropAsNewGroupArea 表示制御・DragOverlay 分岐に使用）
  const [activeDragKind, setActiveDragKind] = useState<DragKind | null>(null);

  // F2: useShallow で id/displayTitle/status の 3 フィールドのみ抽出する。
  // Tab オブジェクト全体を返すと OSC タイトル更新等で Sidebar 全体が再レンダーされ、
  // DndContext の collision 計算が走り直す問題を防ぐ。
  const activeDragTab = useAppStore(
    useShallow((s) => {
      if (!activeDragId || activeDragKind !== DRAG_KIND.TAB) return null;
      const t = s.tabs[activeDragId];
      return t ? { id: t.id, displayTitle: getTabDisplayTitle(t), status: t.status } : null;
    }),
  );

  // B1: ドラッグ中のグループタイトルを取得（DragOverlay 用）
  const activeDragGroupTitle = useAppStore(
    useShallow((s) => {
      if (!activeDragId || activeDragKind !== DRAG_KIND.GROUP) return null;
      const g = s.groups.find((g) => g.id === activeDragId);
      return g ? g.title : null;
    }),
  );

  // B2: ドラッグ中のお気に入りタイトルを取得（DragOverlay 用）
  const activeDragFavoriteTitle = useAppStore(
    useShallow((s) => {
      if (!activeDragId || activeDragKind !== DRAG_KIND.FAVORITE) return null;
      const f = s.favorites.find((f) => f.id === activeDragId);
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
    setActiveDragId(id);
    setActiveDragKind(kind ?? null);
    // InlineEdit が編集中なら確定 or キャンセルして D&D を優先する
    // 注意: GroupSection の useSortable に disabled: isEditingGroup を追加済み (F-M4) のため、
    // グループ編集中はここに到達しないが、タブ編集中のケースでは引き続き stopEditing が有効。
    useAppStore.getState().stopEditing();
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    setActiveDragKind(null);

    const { active, over } = event;
    if (!over) return;
    // 同一要素上での drop は no-op（group sentinel 上の drop は別経路で末尾追加扱い）
    if (active.id === over.id) return;

    // F-M6: DragKind 型（dndResolve.ts 由来）でキャスト
    const activeKind = active.data.current?.kind as DragKind | undefined;

    if (activeKind === DRAG_KIND.GROUP) {
      // B1: グループ自体の並び替え
      const overIdStr = over.id as string;

      // F-M1: header (auto-expand 専用) は並び替え対象外
      // 注意: 'group-header-' は 'group-' のサブストリングなので header チェックを先に行う
      if (overIdStr.startsWith(GROUP_HEADER_DROPPABLE_PREFIX)) return;

      // F-M1: 'group-{id}' (GroupBody) でも生 groupId でもターゲット解決可能にする
      const overGroupId = overIdStr.startsWith(GROUP_DROPPABLE_PREFIX)
        ? overIdStr.slice(GROUP_DROPPABLE_PREFIX.length)
        : overIdStr;

      const groupId = active.id as string;
      const groups = useAppStore.getState().groups;
      const toIdx = groups.findIndex((g) => g.id === overGroupId);
      if (toIdx === -1) return;
      useAppStore.getState().moveGroup(groupId, toIdx);

    } else if (activeKind === DRAG_KIND.FAVORITE) {
      // B2: お気に入りの並び替え
      const favId = active.id as string;
      const overFavId = over.id as string;
      const favorites = useAppStore.getState().favorites;
      const toIdx = favorites.findIndex((f) => f.id === overFavId);
      if (toIdx === -1) return;
      useAppStore.getState().moveFavorite(favId, toIdx);

    } else {
      // tab の D&D（既存ロジック）
      const activeTabId = active.id as string;
      const fromGroupId = active.data.current?.groupId as string | undefined;
      if (!fromGroupId) return;

      const overIdStr = over.id as string;

      // B4b: 新規グループとして drop
      if (over.id === DROP_AS_NEW_GROUP_ID) {
        // F-M3: max suffix + 1 で連番崩壊を防ぐ
        const newTitle = nextNewGroupTitle(useAppStore.getState().groups);
        const newGroupId = useAppStore.getState().createGroup(newTitle);
        useAppStore.getState().moveTab(activeTabId, newGroupId, 0);
        return;
      }

      // F-M5: 折りたたみグループのヘッダに drop された場合、即時展開して操作をユーザーに委ねる
      if (overIdStr.startsWith(GROUP_HEADER_DROPPABLE_PREFIX)) {
        const targetGroupId = overIdStr.slice(GROUP_HEADER_DROPPABLE_PREFIX.length);
        const g = useAppStore.getState().groups.find((g) => g.id === targetGroupId);
        if (g?.collapsed) useAppStore.getState().toggleCollapse(targetGroupId);
        return;
      }

      const target = resolveDropTarget(overIdStr, useAppStore.getState());
      if (!target) return;
      useAppStore.getState().moveTab(activeTabId, target.toGroupId, target.toIndex);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="sidebar">
        <div className="sidebar__scroll-area">
          {/* B2: FavoritesSection 内で SortableContext を自己管理しているため、ここでは直接配置 */}
          <FavoritesSection />

          {/* B1: グループ用 SortableContext */}
          <SortableContext
            id="groups-sortable"
            items={groupIds}
            strategy={verticalListSortingStrategy}
          >
            {groupIds.map((groupId) => (
              <GroupSection
                key={groupId}
                groupId={groupId}
              />
            ))}
          </SortableContext>
        </div>

        <div className="sidebar__footer">
          {/* B4b: タブドラッグ中のみ「新規グループとして追加」drop エリアを表示 */}
          {activeDragKind === DRAG_KIND.TAB && <DropAsNewGroupArea />}

          {/* F3: type="button" 追加 / F-M3: nextNewGroupTitle で連番崩壊を防ぐ */}
          <button
            type="button"
            className="sidebar__new-group-btn"
            onClick={() => createGroup(nextNewGroupTitle(groupTitles.map((t) => ({ title: t }))))}
          >
            + New Group
          </button>
        </div>
      </div>

      {/* DragOverlay: sidebar の overflow に影響されないよう body に Portal 描画 */}
      {createPortal(
        <DragOverlay>
          {activeDragKind === DRAG_KIND.TAB && activeDragTab && (
            <TabItemPreview tab={activeDragTab} />
          )}
          {activeDragKind === DRAG_KIND.GROUP && activeDragGroupTitle && (
            <GroupHeaderPreview title={activeDragGroupTitle} />
          )}
          {activeDragKind === DRAG_KIND.FAVORITE && activeDragFavoriteTitle && (
            <FavoriteItemPreview title={activeDragFavoriteTitle} />
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
});

