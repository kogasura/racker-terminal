import { memo } from 'react';
import { useAppStore } from '../store/appStore';

const STATUS_COLOR: Record<string, string> = {
  live: 'var(--status-live)',
  spawning: 'var(--status-spawning)',
  crashed: 'var(--status-crashed)',
};

export const Sidebar = memo(function Sidebar() {
  const groups = useAppStore((s) => s.groups);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const createTab = useAppStore((s) => s.createTab);

  // グループ順に全タブを並べる
  const tabList = groups.flatMap((g) =>
    g.tabIds.map((id) => tabs[id]).filter(Boolean),
  );

  return (
    <div
      style={{
        width: 'var(--sidebar-width)',
        flexShrink: 0,
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--sidebar-border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* タブリスト */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {tabList.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                cursor: 'pointer',
                background: isActive
                  ? 'var(--tab-item-bg-active)'
                  : 'var(--tab-item-bg)',
                color: 'var(--sidebar-fg)',
                userSelect: 'none',
                fontSize: 13,
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLDivElement).style.background =
                    'var(--tab-item-bg-hover)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLDivElement).style.background =
                    'var(--tab-item-bg)';
                }
              }}
            >
              {/* status dot */}
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: STATUS_COLOR[tab.status] ?? 'transparent',
                }}
              />

              {/* title */}
              <span
                title={tab.title}
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {tab.title}
              </span>

              {/* close button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--sidebar-fg)',
                  cursor: 'pointer',
                  padding: '0 2px',
                  fontSize: 14,
                  lineHeight: 1,
                  opacity: 0.6,
                  flexShrink: 0,
                }}
                title="Close tab"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {/* + New Tab ボタン */}
      <div style={{ padding: '8px', borderTop: '1px solid var(--sidebar-border)' }}>
        <button
          onClick={() => createTab()}
          style={{
            width: '100%',
            padding: '6px 0',
            background: 'none',
            border: '1px solid var(--sidebar-border)',
            borderRadius: 4,
            color: 'var(--sidebar-fg)',
            cursor: 'pointer',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
          }}
        >
          + New Tab
        </button>
      </div>
    </div>
  );
});
