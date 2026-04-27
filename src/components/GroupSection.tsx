import { memo } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { TabItem } from './TabItem';
import { InlineEdit } from './InlineEdit';

interface GroupSectionProps {
  groupId: string;
}

/**
 * グループ本体の droppable ラッパー。
 * 空グループへのドロップや、タブリスト下部への drop を受け付ける。
 * id は "group-{groupId}" 形式で Sidebar の onDragEnd から参照する。
 */
function GroupBody({ groupId, children }: { groupId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group-${groupId}` });
  return (
    <div
      ref={setNodeRef}
      className={`group-body${isOver ? ' group-body--drop-over' : ''}`}
    >
      {children}
    </div>
  );
}

export const GroupSection = memo(function GroupSection({
  groupId,
}: GroupSectionProps) {
  // M1: useShallow で必要フィールドのみ抽出（他グループの mutation による不要再レンダーを防ぐ）
  const groupView = useAppStore(
    useShallow((s) => {
      const g = s.groups.find((x) => x.id === groupId);
      return g
        ? { title: g.title, collapsed: g.collapsed, tabIds: g.tabIds }
        : null;
    }),
  );
  const activeTabId = useAppStore((s) => s.activeTabId);
  // M3: boolean だけ subscribe することで、自分以外の editingId 変化による再レンダーを防ぐ
  const isEditingGroup = useAppStore((s) => s.editingId === groupId);
  const createTab = useAppStore((s) => s.createTab);
  const removeGroup = useAppStore((s) => s.removeGroup);
  const toggleCollapse = useAppStore((s) => s.toggleCollapse);
  const startEditing = useAppStore((s) => s.startEditing);
  const updateGroupTitle = useAppStore((s) => s.updateGroupTitle);
  const setContextMenuOpen = useAppStore((s) => s.setContextMenuOpen);
  // F2: prop drilling 解消 — Sidebar から groupsCount を受け取らず直接 subscribe
  const canDelete = useAppStore((s) => s.groups.length > 1);

  if (!groupView) return null;

  const { title, collapsed, tabIds } = groupView;
  const isEmpty = tabIds.length === 0;

  // グループ削除可能条件: タブが空 + グループが 2 個以上
  const canDeleteGroup = isEmpty && canDelete;

  const handleToggle = () => {
    // 編集中はトグルを無効化
    if (isEditingGroup) return;
    toggleCollapse(groupId);
  };

  function handleGroupDoubleClick(e: React.MouseEvent) {
    // 編集中のダブルクリックは無視
    if (isEditingGroup) return;
    // chevron のクリックはトグルに任せるため、ここでは stopPropagation しない
    e.stopPropagation();
    startEditing(groupId);
  }

  function handleGroupCommit(newTitle: string) {
    updateGroupTitle(groupId, newTitle);
  }

  return (
    <div>
      <ContextMenu.Root onOpenChange={(open) => setContextMenuOpen(open)}>
        {/* 編集中は右クリックメニューを無効化する */}
        <ContextMenu.Trigger
          disabled={isEditingGroup}
          asChild
        >
          {/* F1: グループヘッダを role="button" + onKeyDown で a11y 化 */}
          <div
            className="group-header"
            role="button"
            tabIndex={0}
            onClick={handleToggle}
            // N14: Radix の disabled が効かないバージョン互換性対策として onContextMenu も抑制する
            onContextMenu={isEditingGroup ? (e) => e.preventDefault() : undefined}
            onKeyDown={(e) => {
              if (isEditingGroup) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleToggle();
              }
            }}
          >
            <span className="group-header__chevron">{collapsed ? '▶' : '▼'}</span>

            <InlineEdit
              id={groupId}
              title={title}
              onCommit={handleGroupCommit}
              className="group-header__title"
            />

            {/* グループ名のダブルクリックで編集モードに入る（表示モードのみ） */}
            {!isEditingGroup && (
              <span
                className="group-header__dblclick-overlay"
                onDoubleClick={handleGroupDoubleClick}
                aria-hidden="true"
              />
            )}

            {/* F3: type="button" 追加 */}
            <button
              type="button"
              className="group-header__delete-btn"
              title="Delete group"
              disabled={!canDeleteGroup}
              onClick={(e) => {
                e.stopPropagation();
                removeGroup(groupId);
              }}
            >
              ×
            </button>
          </div>
        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => startEditing(groupId)}
            >
              リネーム
            </ContextMenu.Item>

            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => createTab(groupId)}
            >
              新規タブを追加
            </ContextMenu.Item>

            <ContextMenu.Separator className="context-menu__separator" />

            <ContextMenu.Item
              className="context-menu__item context-menu__item--danger"
              disabled={!canDeleteGroup}
              onSelect={() => removeGroup(groupId)}
            >
              グループを閉じる
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {/* グループ本体（折りたたみ時は非表示） */}
      {!collapsed && (
        // GroupBody: useDroppable で空グループや末尾へのドロップを受け付ける
        <GroupBody groupId={groupId}>
          {/* SortableContext: 各タブを sortable にする */}
          <SortableContext items={tabIds} strategy={verticalListSortingStrategy}>
            {tabIds.map((tabId) => (
              <TabItem
                key={tabId}
                tabId={tabId}
                isActive={tabId === activeTabId}
              />
            ))}
          </SortableContext>

          {/* "+ Add Tab" インラインボタン（常に末尾に表示） */}
          {/* F3: type="button" 追加 */}
          <button
            type="button"
            className="group-add-tab-btn"
            onClick={() => createTab(groupId)}
          >
            + Add Tab
          </button>
        </GroupBody>
      )}
    </div>
  );
});
