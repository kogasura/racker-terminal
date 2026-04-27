import { memo } from 'react';
import { useAppStore } from '../store/appStore';
import type { TabStatus } from '../types';

const STATUS_DOT_CLASS: Record<TabStatus, string> = {
  live: 'tab-item__status-dot tab-item__status-dot--live',
  spawning: 'tab-item__status-dot tab-item__status-dot--spawning',
  crashed: 'tab-item__status-dot tab-item__status-dot--crashed',
};

interface TabItemProps {
  tabId: string;
  isActive: boolean;
}

export const TabItem = memo(function TabItem({ tabId, isActive }: TabItemProps) {
  // 個別 subscribe で他タブの status 変化による再レンダを防ぐ
  const tab = useAppStore((s) => s.tabs[tabId]);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);

  if (!tab) return null;

  return (
    <div
      className={`tab-item${isActive ? ' active' : ''}`}
      onClick={() => setActiveTab(tabId)}
    >
      <span className={STATUS_DOT_CLASS[tab.status] ?? 'tab-item__status-dot'} />

      <span className="tab-item__title" title={tab.title}>
        {tab.title}
      </span>

      <button
        className="tab-item__close-btn"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          removeTab(tabId);
        }}
      >
        ×
      </button>
    </div>
  );
});
