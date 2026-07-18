import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from './store/appStore';
import { getAllRuntimes } from './lib/terminalRegistry';
import { listWslDistros } from './lib/wsl';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { TerminalPaneContainer } from './components/TerminalPaneContainer';
import { UpdateDialog } from './components/UpdateDialog';
import { useFileDropToTerminal } from './hooks/useFileDropToTerminal';
import { FileDropOverlay } from './components/FileDropOverlay';
import './styles/variables.css';
import './styles/title-bar.css';
import './styles/dropdown-menu.css';
import './styles/update-dialog.css';

function App() {
  const { isDragging } = useFileDropToTerminal();

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

  // updater のチェック:
  // - 起動時に 1 回 (persist hydration 完了を待つ)
  // - 以降は 1 時間ごとに定期チェックして、起動しっぱなし運用でも更新に気付けるようにする
  // 同時実行は runUpdateCheck 側のガード (phase !== 'idle' のとき no-op) で防がれる。
  useEffect(() => {
    const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 時間
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fire = () => {
      if (cancelled) return;
      void useAppStore.getState().runUpdateCheck();
    };

    const start = () => {
      if (cancelled) return;
      fire();
      intervalId = setInterval(fire, UPDATE_CHECK_INTERVAL_MS);
    };

    if (useAppStore.persist.hasHydrated()) {
      start();
      return () => {
        cancelled = true;
        if (intervalId !== null) clearInterval(intervalId);
      };
    }
    const unsub = useAppStore.persist.onFinishHydration(start);
    return () => {
      cancelled = true;
      unsub();
      if (intervalId !== null) clearInterval(intervalId);
    };
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

  // Windows Explorer「Racker Terminal で開く」からの起動フォルダを処理する。
  // - 初回起動: get_launch_path で argv のフォルダを取得して開く
  // - 起動済みへの再起動 (single-instance): open-path イベントで受け取って開く
  // いずれも spawnAtPath でタブを開くため、persist の rehydrate 完了を待ってから実行する
  // （hydrate 前に createTab するとフォルダタブが復元データで上書きされてしまうため）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const openPath = (path: unknown) => {
      if (typeof path === 'string' && path.trim().length > 0) {
        useAppStore.getState().spawnAtPath(path);
      }
    };

    const start = async () => {
      // 起動時 argv のフォルダを開く（通常起動や引数なしでは null が返る）
      try {
        const initial = await invoke<string | null>('get_launch_path');
        if (!cancelled) openPath(initial);
      } catch (e) {
        console.warn('[launch] get_launch_path failed:', e);
      }
      // 起動済みインスタンスへ転送される open-path イベントを購読する
      try {
        const off = await listen<string>('open-path', (event) => openPath(event.payload));
        if (cancelled) off();
        else unlisten = off;
      } catch (e) {
        console.warn('[launch] listen(open-path) failed:', e);
      }
    };

    if (useAppStore.persist.hasHydrated()) {
      void start();
      return () => {
        cancelled = true;
        if (unlisten) unlisten();
      };
    }
    const unsub = useAppStore.persist.onFinishHydration(() => {
      void start();
    });
    return () => {
      cancelled = true;
      unsub();
      if (unlisten) unlisten();
    };
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
      <UpdateDialog />
      <div className="app-body">
        <Sidebar />
        <TerminalPaneContainer />
        <FileDropOverlay isDragging={isDragging} />
      </div>
    </div>
  );
}

export default App;
