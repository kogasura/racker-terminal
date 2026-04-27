import { memo } from 'react';
import { useAppStore } from '../store/appStore';
import { GroupSection } from './GroupSection';
import '../styles/sidebar.css';

export const Sidebar = memo(function Sidebar() {
  const groups = useAppStore((s) => s.groups);
  const createGroup = useAppStore((s) => s.createGroup);

  return (
    <div className="sidebar">
      <div className="sidebar__scroll-area">
        {groups.map((group) => (
          <GroupSection
            key={group.id}
            groupId={group.id}
            groupsCount={groups.length}
          />
        ))}
      </div>

      <div className="sidebar__footer">
        <button
          className="sidebar__new-group-btn"
          onClick={() => createGroup('New Group')}
        >
          + New Group
        </button>
      </div>
    </div>
  );
});
