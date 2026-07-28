import { memo } from 'react';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
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
  const activeGroupId = useAppStore((s) => s.activeGroupId);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const createTab = useAppStore((s) => s.createTab);

  // 選択中グループの tabIds のみ subscribe する。
  // 他グループのタブ増減やタイトル変更では再レンダーされない。
  const tabIds = useAppStore(
    useShallow((s) => s.groups.find((g) => g.id === activeGroupId)?.tabIds ?? []),
  );

  // グループが 1 つも選択されていない（= グループ自体が無い）ときは何も出さない。
  // App の初期化がグループを必ず 1 つ作るため、通常は起動直後の一瞬だけ。
  if (activeGroupId === null) return null;

  return (
    <div className="tab-bar" role="tablist">
      <div className="tab-bar__tabs">
        <SortableContext
          id="tabs-sortable"
          items={tabIds}
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
        onClick={() => createTab(activeGroupId)}
        title="新しいタブ"
        aria-label="新しいタブ"
      >
        +
      </button>
    </div>
  );
});
