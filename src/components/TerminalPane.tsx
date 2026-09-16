import React, { memo, useEffect, useRef } from 'react';
import type { Tab } from '../types';
import { useAppStore } from '../store/appStore';
import { useEmit } from '../architecture/chain';
import { useTabsView } from '../features/tabs/TabsRoot';
import { tabCommandForKey } from '../features/tabs/keys';
import type { TabsIntent } from '../features/tabs/events';
import { computeClaudeLaunch, isStillSpawning } from '../features/terminalLaunch/launchPlan';
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
import { loadScrollback, RESTORE_BANNER } from '../lib/scrollback';
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

/** PTY イベントの処理に必要な、タブごとの依存をまとめたもの。 */
interface PtyEventContext {
  runtime: TerminalRuntime;
  tabId: string;
  setTabStatus: ReturnType<typeof useAppStore.getState>['setTabStatus'];
  exitCodeRef: React.MutableRefObject<number | null>;
  spawnErrorRef: React.MutableRefObject<string | null>;
}

function handlePtyEvent(e: PtyEvent, ctx: PtyEventContext) {
  const { runtime, tabId, setTabStatus, exitCodeRef, spawnErrorRef } = ctx;
  switch (e.type) {
    case 'data':
      // 非アクティブタブでも継続してスクロールバックに蓄積する。
      // #4: writeOutput 経由でフロー制御（未 parse 量が high watermark を超えたら read を pause）。
      runtime.writeOutput(e.text);
      break;
    case 'exit':
      exitCodeRef.current = e.code ?? null;
      setTabStatus(tabId, 'crashed');
      // #6: 自然終了した Rust セッションを即時解放する（残留・スレッドハンドルリーク防止）。
      runtime.reclaimPty();
      break;
    case 'error':
      spawnErrorRef.current = e.message;
      setTabStatus(tabId, 'crashed');
      // #6: エラー終了した Rust セッションを即時解放する。
      runtime.reclaimPty();
      break;
  }
}

/**
 * e.code を優先しつつ、合成キー (e.code 空) では e.key にフォールバックする判定。
 *
 * 合成キー対応（Aqua Voice 等の音声入力・支援ツール）:
 * これらは SendInput / 合成 KeyboardEvent でキーを送出するため e.code が
 * 空文字列になることがある（物理スキャンコードを伴わない）。通常の物理キーボードでは
 * 従来どおり e.code を優先する（CapsLock/AZERTY 等のレイアウト非依存のため）。
 */
type CodeIs = (code: string, key: string) => boolean;

interface KeyBinding {
  /** このバインドに該当するか。 */
  match: (e: KeyboardEvent, codeIs: CodeIs) => boolean;
  /**
   * 実行する。戻り値は attachCustomKeyEventHandler のもの。
   * false → xterm が通常処理しない、true → 通常処理を継続。
   */
  run: (e: KeyboardEvent, runtime: TerminalRuntime) => boolean;
}

/**
 * Ctrl 系のキーバインド。**先頭から順に評価し、最初に match したものだけを実行する**ので
 * 並び順に意味がある（例: Ctrl+Shift+T を Ctrl+T より先に置く）。
 */
const CTRL_KEY_BINDINGS: KeyBinding[] = [
  {
    // Ctrl+V: クリップボードから貼り付け (v0.5 改善)
    // Windows ターミナル慣習に合わせて Ctrl+V を有効化。Ctrl+Shift+V は予約 (Linux 慣習用)。
    // runtime.writeInput を使うことで spawn 中 (ptyHandle 未確定) でも pendingInputs に積まれる。
    // codeIs により Aqua Voice 等の合成 Ctrl+V（e.code 空）でも貼り付けが発動する。
    match: (e, codeIs) => !e.shiftKey && codeIs('KeyV', 'v'),
    run: (e, runtime) => {
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
    },
  },
  {
    // Ctrl+C: 選択ありならコピー、なしなら SIGINT 通過 (Windows Terminal / VSCode 慣習)
    // - 選択 (空文字列でない) があるときのみコピー・preventDefault する
    // - hasSelection()=true でも getSelection()=='' のような異常系は SIGINT 経路へフォールバック
    // - clearSelection は writeText 成功時のみ実行し、失敗時はリトライできるよう選択を残す
    // - writeText 解決を待つ間にユーザーが新しい選択をした場合、その新選択を消さないよう
    //   getSelection() === sel の同一性チェックを行う
    match: (e, codeIs) => !e.shiftKey && codeIs('KeyC', 'c'),
    run: (e, runtime) => {
      if (!runtime.term.hasSelection()) return true;
      const sel = runtime.term.getSelection();
      if (!sel) return true;

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
    },
  },
  {
    // Ctrl+Enter / Ctrl+NumpadEnter: 改行を挿入 (Claude Code 等 readline 系 CLI で newline 扱い)
    // xterm のデフォルトでは Ctrl+Enter は \r (素の Enter と同じ) を送るため、
    // Claude Code は確定として扱ってしまう。Alt+Enter / Option+Enter と同じ ESC+CR
    // (\x1b\r) を送ることで、Mac Terminal の Option+Enter と同様に改行として認識される。
    // Shift も押されているケース (Ctrl+Shift+Enter) は対象外。
    // runtime.writeInput を使うことで spawn 中でも pendingInputs に積まれて消失しない。
    match: (e, codeIs) =>
      !e.shiftKey && (codeIs('Enter', 'enter') || codeIs('NumpadEnter', 'enter')),
    run: (e, runtime) => {
      e.preventDefault();
      runtime.writeInput('\x1b\r');
      return false;
    },
  },
];

/**
 * Ctrl 系キーのディスパッチ本体。
 *
 * attachCustomKeyEventHandler に渡す実体。戻り値は
 * false → xterm が通常処理しない、true → 通常処理を継続。
 * テスト容易性のため export する。
 *
 * ここで直接実行するのは **ターミナル面に閉じた操作** (貼り付け・コピー・改行送出) だけ。
 * タブを開く / 閉じる / 移動するといったアプリ操作は、このキーがたまたまターミナル上で
 * 押されただけなので、イベントとして上へ流し tabs の Mediator に裁定させる。
 *
 * @param emit チェーンへの送出口。
 * @param commandsSuspended コマンドが止まっているか (コンテキストメニュー表示中)。
 *        止まっている間は preventDefault せず、従来どおり xterm に通常処理させる。
 */
export function handleCtrlKey(
  e: KeyboardEvent,
  runtime: TerminalRuntime,
  emit: (event: TabsIntent) => void,
  commandsSuspended: boolean,
): boolean {
  if (e.type !== 'keydown') return true;
  if (!e.ctrlKey) return true;

  // IME 合成中の keydown は無視する（タブ切替・タブ閉じの暴発防止）
  // - e.isComposing: 標準仕様（Chromium 含む大部分のブラウザで対応）
  // - e.keyCode === 229: 古い仕様の保険（一部 IME で isComposing が立たないケース）
  // e.preventDefault() は isComposing チェック後に置くことで IME 確定（Enter/Tab）を阻害しない
  if (e.isComposing || e.keyCode === 229) return true;

  // ContextMenu が開いている間はキーを xterm へ素通しする（C2: 競合防止）。
  // Mediator 側も suspended 中のコマンドを捨てるが、ここで早期に返すのは
  // 「preventDefault するかどうか」を決めるため。
  if (commandsSuspended) return true;

  // アプリ操作 (タブ) が先。ターミナル面の操作とはキーが重ならない。
  const command = tabCommandForKey(e);
  if (command) {
    e.preventDefault();
    emit(command);
    return false;
  }

  const codeIs: CodeIs = (code, key) =>
    e.code === code || (e.code === '' && e.key.toLowerCase() === key);

  const binding = CTRL_KEY_BINDINGS.find((b) => b.match(e, codeIs));
  if (binding === undefined) return true;
  return binding.run(e, runtime);
}

export const TerminalPane = memo(function TerminalPane({
  tabId,
  tab,
  isActive,
}: TerminalPaneProps) {
  const settings = useAppStore((s) => s.settings);
  const setTabStatus = useAppStore((s) => s.setTabStatus);
  const updateTabOscTitle = useAppStore((s) => s.updateTabOscTitle);

  // タブ操作はイベントとして上へ流す。xterm のキーハンドラは mount 時に 1 度だけ
  // 張るため、最新の値を ref 越しに読む (張り直すと入力が取りこぼされる)。
  const emit = useEmit<TabsIntent>();
  const { commandsSuspended } = useTabsView();
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const suspendedRef = useRef(commandsSuspended);
  suspendedRef.current = commandsSuspended;

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
        // エージェント状態検出: Claude タブでのみ有効にする。
        // コールバックを渡さない = そのタブでは検出処理自体が動かない (terminalRegistry 参照)。
        // getState() で都度参照し stale closure を回避する（onCwdChange と同パターン）。
        // アクティブタブへの blocked/done 抑止は store 側 setTabAgentState が担う。
        onAgentState: tab.launchClaude
          ? (agentState) => useAppStore.getState().setTabAgentState(tabId, agentState)
          : undefined,
        // OSC 21337 は Claude タブ以外にも常に登録する。手動で `claude` と打った
        // タブこそ、この経路で状態が取れる価値が大きいため。
        onTabStatusOsc: (agentState) =>
          useAppStore.getState().applyTabStatusOsc(tabId, agentState),
      }),
    );
    runtimeRef.current = runtime;

    runtime.setOnEvent((e) =>
      handlePtyEvent(e, { runtime, tabId, setTabStatus, exitCodeRef, spawnErrorRef }),
    );

    if (tab.status === 'spawning') {
      // 前回の画面内容が残っていれば、新しいプロセスの出力より先に書き戻す。
      // 「タブは復元されたが中身は空」を避けるための表示専用の復元で、
      // PTY とは無関係（プロセスは復活しない）。
      //
      // fire-and-forget にしているのは、読み込みを待つと起動が遅れるため。
      // 復元内容が後から差し込まれても、区切り (RESTORE_BANNER) があるので
      // どこまでが過去の出力かは読み取れる。
      void loadScrollback(tabId).then((saved) => {
        if (saved !== null && saved.length > 0) {
          runtime.term.write(saved + RESTORE_BANNER);
        }
      });

      // Claude タブの起動方法を算出する。WSL は args に直接 exec を注入し、
      // Windows ネイティブ等は bootstrap をシェルへタイプ送信する（computeClaudeLaunch 参照）。
      const { args: launchArgs, bootstrap } = computeClaudeLaunch(tabId, tab.args);
      runtime.startSpawn(
        {
          shell: tab.shell,
          cwd: tab.cwd,
          args: launchArgs,
          env: tab.env,
          cols: Math.max(1, runtime.term.cols || 80),
          rows: Math.max(1, runtime.term.rows || 24),
        },
        (err) => {
          spawnErrorRef.current = err.message;
          setTabStatus(tabId, 'crashed');
        },
        bootstrap,
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

  // isActive 切替 [isActive]: WebGL wake + rAF で fit + resizePty + term.focus
  useEffect(() => {
    if (!isActive) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;

    // #3: アクティブ化時に WebGL renderer を wake する（未生成なら生成、生成済みなら LRU 更新）。
    // 非アクティブタブは #2 の画面外化で描画停止済みなので、WebGL context はアクティブ時だけ
    // 保持すれば十分。これにより同時ライブ context を MAX_WEBGL_CONTEXTS 以下に抑える。
    runtime.wakeWebgl();

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
      if (isStillSpawning(tabId)) {
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

    runtime.term.attachCustomKeyEventHandler((e) =>
      handleCtrlKey(e, runtime, emitRef.current, suspendedRef.current),
    );
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
    //    Claude タブは computeClaudeLaunch で WSL=直接 exec / 非 WSL=タイプ送信を切り替える。
    const { args: launchArgs, bootstrap } = computeClaudeLaunch(tabId, tab.args);
    recyclePty(
      tabId,
      {
        shell: tab.shell,
        cwd: tab.cwd,
        args: launchArgs,
        env: tab.env,
        cols: Math.max(1, runtime.term.cols || 80),
        rows: Math.max(1, runtime.term.rows || 24),
      },
      (errMsg) => {
        spawnErrorRef.current = errMsg;
        setTabStatus(tabId, 'crashed');
      },
      bootstrap,
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
