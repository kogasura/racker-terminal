import { useEffect } from 'react';
import { useAppStore } from './store/appStore';
import { getAllRuntimes } from './lib/terminalRegistry';
import { Sidebar } from './components/Sidebar';
import { TerminalPaneContainer } from './components/TerminalPaneContainer';
import './styles/variables.css';

function App() {
  useEffect(() => {
    // persist の rehydrate 完了を待ってから自動初期化する。
    // 復元データがある場合は createGroup/createTab を呼ばない。
    function initIfEmpty() {
      const { groups, tabs, createGroup, createTab } = useAppStore.getState();
      if (groups.length === 0 || Object.keys(tabs).length === 0) {
        const groupId = createGroup('Default');
        createTab(groupId, { userTitle: 'Terminal' });
      }
    }

    // 既に hydrate 済みの場合（HMR 等）は即時チェック
    if (useAppStore.persist.hasHydrated()) {
      initIfEmpty();
      return;
    }

    // hydration 完了時に初期化する
    const unsub = useAppStore.persist.onFinishHydration(() => {
      initIfEmpty();
    });
    return unsub;
  }, []);

  // Settings が変化したとき全タブの xterm オプションをリアクティブに更新する。
  // subscribeWithSelector middleware は導入せず、前回値比較で settings の参照変化のみに反応させる。
  useEffect(() => {
    let prev = useAppStore.getState().settings;
    const unsub = useAppStore.subscribe((state) => {
      if (state.settings === prev) return;
      prev = state.settings;
      for (const r of getAllRuntimes()) r.applySettings(state.settings);
    });
    return unsub;
  }, []);

  return (
    <div className="h-screen w-screen" style={{ display: 'flex' }}>
      <Sidebar />
      <TerminalPaneContainer />
    </div>
  );
}

export default App;
