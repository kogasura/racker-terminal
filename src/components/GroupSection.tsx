import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useEmit } from '../architecture/chain';
import type { TabsEvent } from '../features/tabs/events';
import { useGroupView } from '../features/tabs/TabsRoot';
import { InlineEdit } from './InlineEdit';
import { DRAG_KIND } from '../lib/dndResolve';
import { AGENT_STATE_LABEL, type AgentState } from '../types';

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
 * この行自体が drop ターゲットを兼ねており、TabBar からタブをここへドロップ
 * すると、そのグループの末尾へ移動する。drop 先は useSortable が登録する
 * droppable（id は生の groupId）に一本化してある: 同じ矩形に別 id の
 * useDroppable を重ねると、dnd-kit の closestCorners が同点になり、
 * 先に登録された sortable 側が常に over になってタブの drop が
 * 解決できなくなるため（resolveDropTarget 参照）。
 */
export const GroupSection = memo(function GroupSection({
  groupId,
}: GroupSectionProps) {
  const vm = useGroupView(groupId);
  // メニューの開閉は tabs の Mediator に伝える (開いている間はキーコマンドが止まる)
  const emit = useEmit<TabsEvent>();
  const isEditingGroup = vm.isEditing;
  const isDraggingTab = vm.isDraggingTab;

  // B1: グループ自体を D&D 並び替え可能にする（kind=group でタブ用と区別）
  // F-M4: 編集中 (isEditingGroup) は D&D を無効化する（stopEditing が未確定入力を確定してしまうため）
  const {
    attributes: groupAttributes,
    listeners: groupListeners,
    setNodeRef: setGroupNodeRef,
    transform: groupTransform,
    transition: groupTransition,
    isDragging: isGroupDragging,
    // タブをこの行にドロップするとグループ末尾へ移動する (resolveDropTarget が解決する)
    isOver,
  } = useSortable({ id: groupId, data: { kind: DRAG_KIND.GROUP }, disabled: isEditingGroup });

  const groupStyle = {
    transform: CSS.Transform.toString(groupTransform),
    transition: groupTransition,
  };

  // ドロップ受け入れのハイライトはタブのドラッグ中だけ出す。
  // グループ同士の並び替え中は sortable のアニメーションが位置を示すため不要。
  const isTabDropTarget = isOver && isDraggingTab;

  if (!vm.exists) return null;

  const { title, tabCount, agentState, isActive, canDelete: canDeleteGroup } = vm;

  const handleSelect = () => {
    // 編集中は選択操作を無効化
    if (isEditingGroup) return;
    emit({ type: 'tabs/group-activated', groupId });
  };

  function handleGroupDoubleClick(e: React.MouseEvent) {
    // 編集中のダブルクリックは無視
    if (isEditingGroup) return;
    e.stopPropagation();
    emit({ type: 'tabs/group-rename-started', groupId });
  }

  return (
    // setGroupNodeRef: グループ全体を sortable 要素 (= タブの drop ターゲット) として登録する
    // F-M2: className="group-section-wrapper" を追加（[data-dragging].group-section-wrapper CSS selector が機能するように）
    <div
      ref={setGroupNodeRef}
      className="group-section-wrapper"
      style={groupStyle}
      data-dragging={isGroupDragging || undefined}
    >
      <ContextMenu.Root
        onOpenChange={(open) =>
          emit({ type: open ? 'tabs/context-menu-opened' : 'tabs/context-menu-closed' })
        }
      >
        {/* 編集中は右クリックメニューを無効化する */}
        <ContextMenu.Trigger
          disabled={isEditingGroup}
          asChild
        >
          {/* F1: グループ行を role="button" + onKeyDown で a11y 化 */}
          <div
            className={groupHeaderClassName(isActive, isTabDropTarget)}
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
              onCommit={(newTitle) => emit({ type: 'tabs/group-renamed', groupId, title: newTitle })}
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
                emit({ type: 'tabs/group-close-requested', groupId });
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
              onSelect={() => emit({ type: 'tabs/group-rename-started', groupId })}
            >
              リネーム
            </ContextMenu.Item>

            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => emit({ type: 'tabs/tab-create-in-group-requested', groupId })}
            >
              新規タブを追加
            </ContextMenu.Item>

            <ContextMenu.Separator className="context-menu__separator" />

            <ContextMenu.Item
              className="context-menu__item context-menu__item--danger"
              disabled={!canDeleteGroup}
              onSelect={() => emit({ type: 'tabs/group-close-requested', groupId })}
            >
              グループを閉じる
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
});
