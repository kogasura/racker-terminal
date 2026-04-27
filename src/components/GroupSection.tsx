import { memo } from 'react';
import { useAppStore } from '../store/appStore';
import { TabItem } from './TabItem';

interface GroupSectionProps {
  groupId: string;
  groupsCount: number;
}

export const GroupSection = memo(function GroupSection({
  groupId,
  groupsCount,
}: GroupSectionProps) {
  const group = useAppStore((s) => s.groups.find((g) => g.id === groupId));
  const activeTabId = useAppStore((s) => s.activeTabId);
  const createTab = useAppStore((s) => s.createTab);
  const removeGroup = useAppStore((s) => s.removeGroup);
  const toggleCollapse = useAppStore((s) => s.toggleCollapse);

  if (!group) return null;

  const isEmpty = group.tabIds.length === 0;
  // 削除可能: タブが 0 枚 かつ グループが 2 個以上
  const canDelete = isEmpty && groupsCount > 1;

  return (
    <div>
      {/* グループヘッダ */}
      <div className="group-header" onClick={() => toggleCollapse(groupId)}>
        <span className="group-header__chevron">
          {group.collapsed ? '▶' : '▼'}
        </span>
        <span className="group-header__title" title={group.title}>
          {group.title}
        </span>
        <button
          className="group-header__delete-btn"
          title="Delete group"
          disabled={!canDelete}
          onClick={(e) => {
            e.stopPropagation();
            removeGroup(groupId);
          }}
        >
          ×
        </button>
      </div>

      {/* グループ本体（折りたたみ時は非表示） */}
      {!group.collapsed && (
        <div className="group-body">
          {group.tabIds.map((tabId) => (
            <TabItem
              key={tabId}
              tabId={tabId}
              isActive={tabId === activeTabId}
            />
          ))}

          {/* "+ Add Tab" インラインボタン（常に末尾に表示） */}
          <button
            className="group-add-tab-btn"
            onClick={() => createTab(groupId)}
          >
            + Add Tab
          </button>
        </div>
      )}
    </div>
  );
});
