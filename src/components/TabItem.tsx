import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useEmit } from '../architecture/chain';
import type { TabsEvent } from '../features/tabs/events';
import { useMoveTargetsView, useTabItemView } from '../features/tabs/TabsRoot';
import type { PrBadgeViewModel, TabItemViewModel } from '../features/tabs/viewModel';
import { InlineEdit } from './InlineEdit';
import { DRAG_KIND } from '../lib/dndResolve';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * タブの並び方向。
 * - 'horizontal': TabBar（画面上部の横並び）。現行レイアウトの既定の使われ方
 * - 'vertical':   縦リスト用。ドラッグプレビューなど、横タブ以外の文脈で使う
 *
 * コンテキストメニュー・InlineEdit・sortable の挙動は共通で、CSS だけが切り替わる。
 */
export type TabItemVariant = 'horizontal' | 'vertical';

interface TabItemProps {
  tabId: string;
  isActive: boolean;
  variant?: TabItemVariant;
}

/**
 * 作業ディレクトリのブランチに対応する PR バッジ。クリックでブラウザを開く。
 * 出すかどうかは View モデルが決めている。
 */
function TabPrBadge({ pr }: { pr: PrBadgeViewModel | null }) {
  if (pr === null) return null;

  return (
    <button
      type="button"
      className={`tab-item__pr tab-item__pr--${pr.kind}`}
      title={pr.tooltip}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (pr.url !== undefined) void openUrl(pr.url);
      }}
    >
      {pr.label}
    </button>
  );
}

/**
 * 右クリックメニューの「別のグループへ移動」サブメニュー。
 *
 * D&D（タブをサイドバーのグループ行へドロップ）と同じ移動を、掴んで運ばずに
 * 選ぶだけで行えるようにする。グループが増えてサイドバーをスクロールしないと
 * 目的のグループが見えない状況では、ドロップより確実で速い。
 *
 * ContextMenu.Content の中に置くことで、右クリックでメニューを開いたときだけ
 * マウントされる。TabItem 本体でグループ一覧を subscribe すると、全タブが
 * グループのタイトル変更で再レンダーされてしまうため、あえて分離している。
 */
function MoveToGroupSubmenu({
  tabId,
  currentGroupId,
}: {
  tabId: string;
  currentGroupId: string;
}) {
  const targets = useMoveTargetsView(currentGroupId);
  const emit = useEmit<TabsEvent>();

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="context-menu__item context-menu__item--sub">
        <span className="context-menu__label">別のグループへ移動</span>
        <span className="context-menu__sub-arrow" aria-hidden="true">▸</span>
      </ContextMenu.SubTrigger>

      <ContextMenu.Portal>
        <ContextMenu.SubContent className="context-menu__content" sideOffset={2} alignOffset={-4}>
          {targets.map((target) => (
            <ContextMenu.Item
              key={target.groupId}
              className="context-menu__item"
              disabled={target.disabled}
              onSelect={() =>
                emit({ type: 'tabs/tab-move-requested', tabId, toGroupId: target.groupId })
              }
            >
              <span className="context-menu__label">{target.title}</span>
            </ContextMenu.Item>
          ))}

          <ContextMenu.Separator className="context-menu__separator" />

          {/* サイドバー下部の「+ 新規グループに追加」drop エリアと同じ操作 */}
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => emit({ type: 'tabs/tab-move-to-new-group-requested', tabId })}
          >
            <span className="context-menu__label">+ 新規グループへ移動</span>
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

export const TabItem = memo(function TabItem({
  tabId,
  isActive,
  variant = 'vertical',
}: TabItemProps) {
  const vm = useTabItemView(tabId);
  const emit = useEmit<TabsEvent>();

  // groupId と kind を data に持たせることで onDragEnd で所属グループと D&D 種別を参照できる
  // F-M6: kind は DRAG_KIND 定数経由で指定（typo を型レベルで検出）
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tabId,
    data: { kind: DRAG_KIND.TAB, groupId: vm.groupId },
    // 編集中はドラッグ操作を無効にする
    disabled: vm.isEditing,
  });

  if (!vm.exists) return null;

  return (
    <TabItemView
      tabId={tabId}
      vm={vm}
      isActive={isActive}
      variant={variant}
      emit={emit}
      sortable={{ attributes, listeners, setNodeRef, transform, transition, isDragging }}
    />
  );
});

/** 並べるだけの本体。判断はすべて View モデル側にある。 */
function TabItemView({
  tabId,
  vm,
  isActive,
  variant,
  emit,
  sortable,
}: {
  tabId: string;
  vm: TabItemViewModel;
  isActive: boolean;
  variant: TabItemVariant;
  emit: (event: TabsEvent) => void;
  sortable: Pick<
    ReturnType<typeof useSortable>,
    'attributes' | 'listeners' | 'setNodeRef' | 'transform' | 'transition' | 'isDragging'
  >;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <ContextMenu.Root
      onOpenChange={(open) =>
        emit({ type: open ? 'tabs/context-menu-opened' : 'tabs/context-menu-closed' })
      }
    >
      {/* 編集中は右クリックメニューを無効化する */}
      <ContextMenu.Trigger disabled={vm.isEditing} asChild>
        <div
          ref={setNodeRef}
          data-dragging={isDragging || undefined}
          style={style}
          {...attributes}
          {...listeners}
          className={`tab-item tab-item--${variant}${isActive ? ' active' : ''}`}
          onClick={() => emit({ type: 'tabs/tab-activated', tabId })}
          onDoubleClick={(e) => {
            // 編集中のダブルクリックは無視
            if (vm.isEditing) return;
            e.preventDefault();
            emit({ type: 'tabs/tab-rename-started', tabId });
          }}
          // N14: Radix の disabled が効かないバージョン互換性対策として onContextMenu も抑制する
          onContextMenu={vm.isEditing ? (e) => e.preventDefault() : undefined}
        >
          <span className={vm.statusClass} title={vm.statusTooltip} />

          <InlineEdit
            id={tabId}
            title={vm.title}
            onCommit={(title) => emit({ type: 'tabs/tab-renamed', tabId, title })}
            className="tab-item__title"
          />

          <TabPrBadge pr={vm.pr} />

          <button
            type="button"
            className="tab-item__close-btn"
            title="Close tab"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              emit({ type: 'tabs/tab-close-requested', tabId });
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
            onSelect={() => emit({ type: 'tabs/tab-rename-started', tabId })}
          >
            リネーム
          </ContextMenu.Item>

          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => emit({ type: 'tabs/tab-duplicate-requested', tabId })}
          >
            複製
          </ContextMenu.Item>

          <MoveToGroupSubmenu tabId={tabId} currentGroupId={vm.groupId} />

          {/*
            手動起動 claude の紐付けは cwd 一致という緩い根拠で自動採用されるため、
            同じフォルダで動いていた別アプリの会話を掴んでしまうことがありうる。
            そのときにユーザーが打てる唯一の手として、記録を切り離す導線を置く。
            記録を持たないタブには何も出さない（claude を使わない人には存在しない
            メニュー）。消したあと再び採用されるのは「そのフォルダで実際に claude が
            1 つだけ生きている」ときだけなので、消し得にはならない。
          */}
          {vm.hasClaudeSession && (
            <>
              <ContextMenu.Separator className="context-menu__separator" />

              <ContextMenu.Item
                className="context-menu__item"
                onSelect={() => emit({ type: 'tabs/claude-session-clear-requested', tabId })}
              >
                Claude セッションの記録を消す
              </ContextMenu.Item>
            </>
          )}

          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => emit({ type: 'tabs/tab-favorite-requested', tabId })}
          >
            お気に入りに追加
          </ContextMenu.Item>

          <ContextMenu.Separator className="context-menu__separator" />

          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => emit({ type: 'tabs/tab-close-requested', tabId })}
          >
            閉じる
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
