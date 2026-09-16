/**
 * Claude タブの状態変化をデスクトップ通知で知らせる Root。
 *
 * サイドバーのステータスドットは racker のウィンドウを見ていないと意味がない。
 * 別のアプリで作業している間に Claude が応答待ちで止まっていることに気付けるよう、
 * 応答待ち / 完了になった瞬間だけトーストを出す。
 */

import { useEffect, type ReactNode } from 'react';
import { useAppStore } from '../../store/appStore';
import { notifyChangedTabs, pruneClosedTabs } from './notify';
import type { AgentState } from '../../types';

export function NotificationsRoot({ children }: { children: ReactNode }) {
  useEffect(() => {
    // 直前の状態。差分が出たタブだけを通知対象にする。
    const prevStates = new Map<string, AgentState | undefined>();
    let initialized = false;

    return useAppStore.subscribe((state) => {
      // 初回は現在の状態を控えるだけにする。
      // 起動直後は全タブが「未検出 → 何か」の遷移に見えるため、
      // これをしないと復元したタブの数だけ通知が飛ぶ。
      if (!initialized) {
        for (const [id, tab] of Object.entries(state.tabs)) {
          prevStates.set(id, tab.agentState);
        }
        initialized = true;
        return;
      }

      notifyChangedTabs(state, prevStates);
      pruneClosedTabs(prevStates, state.tabs);
    });
  }, []);

  return <>{children}</>;
}
