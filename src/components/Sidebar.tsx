import { memo, useState } from 'react';
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
import { GroupSection } from './GroupSection';
import { FavoritesSection } from './FavoritesSection';
import type { Tab, TabStatus } from '../types';
import '../styles/sidebar.css';

/** ドラッグ中に Portal 描画される最小プレビュー（status dot + title） */
const STATUS_DOT_CLASS: Record<TabStatus, string> = {
  live: 'tab-item__status-dot tab-item__status-dot--live',
  spawning: 'tab-item__status-dot tab-item__status-dot--spawning',
  crashed: 'tab-item__status-dot tab-item__status-dot--crashed',
};

function TabItemPreview({ tab }: { tab: Tab }) {
  return (
    <div className="tab-item tab-item--drag-overlay">
      <span className={STATUS_DOT_CLASS[tab.status]} />
      <span className="tab-item__title">{tab.title}</span>
    </div>
  );
}

export const Sidebar = memo(function Sidebar() {
  // beta P1: id 配列のみ subscribe（グループ内の title/collapsed 変化で Sidebar が再レンダーされない）
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const groupsCount = groupIds.length;
  const createGroup = useAppStore((s) => s.createGroup);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // activeDragId が変わった時のみ再 subscribe（null 時は null を返す selector）
  const activeDragTab = useAppStore((s) =>
    activeDragId ? s.tabs[activeDragId] : null,
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 8px 未満の微小移動では D&D を起動しない（誤発火防止）
      activationConstraint: { distance: 8 },
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(event.active.id as string);
    // InlineEdit が編集中なら確定 or キャンセルして D&D を優先する
    useAppStore.getState().stopEditing();
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);

    const { active, over } = event;
    if (!over) return;
    if (active.id === over.id) return;

    const activeTabId = active.id as string;
    const fromGroupId = active.data.current?.groupId as string | undefined;
    if (!fromGroupId) return;

    const overId = over.id as string;
    let toGroupId: string;
    let toIndex: number;

    if (overId.startsWith('group-')) {
      // グループ全体の droppable への drop = 末尾追加
      toGroupId = overId.replace(/^group-/, '');
      const g = useAppStore.getState().groups.find((g) => g.id === toGroupId);
      toIndex = g?.tabIds.length ?? 0;
    } else {
      // 別タブへの drop = そのタブの位置に挿入
      const overTabId = overId;
      const state = useAppStore.getState();
      const overTab = state.tabs[overTabId];
      if (!overTab) return;
      toGroupId = overTab.groupId;
      const g = state.groups.find((g) => g.id === toGroupId);
      if (!g) return;
      toIndex = g.tabIds.indexOf(overTabId);
    }

    useAppStore.getState().moveTab(activeTabId, toGroupId, toIndex);
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
          {/* Favorites セクションはグループ一覧の上部に表示する */}
          <FavoritesSection />

          {groupIds.map((groupId) => (
            <GroupSection
              key={groupId}
              groupId={groupId}
            />
          ))}
        </div>

        <div className="sidebar__footer">
          {/* F3: type="button" 追加 / F6: 連番タイトル化 */}
          <button
            type="button"
            className="sidebar__new-group-btn"
            onClick={() => createGroup(`New Group ${groupsCount + 1}`)}
          >
            + New Group
          </button>
        </div>
      </div>

      {/* DragOverlay: sidebar の overflow に影響されないよう body に Portal 描画 */}
      {createPortal(
        <DragOverlay>
          {activeDragTab && <TabItemPreview tab={activeDragTab} />}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
});
