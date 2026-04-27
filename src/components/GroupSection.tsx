import { memo } from 'react';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { TabItem } from './TabItem';

interface GroupSectionProps {
  groupId: string;
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
  const createTab = useAppStore((s) => s.createTab);
  const removeGroup = useAppStore((s) => s.removeGroup);
  const toggleCollapse = useAppStore((s) => s.toggleCollapse);
  // F2: prop drilling 解消 — Sidebar から groupsCount を受け取らず直接 subscribe
  const canDelete = useAppStore((s) => s.groups.length > 1);

  if (!groupView) return null;

  const { title, collapsed, tabIds } = groupView;
  const isEmpty = tabIds.length === 0;
  const canDeleteGroup = isEmpty && canDelete;

  const handleToggle = () => toggleCollapse(groupId);

  return (
    <div>
      {/* F1: グループヘッダを role="button" + onKeyDown で a11y 化 */}
      <div
        className="group-header"
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <span className="group-header__chevron">{collapsed ? '▶' : '▼'}</span>
        <span className="group-header__title" title={title}>
          {title}
        </span>
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

      {/* グループ本体（折りたたみ時は非表示） */}
      {!collapsed && (
        <div className="group-body">
          {tabIds.map((tabId) => (
            <TabItem
              key={tabId}
              tabId={tabId}
              isActive={tabId === activeTabId}
            />
          ))}

          {/* "+ Add Tab" インラインボタン（常に末尾に表示） */}
          {/* F3: type="button" 追加 */}
          <button
            type="button"
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
