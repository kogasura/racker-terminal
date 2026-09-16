/**
 * ステータスバーの Root。
 *
 * プランの利用量はこの Root が自分で引く (以前は App.tsx の useEffect だった)。
 * 会話ログのほうはタブのセッション巡回にぶら下がっているため、読めた結果が
 * `claude-status/meta-observed` としてチェーンから流れてくるのを待つ。
 *
 * Anthropic の API を叩くため、間隔は分単位で十分に長く取る (利用率は分単位でしか
 * 動かない)。裏に回っているあいだは引かず、前面に戻ったときは引き直すが、
 * 最小間隔を置く (ウィンドウを行き来するだけで叩き続けないため)。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { EventScope, mediatorLink, type Link } from '../../architecture/chain';
import { createMachine, type Machine } from '../../architecture/machine';
import { getUsageLimits, shouldFetchUsage } from '../../lib/claudeMeta';
import { useAppStore } from '../../store/appStore';
import type { ClaudeStatusEvent } from './events';
import {
  initialState,
  transition,
  type ClaudeStatusEffect,
  type ClaudeStatusState,
} from './machine';
import { selectStatusBar, type StatusBarViewModel } from './viewModel';

/** 利用率は分単位でしか動かないので、これくらい空けて十分。 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const ClaudeStatusViewContext = createContext<StatusBarViewModel | null>(null);

export function useStatusBarView(): StatusBarViewModel {
  const vm = useContext(ClaudeStatusViewContext);
  if (!vm) throw new Error('useStatusBarView は ClaudeStatusRoot の内側でしか使えません。');
  return vm;
}

const traceLink: Link<ClaudeStatusEvent> = (event, next) => {
  if (import.meta.env.DEV) console.debug('[claude-status] event:', event.type);
  next(event);
};

export interface ClaudeStatusRootProps {
  readonly children: ReactNode;
  /** テスト用: 利用量の取得を差し替える / 止める。 */
  readonly fetchUsage?: typeof getUsageLimits | null;
}

export function ClaudeStatusRoot({ children, fetchUsage }: ClaudeStatusRootProps) {
  const machineRef = useRef<Machine<ClaudeStatusState, ClaudeStatusEvent> | null>(null);
  if (!machineRef.current) {
    machineRef.current = createMachine<ClaudeStatusState, ClaudeStatusEvent, ClaudeStatusEffect>({
      initial: initialState,
      transition,
    });
  }
  const machine = machineRef.current;

  const state = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);

  // 設定は store 側の関心なのでここで読む。未設定は有効として扱う
  // (notificationsEnabled と同じ扱い)。
  const enabled = useAppStore((s) => s.settings.statusBarEnabled !== false);

  // 表示対象のタブ。切り替わったら Mediator に知らせ、前のタブの値を出さないようにする。
  const activeTabId = useAppStore((s) => s.activeTabId);
  useEffect(() => {
    machine.send({ type: 'claude-status/active-tab-changed', tabId: activeTabId });
  }, [machine, activeTabId]);

  const links = useMemo<readonly Link<ClaudeStatusEvent>[]>(
    () => [traceLink, mediatorLink('claude-status/', (event) => machine.send(event))],
    [machine],
  );

  // プラン利用量のポーリング。
  useEffect(() => {
    if (fetchUsage === null) return;
    const fetch = fetchUsage ?? getUsageLimits;

    let cancelled = false;
    let running = false;
    // 初期値 true は「フォーカスイベントが来る前でも 1 回目は引く」ため
    let focused = true;
    let hasEverPolled = false;
    let lastFetchedAt = 0;
    let unlistenFocus: (() => void) | null = null;

    const tick = async () => {
      if (running) return;
      if (!shouldFetchUsage(focused, hasEverPolled, Date.now() - lastFetchedAt)) return;
      running = true;
      hasEverPolled = true;
      try {
        const usage = await fetch();
        if (!cancelled) machine.send({ type: 'claude-status/usage-observed', usage });
      } finally {
        lastFetchedAt = Date.now();
        running = false;
      }
    };

    // 前面に戻ってきたら引き直す。裏にいるあいだに使った分を反映するため
    // (別のウィンドウで動かしている Claude Code の消費もここに乗る)。
    void (async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onFocusChanged(({ payload }) => {
          const wasFocused = focused;
          focused = payload;
          if (!wasFocused && payload) void tick();
        });
        if (cancelled) fn();
        else unlistenFocus = fn;
      } catch (e) {
        // フォーカスを追えない環境では、定期取得だけに任せる
        console.warn('[claude-status] onFocusChanged failed, polling stays interval-only:', e);
        focused = true;
      }
    })();

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      unlistenFocus?.();
    };
  }, [machine, fetchUsage]);

  const viewModel = useMemo(() => selectStatusBar(state, enabled), [state, enabled]);

  return (
    <EventScope<ClaudeStatusEvent> links={links}>
      <ClaudeStatusViewContext.Provider value={viewModel}>
        {children}
      </ClaudeStatusViewContext.Provider>
    </EventScope>
  );
}
