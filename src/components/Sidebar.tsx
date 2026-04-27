import { memo } from 'react';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { GroupSection } from './GroupSection';
import '../styles/sidebar.css';

export const Sidebar = memo(function Sidebar() {
  // beta P1: id 配列のみ subscribe（グループ内の title/collapsed 変化で Sidebar が再レンダーされない）
  const groupIds = useAppStore(useShallow((s) => s.groups.map((g) => g.id)));
  const groupsCount = groupIds.length;
  const createGroup = useAppStore((s) => s.createGroup);

  return (
    <div className="sidebar">
      <div className="sidebar__scroll-area">
        {groupIds.map((groupId) => (
          <GroupSection
            key={groupId}
            groupId={groupId}
          />
        ))}
      </div>

      <div className="sidebar__footer">
        {/* F3: type="button" 追加 / F6: 連番タイトル化 */}
        <button
          type="button"
          className="sidebar__new-group-btn"
          onClick={() => createGroup(`New Group ${groupsCount + 1}`)}
        >
          + New Group
        </button>
      </div>
    </div>
  );
});
