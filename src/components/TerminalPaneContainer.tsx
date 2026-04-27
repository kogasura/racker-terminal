import { memo } from 'react';
import { useAppStore } from '../store/appStore';
import { TerminalPane } from './TerminalPane';
import '../styles/terminal.css';

function EmptyPlaceholder() {
  return (
    <div className="terminal-empty-placeholder">
      No terminal open — click + New Tab
    </div>
  );
}

export const TerminalPaneContainer = memo(function TerminalPaneContainer() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabList = Object.values(tabs);

  if (tabList.length === 0) return <EmptyPlaceholder />;

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      {tabList.map((tab) => (
        <TerminalPane
          key={tab.id}
          tabId={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
        />
      ))}
    </div>
  );
});
