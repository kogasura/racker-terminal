import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { InlineEdit } from './InlineEdit';
import { GROUP_DROPPABLE_PREFIX, DRAG_KIND } from '../lib/dndResolve';
import { AGENT_STATE_LABEL, dominantAgentState, type AgentState } from '../types';

interface GroupSectionProps {
  groupId: string;
}

/** グループ行の className。選択中と drop ホバーで見た目を変える。 */
function groupHeaderClassName(isActive: boolean, isOver: boolean): string {
  return (
    'group-header' +
    (isActive ? ' group-header--active' : '') +
    (isOver ? ' group-header--drop-hover' : '')
  );
}

/**
 * 配下タブの代表エージェント状態のインジケータ。
 *
 * 'idle' と未検出は描画しない（動きのないグループを装飾しない）。
 * herdr の "A blocked agent makes its pane, tab, and workspace look blocked" 相当。
 */
function GroupAgentIndicator({ agentState }: { agentState: AgentState | undefined }) {
  if (agentState === undefined || agentState === 'idle') return null;
  return (
    <span
      className={`group-header__agent group-header__agent--${agentState}`}
      title={AGENT_STATE_LABEL[agentState]}
      aria-label={`${AGENT_STATE_LABEL[agentState]}のタブがあります`}
    />
  );
}

/**
 * サイドバーのグループ 1 行（フォルダ）。
 *
 * 配下のタブはここには描画しない。グループを選択すると、そのグループのタブが
 * 上部の TabBar に横並びで表示される。タブが見えなくなる代わりに、
 * 配下タブの代表エージェント状態とタブ数をこの行に集約して表示する。
 *
 * この行自体が drop ターゲット (`group-{id}`) を兼ねており、TabBar から
 * タブをここへドロップすると、そのグループの末尾へ移動する。
 */
export const GroupSection = memo(function GroupSection({
  groupId,
}: GroupSectionProps) {
  // M1: useShallow で必要フィールドのみ抽出（他グループの mutation による不要再レンダーを防ぐ）
  const groupView = useAppStore(
    useShallow((s) => {
      const g = s.groups.find((x) => x.id === groupId);
      if (!g) return null;
      // 配下タブの代表エージェント状態（優先度: blocked > working > done > idle）。
      // タブ自体がサイドバーに見えないため、グループ単位での集約表示が
      // 「どのフォルダが応答待ちか」を知る唯一の手がかりになる。
      const agentState = dominantAgentState(g.tabIds.map((id) => s.tabs[id]?.agentState));
      return {
        title: g.title,
        tabCount: g.tabIds.length,
        agentState,
        isActive: s.activeGroupId === groupId,
      };
    }),
  );
  // M3: boolean だけ subscribe することで、自分以外の editingId 変化による再レンダーを防ぐ
  const isEditingGroup = useAppStore((s) => s.editingId === groupId);
  const createTab = useAppStore((s) => s.createTab);
  const removeGroup = useAppStore((s) => s.removeGroup);
  const setActiveGroup = useAppStore((s) => s.setActiveGroup);
  const startEditing = useAppStore((s) => s.startEditing);
  const updateGroupTitle = useAppStore((s) => s.updateGroupTitle);
  const setContextMenuOpen = useAppStore((s) => s.setContextMenuOpen);
  // F2: prop drilling 解消 — Sidebar から groupsCount を受け取らず直接 subscribe
  const canDelete = useAppStore((s) => s.groups.length > 1);

  // B1: グループ自体を D&D 並び替え可能にする（kind=group でタブ用と区別）
  // F-M4: 編集中 (isEditingGroup) は D&D を無効化する（stopEditing が未確定入力を確定してしまうため）
  const {
    attributes: groupAttributes,
    listeners: groupListeners,
    setNodeRef: setGroupNodeRef,
    transform: groupTransform,
    transition: groupTransition,
    isDragging: isGroupDragging,
  } = useSortable({ id: groupId, data: { kind: DRAG_KIND.GROUP }, disabled: isEditingGroup });

  const groupStyle = {
    transform: CSS.Transform.toString(groupTransform),
    transition: groupTransition,
  };

  // タブをこの行にドロップするとグループ末尾へ移動する (resolveDropTarget が解決する)
  const { setNodeRef: setRowDropRef, isOver } = useDroppable({
    id: `${GROUP_DROPPABLE_PREFIX}${groupId}`,
  });

  if (!groupView) return null;

  const { title, tabCount, agentState, isActive } = groupView;

  // グループ削除可能条件: タブが空 + グループが 2 個以上
  const canDeleteGroup = tabCount === 0 && canDelete;

  const handleSelect = () => {
    // 編集中は選択操作を無効化
    if (isEditingGroup) return;
    setActiveGroup(groupId);
  };

  function handleGroupDoubleClick(e: React.MouseEvent) {
    // 編集中のダブルクリックは無視
    if (isEditingGroup) return;
    e.stopPropagation();
    startEditing(groupId);
  }

  function handleGroupCommit(newTitle: string) {
    updateGroupTitle(groupId, newTitle);
  }

  return (
    // setGroupNodeRef: グループ全体を sortable 要素として登録する
    // F-M2: className="group-section-wrapper" を追加（[data-dragging].group-section-wrapper CSS selector が機能するように）
    <div
      ref={setGroupNodeRef}
      className="group-section-wrapper"
      style={groupStyle}
      data-dragging={isGroupDragging || undefined}
    >
      <ContextMenu.Root onOpenChange={(open) => setContextMenuOpen(open)}>
        {/* 編集中は右クリックメニューを無効化する */}
        <ContextMenu.Trigger
          disabled={isEditingGroup}
          asChild
        >
          {/* F1: グループ行を role="button" + onKeyDown で a11y 化 */}
          {/* setRowDropRef: タブのグループ間移動を受け付ける drop ターゲット */}
          <div
            ref={setRowDropRef}
            className={groupHeaderClassName(isActive, isOver)}
            role="button"
            tabIndex={0}
            aria-current={isActive ? 'true' : undefined}
            onClick={handleSelect}
            // N14: Radix の disabled が効かないバージョン互換性対策として onContextMenu も抑制する
            onContextMenu={isEditingGroup ? (e) => e.preventDefault() : undefined}
            onKeyDown={(e) => {
              if (isEditingGroup) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSelect();
              }
            }}
          >
            {/* B1: グループドラッグハンドル（左端の grip area）— listeners を限定してクリックと共存 */}
            <span
              className="group-header__drag-handle"
              {...groupAttributes}
              {...groupListeners}
              title="ドラッグしてグループを並び替え"
              aria-label="グループを並び替え"
              // ドラッグハンドルのクリックがグループ選択に伝播しないよう停止
              onClick={(e) => e.stopPropagation()}
            >
              ⠿
            </span>

            <GroupAgentIndicator agentState={agentState} />

            <InlineEdit
              id={groupId}
              title={title}
              onCommit={handleGroupCommit}
              className="group-header__title"
            />

            {/* タブがサイドバーに見えないぶん、本数だけは常に示しておく */}
            <span className="group-header__count" aria-label={`${tabCount} タブ`}>
              {tabCount}
            </span>

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
    </div>
  );
});
