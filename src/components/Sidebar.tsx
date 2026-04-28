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
import { resolveDropTarget } from '../lib/dndResolve';
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

export const Sidebar = memo(function Sidebar() {
  // beta P1: id 配列のみ subscribe（グループ内の title/collapsed 変化で Sidebar が再レンダーされない）
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const groupsCount = groupIds.length;
  const createGroup = useAppStore((s) => s.createGroup);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // F2: useShallow で id/displayTitle/status の 3 フィールドのみ抽出する。
  // Tab オブジェクト全体を返すと OSC タイトル更新等で Sidebar 全体が再レンダーされ、
  // DndContext の collision 計算が走り直す問題を防ぐ。
  const activeDragTab = useAppStore(
    useShallow((s) => {
      if (!activeDragId) return null;
      const t = s.tabs[activeDragId];
      return t ? { id: t.id, displayTitle: getTabDisplayTitle(t), status: t.status } : null;
    }),
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
    // 同一タブ上での drop（実質的な移動なし）を弾く。group sentinel 上の drop は別経路で末尾追加扱い。
    if (active.id === over.id) return;

    const activeTabId = active.id as string;
    const fromGroupId = active.data.current?.groupId as string | undefined;
    if (!fromGroupId) return;

    const target = resolveDropTarget(over.id as string, useAppStore.getState());
    if (!target) return;
    useAppStore.getState().moveTab(activeTabId, target.toGroupId, target.toIndex);
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

