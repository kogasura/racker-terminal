import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { InlineEdit } from './InlineEdit';
import { getTabDisplayTitle, AGENT_STATE_LABEL, type AgentState, type Tab, type TabStatus } from '../types';
import { DRAG_KIND, nextNewGroupTitle } from '../lib/dndResolve';
import { prBadgeKind, prTooltip } from '../lib/prStatus';
import { openUrl } from '@tauri-apps/plugin-opener';

const STATUS_DOT_CLASS: Record<TabStatus, string> = {
  live: 'tab-item__status-dot tab-item__status-dot--live',
  spawning: 'tab-item__status-dot tab-item__status-dot--spawning',
  crashed: 'tab-item__status-dot tab-item__status-dot--crashed',
};

/**
 * ステータスドットの class を組み立てる。
 *
 * PTY のライフサイクル (TabStatus) を基底の色とし、Claude タブのエージェント状態を
 * modifier で重ねる。'idle' と未検出 (undefined) は modifier を付けず、
 * 通常のタブと同じ見た目にする（「何も起きていない」ことを装飾で主張しない）。
 *
 * Sidebar のドラッグプレビューと共有するため export している。
 */
export function statusDotClassName(status: TabStatus, agentState?: AgentState): string {
  const base = STATUS_DOT_CLASS[status];
  if (!agentState || agentState === 'idle') return base;
  return `${base} tab-item__status-dot--agent-${agentState}`;
}

/**
 * ステータスドットの tooltip 文言を組み立てる。
 *
 * Claude のセッション情報が取れているタブでは、状態名だけでなく理由まで出す:
 * - 応答待ちなら `waitingFor`（'input needed' 等）を添える
 * - working のうち **シェルコマンド実行中** (`status === 'shell'`) は
 *   表示上 working に統合しているため、ここで区別を補う
 */
export function agentTooltip(tab: Pick<Tab, 'agentState' | 'waitingFor' | 'claudeStatus'>): string | undefined {
  if (tab.agentState === undefined) return undefined;
  const label = AGENT_STATE_LABEL[tab.agentState];

  if (tab.agentState === 'blocked' && tab.waitingFor !== undefined) {
    return `${label}: ${tab.waitingFor}`;
  }
  if (tab.agentState === 'working' && tab.claudeStatus === 'shell') {
    return `${label}（シェルコマンド）`;
  }
  return label;
}

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
 * PR 未作成・状態が取れない場合は何も描画しない。
 */
function TabPrBadge({ tab }: { tab: Tab }) {
  const pr = {
    branch: tab.prBranch ?? '',
    number: tab.prNumber,
    state: tab.prState,
    isDraft: tab.prIsDraft,
  };
  const kind = prBadgeKind(pr);
  if (kind === null || tab.prNumber === undefined) return null;

  return (
    <button
      type="button"
      className={`tab-item__pr tab-item__pr--${kind}`}
      title={prTooltip(pr)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (tab.prUrl !== undefined) void openUrl(tab.prUrl);
      }}
    >
      #{tab.prNumber}
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
  // Sidebar と同じく id / title を別々に subscribe する。
  // オブジェクトの配列にすると useShallow の要素比較が毎回 false になる。
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const groupTitles = useAppStore(useShallow((s) => s.groups.map((g) => g.title)));
  const moveTab = useAppStore((s) => s.moveTab);
  const createGroup = useAppStore((s) => s.createGroup);

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="context-menu__item context-menu__item--sub">
        <span className="context-menu__label">別のグループへ移動</span>
        <span className="context-menu__sub-arrow" aria-hidden="true">▸</span>
      </ContextMenu.SubTrigger>

      <ContextMenu.Portal>
        <ContextMenu.SubContent className="context-menu__content" sideOffset={2} alignOffset={-4}>
          {groupIds.map((groupId, i) => (
            <ContextMenu.Item
              key={groupId}
              className="context-menu__item"
              // 今いるグループへの移動は no-op なので選ばせない
              disabled={groupId === currentGroupId}
              // 移動先の末尾に置く。moveTab 側が toIndex をクランプする
              onSelect={() => moveTab(tabId, groupId, Number.MAX_SAFE_INTEGER)}
            >
              <span className="context-menu__label">{groupTitles[i]}</span>
            </ContextMenu.Item>
          ))}

          <ContextMenu.Separator className="context-menu__separator" />

          {/* サイドバー下部の「+ 新規グループに追加」drop エリアと同じ操作 */}
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => {
              const newGroupId = createGroup(
                nextNewGroupTitle(groupTitles.map((title) => ({ title }))),
              );
              moveTab(tabId, newGroupId, 0);
            }}
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
  // 個別 subscribe で他タブの status 変化による再レンダを防ぐ
  const tab = useAppStore((s) => s.tabs[tabId]);
  // M3: boolean だけ subscribe することで、自分以外の editingId 変化による再レンダーを防ぐ
  const isEditing = useAppStore((s) => s.editingId === tabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const startEditing = useAppStore((s) => s.startEditing);
  const updateTabTitle = useAppStore((s) => s.updateTabTitle);
  const duplicateTab = useAppStore((s) => s.duplicateTab);
  const addFavorite = useAppStore((s) => s.addFavorite);
  const setContextMenuOpen = useAppStore((s) => s.setContextMenuOpen);

  // groupId と kind を data に持たせることで onDragEnd で所属グループと D&D 種別を参照できる
  // F-M6: kind は DRAG_KIND 定数経由で指定（typo を型レベルで検出）
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tabId,
    data: { kind: DRAG_KIND.TAB, groupId: tab?.groupId },
    // 編集中はドラッグ操作を無効にする
    disabled: isEditing,
  });

  if (!tab) return null;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  function handleDoubleClick(e: React.MouseEvent) {
    // 編集中のダブルクリックは無視
    if (isEditing) return;
    e.preventDefault();
    startEditing(tabId);
  }

  function handleCommit(newTitle: string) {
    updateTabTitle(tabId, newTitle);
  }

  return (
    <ContextMenu.Root onOpenChange={(open) => setContextMenuOpen(open)}>
      {/* 編集中は右クリックメニューを無効化する */}
      <ContextMenu.Trigger
        disabled={isEditing}
        asChild
      >
        <div
          ref={setNodeRef}
          data-dragging={isDragging || undefined}
          style={style}
          {...attributes}
          {...listeners}
          className={`tab-item tab-item--${variant}${isActive ? ' active' : ''}`}
          onClick={() => setActiveTab(tabId)}
          onDoubleClick={handleDoubleClick}
          // N14: Radix の disabled が効かないバージョン互換性対策として onContextMenu も抑制する
          onContextMenu={isEditing ? (e) => e.preventDefault() : undefined}
        >
          <span
            className={statusDotClassName(tab.status, tab.agentState)}
            title={agentTooltip(tab)}
          />

          <InlineEdit
            id={tabId}
            title={getTabDisplayTitle(tab)}
            onCommit={handleCommit}
            className="tab-item__title"
          />

          <TabPrBadge tab={tab} />

          <button
            type="button"
            className="tab-item__close-btn"
            title="Close tab"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              removeTab(tabId);
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
            onSelect={() => startEditing(tabId)}
          >
            リネーム
          </ContextMenu.Item>

          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => duplicateTab(tabId)}
          >
            複製
          </ContextMenu.Item>

          <MoveToGroupSubmenu tabId={tabId} currentGroupId={tab.groupId} />

          <ContextMenu.Item
            className="context-menu__item"
            onSelect={() => {
              // 元タブの shell / cwd / args / env / userTitle を引き継いでお気に入りに登録する
              addFavorite({
                title: getTabDisplayTitle(tab),
                shell: tab.shell,
                cwd: tab.cwd,
                args: tab.args,    // クローンは addFavorite 内部で行う
                env: tab.env,
              });
            }}
          >
            お気に入りに追加
          </ContextMenu.Item>

          <ContextMenu.Separator className="context-menu__separator" />

          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={() => removeTab(tabId)}
          >
            閉じる
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
