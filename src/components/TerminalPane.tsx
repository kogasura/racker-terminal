// PTY/xterm.js のライフサイクル管理が複雑なため HMR 対象外とする。
// このファイルが変更された場合、Vite は full reload を行う。
if (import.meta.hot) { import.meta.hot.invalidate(); }

import React, { memo, useEffect, useRef } from 'react';
import type { Tab } from '../types';
import { useAppStore, selectNextTabId, selectPrevTabId } from '../store/appStore';
import {
  acquireRuntime,
  releaseRuntime,
  createRuntime,
  type TerminalRuntime,
} from '../lib/terminalRegistry';
import { resizePty } from '../lib/pty';
import type { PtyEvent } from '../lib/pty';
import '../styles/terminal.css';

interface TerminalPaneProps {
  tabId: string;
  tab: Tab;
  isActive: boolean;
}

function handlePtyEvent(
  e: PtyEvent,
  runtime: TerminalRuntime,
  tabId: string,
  setTabStatus: ReturnType<typeof useAppStore.getState>['setTabStatus'],
  exitCodeRef: React.MutableRefObject<number | null>,
  spawnErrorRef: React.MutableRefObject<string | null>,
) {
  switch (e.type) {
    case 'data':
      // 非アクティブタブでも継続してスクロールバックに蓄積する
      runtime.term.write(e.text);
      break;
    case 'exit':
      exitCodeRef.current = e.code ?? null;
      setTabStatus(tabId, 'crashed');
      break;
    case 'error':
      spawnErrorRef.current = e.message;
      setTabStatus(tabId, 'crashed');
      break;
  }
}

export const TerminalPane = memo(function TerminalPane({
  tabId,
  tab,
  isActive,
}: TerminalPaneProps) {
  const settings = useAppStore((s) => s.settings);
  const setTabStatus = useAppStore((s) => s.setTabStatus);

  const divRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<TerminalRuntime | null>(null);
  const exitCodeRef = useRef<number | null>(null);
  const spawnErrorRef = useRef<string | null>(null);

  // 初回 mount [tabId]: acquireRuntime + setOnEvent + 必要なら startSpawn + cleanup
  useEffect(() => {
    const runtime = acquireRuntime(tabId, () =>
      createRuntime(divRef.current!, settings, tabId, {
        onLive: (ptyId) => setTabStatus(tabId, 'live', ptyId),
      }),
    );
    runtimeRef.current = runtime;

    runtime.setOnEvent((e) =>
      handlePtyEvent(e, runtime, tabId, setTabStatus, exitCodeRef, spawnErrorRef),
    );

    if (tab.status === 'spawning') {
      runtime.startSpawn(
        {
          shell: tab.shell,
          cwd: tab.cwd,
          env: tab.env,
          cols: Math.max(1, runtime.term.cols || 80),
          rows: Math.max(1, runtime.term.rows || 24),
        },
        (err) => {
          spawnErrorRef.current = err.message;
          setTabStatus(tabId, 'crashed');
        },
      );
    }

    return () => {
      runtime.setOnEvent(null);  // unmount 後のイベントを遮断
      runtimeRef.current = null;
      releaseRuntime(tabId);
    };
    // tab.status は初回 mount 時のみ参照するため deps から除外する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // isActive 切替 [isActive]: rAF で fit + resizePty + term.focus
  useEffect(() => {
    if (!isActive) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;

    const rafId = requestAnimationFrame(() => {
      try { runtime.fitAddon.fit(); } catch (e) { console.warn(e); }
      if (runtime.ptyHandle) {
        void resizePty(runtime.ptyHandle.id, runtime.term.cols, runtime.term.rows).catch(() => {});
      }
      runtime.term.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [isActive]);

  // crashed 時は xterm への入力を遮断する（writePty が "session not found" エラーを返すのを防ぐ）
  // Unit C で restart が実装された際に live 復帰時の false 戻しが機能する
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.term.options.disableStdin = (tab.status === 'crashed');
  }, [tab.status]);

  // ResizeObserver は isActive 変化のたびに付け直す（設計書 §4.4）
  // observe() 直後の初回コールバックは仕様上即時発火するため、1 回だけスキップする。
  // isActive=true 時の fit+resize は rAF effect が担うため、二重実行を防ぐ。
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !divRef.current) return;

    let initialFire = true;
    const observer = new ResizeObserver(() => {
      if (initialFire) { initialFire = false; return; }  // observe() 直後の自動発火は無視
      if (!isActive) return;  // 非アクティブ時はスキップ（isActive 復帰時の rAF fit で同期）
      try { runtime.fitAddon.fit(); } catch (e) { console.warn(e); }
      if (runtime.ptyHandle) {
        void resizePty(runtime.ptyHandle.id, runtime.term.cols, runtime.term.rows).catch(() => {});
      }
    });
    observer.observe(divRef.current);
    return () => observer.disconnect();
  }, [isActive]);

  // キーボードショートカット [tabId]: xterm がフォーカスを持つときのみ動作する
  // attachCustomKeyEventHandler の戻り値: false → xterm が通常処理しない、true → 通常処理継続
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    const handler = (e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true;
      if (!e.ctrlKey) return true;

      // Ctrl+Shift+W: アクティブタブを閉じる
      if (e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        const aid = useAppStore.getState().activeTabId;
        if (aid) useAppStore.getState().removeTab(aid);
        return false;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: 次/前のタブへ移動
      if (e.key === 'Tab') {
        e.preventDefault();
        const state = useAppStore.getState();
        const next = e.shiftKey ? selectPrevTabId(state) : selectNextTabId(state);
        if (next) state.navigateToTab(next);
        return false;
      }

      return true;
    };

    runtime.term.attachCustomKeyEventHandler(handler);
    return () => {
      // xterm はハンドラ解除 API がないため、no-op ハンドラで上書きする
      runtime.term.attachCustomKeyEventHandler(() => true);
    };
  }, [tabId]);

  const isCrashed = tab.status === 'crashed';

  return (
    <div
      ref={divRef}
      className={`terminal-pane ${isActive ? 'terminal-pane--visible' : 'terminal-pane--hidden'}`}
      inert={!isActive ? true : undefined}
    >
      {isCrashed && isActive && (
        <div className="terminal-crashed-overlay">
          {exitCodeRef.current !== null
            ? `[Exited (code: ${exitCodeRef.current})]`
            : `[Spawn Error: ${spawnErrorRef.current ?? 'unknown'}]`}
        </div>
      )}
    </div>
  );
});
