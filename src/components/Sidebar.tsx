import { memo, useState } from 'react';
import { SettingsDialog } from './SettingsDialog';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { GroupSection } from './GroupSection';
import { FavoritesSection } from './FavoritesSection';
import { OpenFolderButton } from './OpenFolderButton';
import { DROP_AS_NEW_GROUP_ID, DRAG_KIND, nextNewGroupTitle } from '../lib/dndResolve';
import '../styles/sidebar.css';

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

/**
 * 左サイドバー。グループ（フォルダ）の一覧とお気に入りを縦に並べる。
 *
 * タブはここには並ばない。選択中グループのタブは上部の TabBar が横に並べる。
 * D&D の DndContext は App 直下の DragDropProvider が持つ（TabBar から
 * サイドバーのグループ行へドロップできるようにするため）。
 */
export const Sidebar = memo(function Sidebar() {
  // beta P1: id 配列のみ subscribe（グループ内の title 変化で Sidebar が再レンダーされない）
  // F-M3: nextNewGroupTitle のために groups 全体（title のみ）を subscribe する
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const groupTitles = useAppStore(useShallow((s) => s.groups.map((g) => g.title)));
  const createGroup = useAppStore((s) => s.createGroup);
  const setActiveGroup = useAppStore((s) => s.setActiveGroup);
  // タブをドラッグ中のときだけ「新規グループとして追加」エリアを出す
  const isDraggingTab = useAppStore((s) => s.dragKind === DRAG_KIND.TAB);

  // B3: Settings Dialog の開閉状態
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
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
        {isDraggingTab && <DropAsNewGroupArea />}

        <div className="sidebar__footer-buttons">
          {/* F3: type="button" 追加 / F-M3: nextNewGroupTitle で連番崩壊を防ぐ */}
          <button
            type="button"
            className="sidebar__new-group-btn"
            onClick={() => {
              const id = createGroup(nextNewGroupTitle(groupTitles.map((t) => ({ title: t }))));
              // 作ったグループをそのまま選択する。選択が前のグループに残っていると、
              // 直後の Ctrl+T / タイトルバーの + が古いグループにタブを作ってしまう。
              setActiveGroup(id);
            }}
          >
            + New Group
          </button>
          {/* フォルダを選んで臨時のタブを開く（Windows / WSL 両対応） */}
          <OpenFolderButton />
          {/* B3: Settings ボタン */}
          <button
            type="button"
            className="sidebar__settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>

        {/* B3: Settings Dialog */}
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </div>
    </div>
  );
});
