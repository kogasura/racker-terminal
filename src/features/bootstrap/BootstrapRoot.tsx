/**
 * 起動時の下ごしらえをする Root。
 *
 * 画面を出す前に一度だけ整えるもの (最初のグループ / タブ、WSL distro 一覧) を
 * まとめてある。どちらもユーザー操作が起点ではないので、裁定するものはない。
 */

import { useEffect, type ReactNode } from 'react';
import { listWslDistros } from '../../lib/wsl';
import { useAppStore } from '../../store/appStore';

export function BootstrapRoot({ children }: { children: ReactNode }) {
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

  return <>{children}</>;
}
