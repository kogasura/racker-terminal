import { useEffect } from 'react';
import { useAppStore } from './store/appStore';
import { Sidebar } from './components/Sidebar';
import { TerminalPaneContainer } from './components/TerminalPaneContainer';
import './styles/variables.css';

function App() {
  useEffect(() => {
    const { groups, tabs, createGroup, createTab } = useAppStore.getState();
    if (groups.length === 0 || Object.keys(tabs).length === 0) {
      const groupId = createGroup('Default');
      createTab(groupId, { title: 'Terminal' });
    }
  }, []);

  return (
    <div className="h-screen w-screen" style={{ display: 'flex' }}>
      <Sidebar />
      <TerminalPaneContainer />
    </div>
  );
}

export default App;
