/**
 * 状態変化から「通知を出すか」を決める部分。純粋に近い判定だけを切り出してある。
 *
 * Root から分けているのは、描画を伴わずにテストできるようにするため
 * (App 本体に置かれていたときも同じ理由で export されていた)。
 */

import { shouldNotify, notifyAgentState } from '../../lib/notifications';
import { getTabDisplayTitle, type AgentState, type Settings, type Tab } from '../../types';

/** 通知判定に必要な store の断片。 */
interface NotifyState {
  tabs: Record<string, Tab>;
  settings: Settings;
  activeTabId: string | null;
}

/**
 * agentState が変わったタブについて、必要なら通知を出す。
 * prevStates は呼び出し側が持つ「直前の状態」の控えで、ここで最新値に更新する。
 */
export function notifyChangedTabs(
  state: NotifyState,
  prevStates: Map<string, AgentState | undefined>,
): void {
  for (const [id, tab] of Object.entries(state.tabs)) {
    const prev = prevStates.get(id);
    if (prev === tab.agentState) continue;
    prevStates.set(id, tab.agentState);

    // 設定は通知の直前に読む。effect を張り直さずに ON/OFF を反映するため。
    if (state.settings.notificationsEnabled === false) continue;

    const kind = shouldNotify(prev, tab.agentState, id === state.activeTabId);
    if (kind !== null) {
      void notifyAgentState(kind, getTabDisplayTitle(tab), tab.waitingFor);
    }
  }
}

/**
 * 閉じられたタブを控えから外す。
 * タブ ID が再利用されることはないが、長時間の運用で Map が単調増加するのを防ぐ。
 */
export function pruneClosedTabs(
  prevStates: Map<string, AgentState | undefined>,
  tabs: Record<string, Tab>,
): void {
  if (prevStates.size <= Object.keys(tabs).length) return;
  for (const id of prevStates.keys()) {
    if (!(id in tabs)) prevStates.delete(id);
  }
}
