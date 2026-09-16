import { memo } from 'react';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { useEmit } from '../architecture/chain';
import { useTabsView } from '../features/tabs/TabsRoot';
import type { TabsEvent } from '../features/tabs/events';
import { TabItem } from './TabItem';
import '../styles/tab-bar.css';

/**
 * ターミナル領域の上に置く横タブバー。
 *
 * サイドバーで選択中のグループ (activeGroupId) に属するタブだけを並べる。
 * グループを切り替えると並ぶタブが丸ごと入れ替わる構造で、
 * 「フォルダ（縦）の下にタブ（横）が生える」レイアウトを実現している。
 *
 * D&D の DndContext は App 直下の DragDropProvider が持つ。ここでは
 * 横並び用の SortableContext だけを提供し、タブをサイドバーのグループ行へ
 * ドロップしたときのグループ間移動は Provider 側が解決する。
 */
export const TabBar = memo(function TabBar() {
  const { tabBar } = useTabsView();
  const emit = useEmit<TabsEvent>();
  const { visible, tabIds, activeTabId } = tabBar;

  // 出すかどうかは View モデルが決めている。
  if (!visible) return null;

  return (
    <div className="tab-bar" role="tablist">
      <div className="tab-bar__tabs">
        <SortableContext
          id="tabs-sortable"
          items={tabIds as string[]}
          strategy={horizontalListSortingStrategy}
        >
          {tabIds.map((tabId) => (
            <TabItem
              key={tabId}
              tabId={tabId}
              isActive={tabId === activeTabId}
              variant="horizontal"
            />
          ))}
        </SortableContext>
      </div>

      {/* 選択中グループに新規タブを追加する。タブ 0 のグループでもこれだけは出す */}
      <button
        type="button"
        className="tab-bar__new-btn"
        onClick={() => emit({ type: 'tabs/tab-create-requested' })}
        title="新しいタブ"
        aria-label="新しいタブ"
      >
        +
      </button>
    </div>
  );
});
