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
import { type DragKind } from '../lib/dndResolve';
import { useEmit } from '../architecture/chain';
import { useDragOverlayView } from '../features/tabs/TabsRoot';
import type { TabsEvent } from '../features/tabs/events';

/** ドラッグ中に Portal 描画される最小プレビュー（status dot + title） */
function TabItemPreview({ tab }: { tab: { displayTitle: string; statusClass: string } }) {
  return (
    <div className="tab-item tab-item--drag-overlay">
      {/* ドットの class は View モデル側で TabItem と同じ規則で組み立てている */}
      <span className={tab.statusClass} />
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
  const overlay = useDragOverlayView();
  const emit = useEmit<TabsEvent>();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 8px 未満の微小移動では D&D を起動しない（誤発火防止）
      activationConstraint: { distance: 8 },
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    emit({
      type: 'tabs/drag-started',
      dragId: event.active.id as string,
      // F-M6: DragKind 型（dndResolve.ts 由来）でキャスト
      kind: (event.active.data.current?.kind as DragKind | undefined) ?? null,
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    emit({
      type: 'tabs/drag-ended',
      overId: over ? (over.id as string) : null,
      fromGroupId: active.data.current?.groupId as string | undefined,
    });
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
          {overlay.tab && <TabItemPreview tab={overlay.tab} />}
          {overlay.groupTitle && <GroupHeaderPreview title={overlay.groupTitle} />}
          {overlay.favoriteTitle && <FavoriteItemPreview title={overlay.favoriteTitle} />}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
});
