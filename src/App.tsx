import { useEffect } from 'react';
import { useAppStore } from './store/appStore';
import { getAllRuntimes } from './lib/terminalRegistry';
import { listWslDistros } from './lib/wsl';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { TerminalPaneContainer } from './components/TerminalPaneContainer';
import './styles/variables.css';
import './styles/title-bar.css';
import './styles/dropdown-menu.css';

function App() {
  useEffect(() => {
    // persist の rehydrate 完了を待ってから自動初期化する。
    // 復元データがある場合は createGroup/createTab を呼ばない。
    // F-M6: StrictMode 二重 mount + persist hydrate タイミングで「グループはあるがタブ 0」
    //        のケースにも対応するよう条件を分岐させる。
    function initIfEmpty() {
      const { groups, tabs, createGroup, createTab } = useAppStore.getState();
      if (groups.length === 0) {
        // 全グループ空 → Default グループ作成 + タブ追加
        const groupId = createGroup('Default');
        createTab(groupId, { userTitle: 'Terminal' });
      } else if (Object.keys(tabs).length === 0) {
        // グループはあるがタブ 0 → 既存 groups[0] にタブ追加
        createTab(groups[0].id, { userTitle: 'Terminal' });
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

  // App 起動時に WSL distro 一覧を取得して store に保存する。
  // Phase 4 P-K で追加。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const distros = await listWslDistros();
      if (!cancelled) {
        useAppStore.getState().setWslDistros(distros);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Settings の transparency を CSS 変数 --bg-alpha に反映する。
  // CSS で rgba() を動的に制御するために使用する。
  // Phase 4 P-B-2 で追加。
  useEffect(() => {
    // 初期値を即時反映
    const initialAlpha = useAppStore.getState().settings.transparency ?? 1.0;
    document.documentElement.style.setProperty('--bg-alpha', initialAlpha.toString());

    const unsub = useAppStore.subscribe((state) => {
      const t = state.settings.transparency ?? 1.0;
      document.documentElement.style.setProperty('--bg-alpha', t.toString());
    });
    return unsub;
  }, []);

  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <TerminalPaneContainer />
      </div>
    </div>
  );
}

export default App;
