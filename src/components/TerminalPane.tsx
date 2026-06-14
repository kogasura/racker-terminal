import React, { memo, useEffect, useRef } from 'react';
import type { Tab } from '../types';
import { useAppStore, selectNextTabId, selectPrevTabId } from '../store/appStore';
import {
  acquireRuntime,
  releaseRuntime,
  createRuntime,
  recyclePty,
  forceDisposeAll,
  fitToConvergence,
  type TerminalRuntime,
} from '../lib/terminalRegistry';
import { resizePty } from '../lib/pty';
import type { PtyEvent } from '../lib/pty';
import '../styles/terminal.css';

// (2.11) spawning タイムアウト定数
export const SPAWN_TIMEOUT_MS = 10_000;
export const SPAWN_TIMEOUT_LABEL = `${SPAWN_TIMEOUT_MS / 1000}s`;

// HMR フック: HMR 更新前に全 runtime を強制破棄して xterm/PTY のリークを防ぐ。
// dispose で PTY を Rust 側に確実に解放 → invalidate で full reload に倒し、
// xterm/React Hook の HMR 互換性問題を回避する設計。
// 注: dispose は TerminalPane.tsx 自身が HMR 更新される場合のみ実行される。
// 親モジュール経由の Fast Refresh では走らない。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    forceDisposeAll();
  });
  import.meta.hot.invalidate();
}

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

/** cwd の末尾フォルダ名を返す（Windows `\` / POSIX `/` 両対応）。取れなければ null。 */
export function cwdBasename(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0 && p !== '~');
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * claude セッション名をシェルへ安全に渡せる単一トークンに整える。
 * 空白は '-' に置換し、制御文字とシェルメタ文字は除去（unicode 文字＝日本語等は許可）。
 * 60 文字に切り詰め、結果が空なら null を返す。
 * → メタ文字を除去するため引用符なしで `-n <token>` に渡しても injection しない。
 */
export function sanitizeSessionName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '') // 許可リスト: unicode文字/数字/._- のみ残す。引用符/$/バッククォート等は除去し injection 防止
    .replace(/-{2,}/g, '-')          // 連続ハイフンを 1 つに圧縮
    .replace(/^[-.]+|[-.]+$/g, '')   // 先頭・末尾のハイフン/ドットを除去
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Claude タブの自動起動コマンドを算出する。
 *
 * StrictMode の effect 二重実行でも claudeSessionId が割れないよう、引数の closure ではなく
 * store の最新値 (getState) を読む。1 回目の発番＋保存を 2 回目が観測して再発番しないため、
 * 「起動した id」と「永続化した id」が必ず一致する。
 *
 * - launchClaude でない → undefined（自動起動なし）
 * - claudeSessionId 済み（復元・recycle・再オープン）→ `claude --resume <id>`
 * - 未設定（新規 Claude タブ）→ uuid 発番＋保存し、`claude --session-id <id> -n <名前>` で起動。
 *   セッション名は タブ名 → cwd フォルダ名 → 'claude' の順（A 方式: 初回固定。以後のタブ
 *   rename はアプリ表示のみで claude 側名称とは独立。resume は UUID で行うため影響なし）。
 */
function computeClaudeBootstrap(tabId: string): string | undefined {
  const tab = useAppStore.getState().tabs[tabId];
  if (!tab?.launchClaude) return undefined;
  if (tab.claudeSessionId) {
    return `claude --resume ${tab.claudeSessionId}`;
  }
  const sessionId = crypto.randomUUID();
  useAppStore.getState().setClaudeSessionId(tabId, sessionId);
  const name =
    sanitizeSessionName(tab.userTitle) ??
    sanitizeSessionName(cwdBasename(tab.cwd)) ??
    'claude';
  return `claude --session-id ${sessionId} -n ${name}`;
}

export const TerminalPane = memo(function TerminalPane({
  tabId,
  tab,
  isActive,
}: TerminalPaneProps) {
  const settings = useAppStore((s) => s.settings);
  const setTabStatus = useAppStore((s) => s.setTabStatus);
  const updateTabOscTitle = useAppStore((s) => s.updateTabOscTitle);

  const divRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<TerminalRuntime | null>(null);
  const exitCodeRef = useRef<number | null>(null);
  const spawnErrorRef = useRef<string | null>(null);

  // 初回 mount [tabId]: acquireRuntime + setOnEvent + 必要なら startSpawn + cleanup
  useEffect(() => {
    const runtime = acquireRuntime(tabId, () =>
      createRuntime(divRef.current!, settings, tabId, {
        onLive: (ptyId) => setTabStatus(tabId, 'live', ptyId),
        // 編集中ガード: editingId === tabId のとき OSC タイトルを無視する
        isEditing: () => useAppStore.getState().editingId === tabId,
        // OSC タイトルを受け取って updateTabOscTitle に渡す（256 文字制限は terminalRegistry 側で適用済み）
        // userTitle を上書きせず oscTitle のみ更新する (A2 の title 構造分離)
        onOscTitle: (title) => updateTabOscTitle(tabId, title),
        // OSC 7 cwd 変更通知を受け取って updateTabCwd に渡す（Phase 4 P-G で追加）
        onCwdChange: (cwd) => useAppStore.getState().updateTabCwd(tabId, cwd),
        // BEL (\x07) 受信: getState() で都度参照し stale closure を回避する（onCwdChange と同パターン）
        // activeTabId は store 側 setTabAttention でも再判定するが、無駄な action 呼び出し
        // 削減と setActiveTab → 直後の BEL という microtask race の早期遮断のため事前チェック。
        onBell: () => {
          const state = useAppStore.getState();
          if (state.activeTabId === tabId) return;
          state.setTabAttention(tabId, true);
        },
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
          args: tab.args,
          env: tab.env,
          cols: Math.max(1, runtime.term.cols || 80),
          rows: Math.max(1, runtime.term.rows || 24),
        },
        (err) => {
          spawnErrorRef.current = err.message;
          setTabStatus(tabId, 'crashed');
        },
        computeClaudeBootstrap(tabId),
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
      try { fitToConvergence(runtime.term, runtime.fitAddon); } catch (e) { console.warn(e); }
      if (runtime.ptyHandle) {
        void resizePty(runtime.ptyHandle.id, runtime.term.cols, runtime.term.rows).catch(() => {});
      }
      runtime.term.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [isActive]);

  // crashed 時は xterm への入力を遮断する（writePty が "session not found" エラーを返すのを防ぐ）
  // restart で live 復帰したとき false に戻ることで入力が再開される
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.term.options.disableStdin = (tab.status === 'crashed');
  }, [tab.status]);

  // (2.11) spawning タイムアウト監視:
  // SPAWN_TIMEOUT_MS 秒経っても live にならない場合は crashed 扱いにする。
  // EDR (企業環境) で OS が hang した場合等にユーザーが無限待機するのを防ぐ。
  // リスク: EDR 環境で誤検知する場合は 30 秒に延長、または Settings 化を検討すること。
  useEffect(() => {
    if (tab.status !== 'spawning') return;

    const timeoutId = setTimeout(() => {
      // タイムアウト経過時点でまだ spawning のままなら crashed 扱いにする
      if (useAppStore.getState().tabs[tabId]?.status === 'spawning') {
        spawnErrorRef.current = `[Spawn timed out (${SPAWN_TIMEOUT_LABEL})]`;
        setTabStatus(tabId, 'crashed');
      }
    }, SPAWN_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
    // setTabStatus は zustand action なので参照不変 (deps に入れても再実行されない)。
    // react-hooks/exhaustive-deps 整合性のため明示的に含めている。
  }, [tab.status, tabId, setTabStatus]);

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
      try { fitToConvergence(runtime.term, runtime.fitAddon); } catch (e) { console.warn(e); }
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

      // IME 合成中の keydown は無視する（タブ切替・タブ閉じの暴発防止）
      // - e.isComposing: 標準仕様（Chromium 含む大部分のブラウザで対応）
      // - e.keyCode === 229: 古い仕様の保険（一部 IME で isComposing が立たないケース）
      // e.preventDefault() は isComposing チェック後に置くことで IME 確定（Enter/Tab）を阻害しない
      if (e.isComposing || e.keyCode === 229) return true;

      // ContextMenu が開いている間はキーバインドを suspend する（C2: 競合防止）
      if (useAppStore.getState().contextMenuOpen) return true;

      // 合成キー対応（Aqua Voice 等の音声入力・支援ツール）:
      // これらは SendInput / 合成 KeyboardEvent でキーを送出するため e.code が
      // 空文字列になることがある（物理スキャンコードを伴わない）。その場合は e.key に
      // フォールバックして物理キー位置の判定を補完する。通常の物理キーボードでは
      // 従来どおり e.code を優先する（CapsLock/AZERTY 等のレイアウト非依存のため）。
      // → これにより Aqua Voice の "Paste Last Transcript"（クリップボード→Ctrl+V）が機能する。
      const codeIs = (code: string, key: string): boolean =>
        e.code === code || (e.code === '' && e.key.toLowerCase() === key);

      // Ctrl+Shift+W: アクティブタブを閉じる
      // e.code ('KeyW') を使うことで CapsLock/AZERTY 等の非 ASCII レイアウトでも
      // 物理 W キーの位置を正確に判定できる（e.key は 'w'/'W'/'z' 等レイアウト依存）
      if (e.shiftKey && codeIs('KeyW', 'w')) {
        e.preventDefault();
        const aid = useAppStore.getState().activeTabId;
        if (aid) useAppStore.getState().removeTab(aid);
        return false;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: 次/前のタブへ移動
      // e.code ('Tab') で物理 Tab キーを判定する（IME 中は e.key === 'Process' になる場合がある）
      if (codeIs('Tab', 'tab')) {
        e.preventDefault();
        const state = useAppStore.getState();
        const next = e.shiftKey ? selectPrevTabId(state) : selectNextTabId(state);
        if (next) state.navigateToTab(next);
        return false;
      }

      // Ctrl+V: クリップボードから貼り付け (v0.5 改善)
      // Windows ターミナル慣習に合わせて Ctrl+V を有効化。Ctrl+Shift+V は予約 (Linux 慣習用)。
      // runtime.writeInput を使うことで spawn 中 (ptyHandle 未確定) でも pendingInputs に積まれる。
      // codeIs により Aqua Voice 等の合成 Ctrl+V（e.code 空）でも貼り付けが発動する。
      if (!e.shiftKey && codeIs('KeyV', 'v')) {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) runtime.writeInput(text);
          })
          .catch((err) => {
            console.warn('[TerminalPane] clipboard.readText failed:', err);
          });
        return false;
      }

      // Ctrl+C: 選択ありならコピー、なしなら SIGINT 通過 (Windows Terminal / VSCode 慣習)
      // - 選択 (空文字列でない) があるときのみコピー・preventDefault する
      // - hasSelection()=true でも getSelection()=='' のような異常系は SIGINT 経路へフォールバック
      // - clearSelection は writeText 成功時のみ実行し、失敗時はリトライできるよう選択を残す
      // - writeText 解決を待つ間にユーザーが新しい選択をした場合、その新選択を消さないよう
      //   getSelection() === sel の同一性チェックを行う
      if (!e.shiftKey && codeIs('KeyC', 'c')) {
        if (runtime.term.hasSelection()) {
          const sel = runtime.term.getSelection();
          if (sel) {
            e.preventDefault();
            navigator.clipboard
              .writeText(sel)
              .then(() => {
                if (runtime.term.getSelection() === sel) {
                  runtime.term.clearSelection();
                }
              })
              .catch((err) => {
                console.warn('[TerminalPane] clipboard.writeText failed:', err);
              });
            return false;
          }
        }
        return true;
      }

      // Ctrl+Enter / Ctrl+NumpadEnter: 改行を挿入 (Claude Code 等 readline 系 CLI で newline 扱い)
      // xterm のデフォルトでは Ctrl+Enter は \r (素の Enter と同じ) を送るため、
      // Claude Code は確定として扱ってしまう。Alt+Enter / Option+Enter と同じ ESC+CR
      // (\x1b\r) を送ることで、Mac Terminal の Option+Enter と同様に改行として認識される。
      // Shift も押されているケース (Ctrl+Shift+Enter) は対象外。
      // runtime.writeInput を使うことで spawn 中でも pendingInputs に積まれて消失しない。
      if (!e.shiftKey && (codeIs('Enter', 'enter') || codeIs('NumpadEnter', 'enter'))) {
        e.preventDefault();
        runtime.writeInput('\x1b\r');
        return false;
      }

      // Ctrl+Shift+T: 閉じたタブを復元
      if (e.shiftKey && codeIs('KeyT', 't')) {
        e.preventDefault();
        useAppStore.getState().restoreLastClosedTab();
        return false;
      }

      // Ctrl+T: 既定タブを開く (Ctrl+Shift+T は閉じたタブの復元)
      // Phase 4 P-H で追加。
      if (!e.shiftKey && codeIs('KeyT', 't')) {
        e.preventDefault();
        useAppStore.getState().spawnDefaultOrNew();
        return false;
      }

      // Ctrl+Shift+1..9: お気に入り index 0..8 を開く
      // e.code は 'Digit1'..'Digit9' / 'Numpad1'..'Numpad9' を許容する。
      // Phase 4 P-H で追加。
      if (e.shiftKey) {
        // 合成キー（e.code 空）では e.key の数字にフォールバックする
        const m = e.code.match(/^(?:Digit|Numpad)([1-9])$/) ||
          (e.code === '' ? e.key.match(/^([1-9])$/) : null);
        if (m) {
          e.preventDefault();
          const idx = parseInt(m[1], 10) - 1;  // 1-9 → 0-8
          useAppStore.getState().spawnFavoriteByIndex(idx);
          return false;
        }
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

  function handleRestart() {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // 1. UI 状態を spawning に更新
    setTabStatus(tabId, 'spawning');
    // 2. xterm を維持して PTY のみ差し替え（scrollback 保全）
    recyclePty(
      tabId,
      {
        shell: tab.shell,
        cwd: tab.cwd,
        args: tab.args,
        env: tab.env,
        cols: Math.max(1, runtime.term.cols || 80),
        rows: Math.max(1, runtime.term.rows || 24),
      },
      (errMsg) => {
        spawnErrorRef.current = errMsg;
        setTabStatus(tabId, 'crashed');
      },
      computeClaudeBootstrap(tabId),
    );
  }

  return (
    <div
      ref={divRef}
      className={`terminal-pane ${isActive ? 'terminal-pane--visible' : 'terminal-pane--hidden'}`}
      inert={!isActive ? true : undefined}
    >
      {isCrashed && isActive && (
        <div className="terminal-crashed-overlay">
          <div className="terminal-crashed-overlay__message">
            {exitCodeRef.current !== null
              ? `[Exited (code: ${exitCodeRef.current})]`
              : `[Spawn Error: ${spawnErrorRef.current ?? 'unknown'}]`}
          </div>
          <button
            type="button"
            className="terminal-crashed-overlay__restart-btn"
            // F6: spawning 中の二重クリック防止（recyclePty の二重実行による PtyHandle.dispose 多重呼び出しを防ぐ）
            disabled={tab.status === 'spawning'}
            onClick={handleRestart}
          >
            Click to restart
          </button>
        </div>
      )}
    </div>
  );
});
