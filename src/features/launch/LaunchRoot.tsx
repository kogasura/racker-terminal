/**
 * Windows Explorer「Racker Terminal で開く」からの起動フォルダを処理する Root。
 *
 * - 初回起動: `get_launch_path` で argv のフォルダを取得して開く
 * - 起動済みへの再起動 (single-instance): `open-path` イベントで受け取って開く
 *
 * いずれも spawnAtPath でタブを開くため、persist の rehydrate 完了を待ってから
 * 実行する (hydrate 前に createTab するとフォルダタブが復元データで上書きされる)。
 */

import { useEffect, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../../store/appStore';

export function LaunchRoot({ children }: { children: ReactNode }) {
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

  return <>{children}</>;
}
