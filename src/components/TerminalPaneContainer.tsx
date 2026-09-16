import { memo } from 'react';
import { useTerminalPanesView } from '../features/tabs/TabsRoot';
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
  const { isEmpty, panes } = useTerminalPanesView();

  if (isEmpty) return <EmptyPlaceholder />;

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      {panes.map(({ tab, isActive }) => (
        <TerminalPane key={tab.id} tabId={tab.id} tab={tab} isActive={isActive} />
      ))}
    </div>
  );
});
