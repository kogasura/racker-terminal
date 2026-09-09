import { Terminal as XTerm, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { PtyHandle, PtyEvent, SpawnOptions } from './pty';
import type { Settings, AgentState } from '../types';
import { spawnPty, writePty, resizePty, setReadPaused } from './pty';
import { isAllowedUrl } from './urlValidator';
import { createLinkHandler } from './linkHandler';
import { isWslShell, parseWslArgs } from './profileTemplates';
import { readBottomSnapshot, classifyAgentState, AGENT_SETTLE_MS } from './agentState';
import {
  parseTabStatusOsc,
  agentStateFromTabStatus,
  isTabStatusCleared,
} from './tabStatusOsc';
import { SAVE_SCROLLBACK_LINES } from './scrollback';

/**
 * Claude Code がタブ状態を送ってくる OSC の番号。
 * Claude Code の実装上の定数 `TAB_STATUS: 21337` に対応する。
 */
const TAB_STATUS_OSC = 21337;

interface WebglRendererHandle {
  /** dispose() で WebGL addon と onContextLoss listener を解放 */
  dispose: () => void;
}

/**
 * fit を「提案寸法が現在の cols/rows と一致する」まで収束ループする。
 *
 * 背景: xterm の文字セル実測値 (cell metric) は早期に測り損ねることがあり
 * (例: ウィンドウ拡大直後は古い小さいセル幅のまま)、その状態で fitAddon.fit() を
 * 1 回呼ぶと「古いセルで計算した cols/rows」に resize → その resize が xterm の
 * セル再測定を誘発して値が変わり、結果として端末がペインからはみ出す/空く。
 * fit() 自身が自分の入力 (セル幅) を無効化するため、単発では収束しない。
 *
 * resize() がセル再測定を同期的に起こすため、ここで proposeDimensions() が
 * 安定する (= もう変化しない) まで最大 maxIter 回 fit() を繰り返せば収束する。
 * 実測では 2 反復で安定する。maxIter は万一の振動に対する安全弁。
 */
export function fitToConvergence(term: XTerm, fitAddon: FitAddon, maxIter = 5): void {
  for (let i = 0; i < maxIter; i++) {
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = fitAddon.proposeDimensions();
    } catch {
      return;
    }
    if (!proposed) return;
    if (proposed.cols === term.cols && proposed.rows === term.rows) return; // 収束
    try {
      fitAddon.fit();
    } catch (e) {
      console.warn('[terminalRegistry] fitToConvergence: fit failed', e);
      return;
    }
  }
}

/**
 * xterm に WebGL renderer を attach する。
 * - new WebglAddon() / term.loadAddon() で失敗した場合は Canvas fallback (warn ログ)
 * - GPU context loss 時は WebglAddon を dispose して DOM renderer へフォールバック
 *   (warn ログのみ。画面には書き込まない)
 * - onContextLoss の IDisposable を保持し、dispose 時に解除
 *
 * 注意: WebView2/Chromium の WebGL context 上限は 16 個 (デフォルト)。
 *       17 個目以降を開くと一番古い context が強制 lose されるため、大量タブ運用時は
 *       context loss が常態化する可能性がある (compatibility-matrix.md 既知リスク参照)。
 *
 * new WebglAddon() は preserveDrawingBuffer=false (デフォルト)。
 * スクリーンショット機能を Phase 4 で追加する場合は要再検討。
 */
export function setupWebglRenderer(term: XTerm, tabId: string): WebglRendererHandle {
  let webglAddon: WebglAddon | null = null;
  let ctxLossSub: { dispose(): void } | null = null;

  try {
    webglAddon = new WebglAddon();
    // onContextLoss は IEvent<void> を返す。IDisposable を保持して dispose で解除
    ctxLossSub = webglAddon.onContextLoss(() => {
      // ここで term.write して画面に通知しないこと。term.write は PTY データと同じ
      // 書き込みキュー (TerminalPane の handlePtyEvent → 本ファイルの writeOutput) に
      // 割り込むため、
      //  - 全画面 TUI (Claude Code 等) の画面を 2 行ずらして描画を崩す
      //  - PTY チャンクの境界がエスケープシーケンスの途中だと、注入した文字列が
      //    そのシーケンスの一部として解釈される
      //  - onWriteParsed が発火して agent 状態が 'working' に誤検知される
      // という副作用がある。fallback 後も xterm は DOM renderer で描き続け、
      // ユーザーが取れる対処も無いので通知はログだけに留める。
      console.warn(
        `[terminalRegistry] WebGL context lost for tab ${tabId}, falling back to the DOM renderer`,
      );
      // context は既にロスト済みなので loseContext は不要。addon を dispose して null 化する。
      webglAddon?.dispose();
      // 注: webglAddon = null とすることで以降の dispose() 内 webglAddon?.dispose() を no-op 化
      webglAddon = null;
    });
    term.loadAddon(webglAddon);
  } catch (e) {
    console.warn(
      `[terminalRegistry] WebGL addon failed to load for tab ${tabId}, using Canvas:`,
      e,
    );
    // 初期化失敗時のクリーンアップ。構築済みなら context を明示解放してから dispose する。
    ctxLossSub?.dispose();
    ctxLossSub = null;
    if (webglAddon) forceLoseWebglContext(webglAddon);
    webglAddon?.dispose();
    webglAddon = null;
  }

  return {
    dispose: () => {
      ctxLossSub?.dispose();
      // WebGL context を GPU レベルで明示解放してから addon を dispose する（#1）。
      // dispose() だけでは context が GC まで残り、WebView2/Chromium の 16-context 上限を
      // 圧迫してゾンビ context を積み上げるため、必ず loseContext を先に呼ぶ。
      if (webglAddon) forceLoseWebglContext(webglAddon);
      webglAddon?.dispose();
    },
  };
}

/**
 * WebglAddon が内部で保持する WebGL2 コンテキストを明示的に解放する（#1）。
 *
 * 背景: @xterm/addon-webgl 0.19.0 の dispose() は canvas を DOM から外して JS 参照を
 * 捨てるだけで、WEBGL_lose_context.loseContext() を呼ばない。WebView2/Chromium では
 * GPU プロセスが保持するコンテキストの GC 回収が大幅に遅延するため、タブ開閉のたびに
 * 「ゾンビ WebGL コンテキスト」が積み上がり、~16 個の上限に達すると新規確保のたびに
 * 最古が強制ロストされ、context loss の嵐で GPU/UI が固まる（本 issue の主因）。
 *
 * addon は context 解放 API を公開していないため、内部 renderer が持つ WebGL canvas
 * (`_renderer._canvas`) から webgl2 コンテキストを取得して loseContext() を呼ぶ。
 * getContext('webgl2') は同一 canvas に対して冪等（生成済みコンテキストを返す）なので
 * 追加のコンテキストは作られない。addon の内部構造はバージョン依存のため、取得できない
 * 場合や例外時は握り潰して従来どおり dispose にフォールバックする。
 */
function forceLoseWebglContext(webglAddon: WebglAddon): void {
  try {
    const canvas = (
      webglAddon as unknown as { _renderer?: { _canvas?: HTMLCanvasElement } }
    )._renderer?._canvas;
    const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null | undefined;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch (e) {
    console.warn('[terminalRegistry] forceLoseWebglContext failed:', e);
  }
}

/**
 * xterm に WebLinksAddon を attach する。
 *
 * Ctrl+クリック (Mac では Cmd+クリック) のみをトリガとする理由:
 * 端末上ではプロンプト編集でクリックしてカーソル移動することが多く、
 * 単純クリックでは誤発火が起きやすい。Windows Terminal / VSCode ターミナルも同様の設計。
 *
 * スキーム allowlist を設ける理由:
 * ターミナル出力は untrusted。javascript:/file:/data: 等の危険スキームを
 * isAllowedUrl で弾くことで XSS / ローカルファイル開示を防ぐ。
 */
function setupWebLinks(term: XTerm): { dispose: () => void } {
  // setupWebglRenderer と同様、addon 初期化失敗時にタブ全体を初期化不能にしないよう
  // try/catch で握り、失敗時は no-op handle を返してリンク機能だけ無効化する。
  // loadAddon 段階で throw しても構築済み addon を leak させないよう addon 変数を外に持つ。
  let addon: WebLinksAddon | null = null;
  try {
    addon = new WebLinksAddon((event, uri) => {
      // 左クリック (button=0) のみ受け付ける。click イベントは通常 button=0 のみ発火するが、
      // addon が将来 auxclick を採用したケースに備えた防御
      if (event.button !== 0) return;
      // Ctrl+クリック (or Mac の Cmd+クリック) のときのみ開く
      if (!event.ctrlKey && !event.metaKey) return;
      // 危険スキーム (javascript:/file:/data: 等) を弾く
      if (!isAllowedUrl(uri)) return;
      // PII (社内 URL / トークン付き URL) ログ漏洩を避けるため、エラーオブジェクトのみ出して URL は出さない
      void openUrl(uri).catch((e) => {
        console.warn('[terminalRegistry] openUrl failed:', e);
      });
    });
    term.loadAddon(addon);
    const attached = addon;
    return { dispose: () => attached.dispose() };
  } catch (e) {
    console.warn('[terminalRegistry] WebLinks addon failed to load, links disabled:', e);
    // setupWebglRenderer と同じく、loadAddon 段階で throw した場合の構築済み addon リークを防ぐ
    try { addon?.dispose(); } catch {}
    return { dispose: () => {} };
  }
}

/**
 * IME 合成ガードの内部状態 (read-only スナップショット)。テスト用に公開する。
 * - isComposing: 合成中フラグ。compositionstart で true、compositionend で false。
 * - isFinalizingComposition: compositionend 直後のグレース期間フラグ。
 *   xterm.js CompositionHelper._finalizeComposition(true) は setTimeout(0) で
 *   triggerDataEvent を遅延発火する設計のため、その遅延 onData が届くまでの
 *   1 tick を「合成中フラグが true でも data を通過させる」グレース期間として保護する。
 */
export interface ImeGuardState {
  readonly isComposing: boolean;
  readonly isFinalizingComposition: boolean;
}

interface MutableImeGuardState {
  isComposing: boolean;
  isFinalizingComposition: boolean;
  /** グレース期間解除用タイマー ID。dispose / 次回 compositionend で clear される。 */
  finalizeTimerId: ReturnType<typeof setTimeout> | null;
}

/**
 * IME 合成ガード ハンドル。createRuntime 以外から使うのはテストのみ。
 */
export interface ImeGuardHandle {
  readonly state: ImeGuardState;
  /** onData 内で「この入力を drop すべきか」を判定する。 */
  shouldDrop(): boolean;
  /** dispose 時に pending な setTimeout をキャンセルする。 */
  dispose(): void;
}

/**
 * xterm の textarea に IME 合成ガード listener を attach する。
 *
 * **動作:**
 * - compositionstart: `isComposing=true`。`isFinalizingComposition` と pending タイマーは
 *   敢えて触らない（後述の race condition 対策のため、グレース期間は最後まで開けっ放しにする）。
 * - compositionend: `isComposing=false`、`isFinalizingComposition=true`、`setTimeout(0)` で
 *   グレース期間を 1 tick 後に解除する。pending タイマーがあれば clear して張り直す。
 * - shouldDrop(): `isComposing && !isFinalizingComposition` のとき true (drop)。
 *
 * **race condition 修正の詳細:**
 *
 * 旧実装は compositionend で同期的に `isComposing=false` にしていた。Windows IME で
 * 「日本語を入力 → 変換 → Enter なしで次の日本語を入力」した場合、ブラウザは旧 composition の
 * compositionend と新 composition の compositionstart を同期で連続発火する。一方 xterm.js は
 * `CompositionHelper._finalizeComposition(true)` で `setTimeout(0)` を介して確定文字列を
 * 遅延 triggerDataEvent (= term.onData) する設計。同期イベント連続後に setTimeout が発火する
 * 頃には isComposing が新 composition の compositionstart で true に戻っており、確定文字列の
 * onData が drop されて消失するというバグ。
 *
 * 修正は `isFinalizingComposition` グレース期間フラグを導入。compositionend 時に true にし、
 * `setTimeout(0)` で false に戻す。我々の compositionend listener は xterm のものより**後**に
 * 登録される (term.open() 後に term.textarea へアクセスして addEventListener するため)。
 * 同一 EventTarget 同一 phase の listener は登録順 FIFO 発火、setTimeout も同一 task queue へ
 * FIFO で enqueue されるため、xterm の setTimeout が必ず我々の setTimeout より先に発火する。
 * その時点で isFinalizingComposition=true のため shouldDrop=false となり、確定文字列が通過する。
 *
 * 新 compositionstart で `isFinalizingComposition` を触らない理由: 同期で連続発火するケースで
 * isFinalizingComposition を false にすると xterm の遅延 onData が drop される (元のバグの再現)。
 * 触らないことで、xterm の遅延発火 → 我々のグレース期間解除という順序が保たれる。
 *
 * **未対応のエッジケース:**
 * - グレース期間中 (1 tick) に新 composition が始まり、その中間文字列が xterm の何らかの
 *   経路で onData に届いた場合は通過してしまう。実用上は xterm.js v6 の中間文字列は
 *   `compositionupdate` 内でのみ DOM 表示されるため、onData 経由で届くことはほぼない想定。
 *
 * リスナーは AbortSignal で一括解除される。pending な setTimeout は dispose() で別途 clear する。
 */
export function attachImeCompositionGuard(
  textarea: Pick<EventTarget, 'addEventListener'>,
  signal: AbortSignal,
): ImeGuardHandle {
  const internal: MutableImeGuardState = {
    isComposing: false,
    isFinalizingComposition: false,
    finalizeTimerId: null,
  };

  textarea.addEventListener('compositionstart', () => {
    internal.isComposing = true;
    // isFinalizingComposition と finalizeTimerId は意図的に触らない:
    // 同期 compositionend → compositionstart シーケンスで grace period を維持して
    // xterm の遅延 onData (確定文字列) を通過させるため。
  }, { signal });

  textarea.addEventListener('compositionend', () => {
    internal.isComposing = false;
    internal.isFinalizingComposition = true;
    // 連続 compositionend で setTimeout が積み重ならないよう前回の pending を clear して張り直す。
    if (internal.finalizeTimerId !== null) clearTimeout(internal.finalizeTimerId);
    internal.finalizeTimerId = setTimeout(() => {
      internal.isFinalizingComposition = false;
      internal.finalizeTimerId = null;
    }, 0);
  }, { signal });

  return {
    get state() {
      return {
        isComposing: internal.isComposing,
        isFinalizingComposition: internal.isFinalizingComposition,
      };
    },
    shouldDrop() {
      return internal.isComposing && !internal.isFinalizingComposition;
    },
    dispose() {
      if (internal.finalizeTimerId !== null) {
        clearTimeout(internal.finalizeTimerId);
        internal.finalizeTimerId = null;
      }
    },
  };
}

/**
 * OSC 7 データ文字列を Windows パスに変換する純関数。
 * - data 形式: "file://hostname/C:/Users/foo/path" (Windows) or "file://hostname/home/user" (Linux)
 * - Windows パス ("/C:/" 形式) のみ変換する。Linux パスは null を返す。
 * - Phase 4 P-G で追加。WSL の Linux パス対応は Phase 5 送り。
 *
 * テスト容易性のためモジュール外から import できる形で export する。
 */
export function parseOsc7Path(data: string): string | null {
  // data = "file://hostname/C:/path" のような形式
  const match = data.match(/^file:\/\/[^/]*(.*)$/);
  if (!match) return null;

  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    // F-M1: 不正な %ZZ 等の malformed percent-encoding は無視する
    return null;
  }

  // F-S1: 制御文字フィルタ (NUL/CR/LF/ESC 等 U+0000-U+001F, DEL U+007F)
  if (/[\x00-\x1f\x7f]/.test(path)) return null;

  // Windows パスのみ反映: 先頭が "/X:" の形式 (例: "/C:/Users/foo")
  // Linux パス (例: "/home/user") は無視する (WSL 対応は Phase 5 検討)
  if (!/^\/[a-zA-Z]:/.test(path)) return null;

  // 先頭のスラッシュを除去: "/C:/foo" → "C:/foo"
  path = path.slice(1);
  // スラッシュをバックスラッシュに正規化 (Windows)
  path = path.replace(/\//g, '\\');

  // F-S4: trailing slash 正規化 (ルート "C:\" は維持、それ以外の末尾 \ を除去)
  if (path.length > 3 && path.endsWith('\\')) {
    path = path.slice(0, -1);
  }

  // F-S2: パス長上限 (4KB)
  if (path.length > 4096) return null;

  return path;
}

/**
 * Tokyo Night テーマのデフォルト背景色。
 * applySettings の background 計算および createRuntime の初期 theme 定義で共用する。
 * F-M4: ハードコード hex を 1 箇所に集約する。
 */
const DEFAULT_BG = '#1a1b26';

/**
 * TerminalPane のライフサイクル全体を React 外で管理する runtime。
 * xterm / PTY / onData 購読 / pendingInputs バッファ / 状態フラグのすべての所有者。
 *
 * コア原則: runtime はコンポーネントスコープに依存しない。
 * TerminalPane は acquireRuntime 経由で runtime を取得し、メソッド呼び出しのみ行う。
 */
export interface TerminalRuntime {
  term: XTerm;
  fitAddon: FitAddon;
  /** PTY spawn 完了までは null */
  ptyHandle: PtyHandle | null;
  /** spawn 完了前に xterm が送出した入力（DSR-CPR 等）を貯めるバッファ */
  pendingInputs: string[];
  /** init() 内で 1 度だけ登録する onData 購読。dispose() で解放 */
  onDataSub: IDisposable;
  /**
   * IME 合成リスナーの一括解除用 AbortController。
   * dispose() 内で abort() を呼ぶことで compositionstart/end リスナーをまとめて解除する。
   */
  compositionAbort: AbortController;

  /**
   * PTY イベント受信時のコールバック。
   * TerminalPane の useEffect 内で登録し、cleanup で null を渡す。
   * null の場合 runtime は何もしない（unmount 後の書き込みを防ぐ）。
   */
  setOnEvent(handler: ((e: PtyEvent) => void) | null): void;

  /**
   * PTY spawn を開始する。内部で spawning フラグを管理し、
   * 二重呼び出し（ptyHandle セット済み or spawn 中）は no-op。
   */
  /**
   * @param bootstrap - PTY 起動直後にシェルへ自動入力するコマンド（末尾改行は内部で付与）。
   *   Claude タブの `claude --session-id <id>` / `claude --resume <id>` 自動起動に使う。
   *   pendingInputs を flush した後に 1 回だけ書き込まれる。
   */
  startSpawn(opts: SpawnOptions, onError: (e: Error) => void, bootstrap?: string): void;

  /**
   * recyclePty 専用: 旧 PTY ハンドルを null にして spawning フラグをリセットする。
   * startSpawn の二重起動防止チェックを通過させるために必要。
   * recyclePty 以外から呼ばないこと。
   */
  resetForRecycle(): void;

  /**
   * 任意の入力文字列を PTY に送る (またはバッファに積む)。
   * - dispose 済み: no-op
   * - PTY 未起動 (spawn 中): pendingInputs に積み、startSpawn 完了時にリプレイされる
   * - PTY 起動済み: 即座に writePty に送る
   *
   * onData 経由 (xterm のキー入力) と同じバッファを共有するため、
   * spawn 中の Ctrl+Enter / Ctrl+V 等の特殊ショートカットでも入力が消失しない。
   * 失敗時は fire-and-forget (内部で catch して握りつぶす)。
   *
   * NOTE: 意図的に IME 合成ガード (imeGuard.shouldDrop) を通さない。
   * Ctrl+V / Ctrl+Enter 等は IME 合成中であってもアプリのショートカット文脈で
   * 動作させたいケースがあり、onData 経路 (textarea 入力) と異なる責務を持つ。
   */
  writeInput(data: string): void;

  /**
   * PTY からの出力を xterm に書き込む（#4 フロー制御つき）。
   * term.write のコールバックで未 parse バイト量を追跡し、high watermark 超過で
   * Rust の read を pause、low watermark 到達で resume する。
   * handlePtyEvent の 'data' から呼ぶ。dispose 済みは no-op。
   */
  writeOutput(text: string): void;

  /**
   * このタブの WebGL renderer を有効化する（#3 wake）。
   * - 既に WebGL 済み → LRU を most-recently-used に更新するだけ
   * - 未生成かつ不透明設定 → LRU に空きを作って（超過分は最古タブを sleep）WebGL を生成
   * TerminalPane の isActive effect（アクティブ化時）から呼ぶ。
   */
  wakeWebgl(): void;

  /**
   * このタブの WebGL renderer を破棄して DOM/Canvas renderer にフォールバックする（#3 sleep）。
   * WebGL context を loseContext で解放し、GPU スロットを即座に返す。xterm 本体は維持する。
   * LRU 上限超過時に最古タブに対して自動的に呼ばれる。
   */
  sleepWebgl(): void;

  /**
   * 子プロセスが自然終了/エラー終了したとき、Rust 側 PTY セッションを即時解放する（#6）。
   * Rust の PtyManager は kill 経由でしか sessions から remove しないため、ここで解放しないと
   * exited タブを開いたままにすると未 join スレッドハンドルを含むセッションが残留する。
   * xterm は維持するので restart(recyclePty) で再 spawn できる。
   */
  reclaimPty(): void;

  /**
   * OSC タイトル変更購読の IDisposable。
   * createRuntime 内で term.onTitleChange を購読して取得する。
   * dispose() の中で titleSub.dispose() を呼ぶ。
   */
  titleSub: IDisposable;

  /**
   * OSC 7 (cwd 変更通知) 購読の IDisposable。
   * createRuntime 内で term.parser.registerOscHandler(7, ...) で取得する。
   * dispose() の中で oscSub.dispose() を呼ぶ (titleSub の後)。
   * Phase 4 P-G で追加。
   */
  oscSub: { dispose: () => void };

  /**
   * BEL (\x07) 受信購読の IDisposable。
   * createRuntime 内で term.onBell を購読して取得する。
   * dispose() の中で oscSub.dispose() の隣に配置して解放する。
   *
   * BEL は「処理が完了した」合図としてエージェント状態検出 (agentState) の材料になる。
   */
  bellSub: IDisposable;

  /**
   * 画面書き込み完了 (onWriteParsed) 購読の IDisposable。
   * エージェント状態検出で「出力が動いている / 止まった」を検知するために使う。
   * dispose() の中で bellSub.dispose() の直後に解放する。
   */
  writeParsedSub: IDisposable;

  /**
   * OSC 21337 (TAB_STATUS) 購読の解放ハンドル。
   * dispose() の中で writeParsedSub.dispose() の直後に解放する。
   */
  tabStatusSub: { dispose: () => void };

  /**
   * 現在の画面内容を ANSI 付きの文字列にして返す。
   *
   * 再起動後に「タブは戻るが中身は空」にならないよう、定期的に呼んで保存する。
   * dispose 済みの場合は空文字を返す。
   */
  serializeScreen(): string;

  /**
   * 前回の問い合わせ以降にこの端末へ書き込みがあったかを返し、フラグを false に戻す。
   *
   * 定期保存で「内容が変わっていないタブの serialize を丸ごと省く」ために使う。
   * serialize は 1 タブあたり数 ms かかり、タブ数ぶん同期で回すと UI が止まる。
   *
   * 読むと消える (consume) 形にしているのは、判定と消費が離れると「消し忘れて毎回
   * 保存する」「消しっぱなしで二度と保存しない」のどちらにも倒れるため。
   * 生成直後は true で、一度も出力が無いタブでも最低 1 回は保存の機会を持つ。
   */
  consumeScreenDirty(): boolean;

  /**
   * WebLinksAddon のライフサイクルハンドル。
   * createRuntime 内で setupWebLinks(term) を呼んで取得する。
   * dispose() の中で bellSub.dispose() の直後 (= webglHandle?.dispose() の前) に呼ぶ。
   */
  webLinksHandle: { dispose: () => void };

  /**
   * Settings が変化したとき全タブの xterm オプションをリアクティブに更新する。
   * App.tsx の useAppStore.subscribe から全 runtime に broadcast して呼ぶ。
   * fontSize / fontFamily / scrollback を term.options に直接書き込む。
   */
  applySettings(settings: Settings): void;

  /**
   * 全リソース解放。§3.2 の順序を厳守。
   * ResizeObserver の disconnect は TerminalPane の useEffect cleanup 側の責務。
   */
  dispose(): void;
}

interface Entry {
  refs: number;
  runtime: TerminalRuntime;
}

const runtimes = new Map<string, Entry>();

// ─── WebGL context の LRU 上限管理（#3 Sleep/Wake） ──────────────────────────
//
// WebView2/Chromium の WebGL context 上限は 16 個（compatibility-matrix.md 参照）。
// 上限を越えると新規確保のたびに最古 context が強制ロストされ、context loss の嵐で
// GPU/UI が固まる。これを防ぐため「同時にライブな WebGL context 数」を上限以下に抑える。
//
// 方針: WebGL は遅延生成し（アクティブ化時に wakeWebgl で生成）、直近で使ったタブだけが
// context を保持する。上限を越えたら最も古い（LRU）タブの WebGL を dispose(loseContext)
// して DOM/Canvas renderer にフォールバック（sleep）する。非アクティブタブは #2 により
// 描画自体が停止しているため、DOM renderer でも描画コストは発生しない。

/**
 * 同時にライブに保つ WebGL context の最大数。Chromium の 16 上限に対する安全マージン。
 * これ以下に保つことで context loss の嵐を構造的に回避する。
 */
export const MAX_WEBGL_CONTEXTS = 8;

/** WebGL context を保持しているタブ ID の LRU 配列（末尾が most-recently-used）。 */
const webglLru: string[] = [];

/**
 * この runtime が GPU (WebGL) 描画を使いたいかを決める純関数。
 *
 * 2 つの理由で false になる:
 * - **設定で GPU 描画を切っている** — WebGL renderer のグリフキャッシュ破損
 *   （文字が空白になる / 別の字に化ける）を踏んだときの逃げ道。
 * - **透明度 < 1.0** — xterm の WebglAddon は theme.background の alpha を
 *   尊重しない（canvas が opaque）ため、透明時は使えない。
 *
 * どちらの場合も DOM renderer にフォールバックする。テスト用に export する。
 */
export function computeWebglDesired(gpuAcceleration: boolean, transparency: number): boolean {
  return gpuAcceleration && transparency >= 1.0;
}

/**
 * exceptId を新たに WebGL 化する前に、上限を超えないよう LRU 先頭（古い方）から
 * 間引くべき victim id 一覧を返す純関数。lru から victim を取り除く副作用を持つ。
 * exceptId 自身は（保険として）victim にしない。テスト用に export する。
 */
export function reserveWebglLru(lru: string[], exceptId: string, max: number): string[] {
  const evicted: string[] = [];
  // exceptId を push した後に max 以下になるよう先頭から間引く
  while (lru.length + 1 > max && lru.length > 0) {
    const victim = lru[0];
    if (victim === exceptId) break; // 通常 exceptId は未登録。保険。
    lru.shift();
    evicted.push(victim);
  }
  return evicted;
}

/**
 * 既に LRU に居る id を most-recently-used（末尾）へ移動する純関数。
 * 居なければ何もしない（新規追加は wake 側で push する）。テスト用に export する。
 */
export function promoteWebglLru(lru: string[], id: string): void {
  const i = lru.indexOf(id);
  if (i !== -1) {
    lru.splice(i, 1);
    lru.push(id);
  }
}

/** LRU から id を取り除く（sleep / dispose 時）。 */
function dropFromWebglLru(id: string): void {
  const i = webglLru.indexOf(id);
  if (i !== -1) webglLru.splice(i, 1);
}

// ─── 書き込みフロー制御（#4 back-pressure）の watermark ──────────────────────
//
// Tauri Channel は Rust→JS へ流量制御なしにイベントを送るため、UI スレッドが詰まると
// xterm の書き込みバッファ（実測 ~500KB の滞留で既に応答不能になる）とイベントキューが
// 無制限に膨らむ。term.write のコールバックで「未 parse バイト量」を追跡し、high を
// 超えたら Rust の read を止め、low まで捌けたら再開する。

/** これを超えたら PTY read を pause する（未 parse バイト量, UTF-16 code unit 換算）。 */
export const WRITE_HIGH_WATERMARK = 1_000_000;
/** ここまで捌けたら PTY read を resume する。 */
export const WRITE_LOW_WATERMARK = 200_000;

/**
 * 未処理バイト量と現在の pause 状態から、次の pause 状態を返す純関数（ヒステリシス付き）。
 * high 以上で pause、low 以下で resume、中間は現状維持。テスト用に export する。
 */
export function nextPauseState(
  outstanding: number,
  paused: boolean,
  high: number = WRITE_HIGH_WATERMARK,
  low: number = WRITE_LOW_WATERMARK,
): boolean {
  if (!paused && outstanding >= high) return true;
  if (paused && outstanding <= low) return false;
  return paused;
}

/**
 * TerminalRuntime を生成する内部ファクトリ。
 * TerminalPane からは createRuntime() 経由で呼ぶ。
 * テスト容易性のためモジュール外から import できる形で公開する。
 */
export function createRuntime(
  divEl: HTMLDivElement,
  settings: Settings,
  tabId: string,
  callbacks: {
    onLive: (ptyId: string) => void;
    /**
     * OSC タイトル変更時のコールバック。
     * - isEditing: 現在タブ名を編集中かどうか（true のとき no-op）
     * - title: OSC から受け取った新しいタイトル（256 文字に切り詰め済み）
     * TerminalPane の useEffect 内で `() => useAppStore.getState().editingId === tabId`
     * と `(t) => updateTabTitle(tabId, t)` を渡す。
     */
    isEditing: () => boolean;
    onOscTitle: (title: string) => void;
    /**
     * OSC 7 (cwd 変更通知) 受信時のコールバック。
     * parseOsc7Path で Windows パスに変換済みの値が渡される。
     * TerminalPane の useEffect 内で `(cwd) => updateTabCwd(tabId, cwd)` を渡す。
     * Phase 4 P-G で追加。
     */
    onCwdChange: (cwd: string) => void;
    /**
     * エージェント状態が変化したときのコールバック。
     *
     * **このコールバックを渡したタブでのみ状態検出が動く。** Claude タブ (launchClaude=true)
     * にのみ渡し、通常のシェルタブでは undefined にすることで検出コストを払わない
     * （herdr が前景プロセスでエージェントを識別しているのに相当する)。
     *
     * 同じ状態が続く間は再通知しない（変化時のみ発火）。
     */
    onAgentState?: (state: AgentState) => void;
    /**
     * OSC 21337 (TAB_STATUS) 受信時のコールバック。
     *
     * Claude Code が端末へ直接送ってくる状態。`null` は表示の解除（claude の終了）。
     *
     * `onAgentState`（画面パターン判定）と違い **Claude タブ以外にも常に登録する**。
     * 手動で `claude` と打ったタブこそ、この経路で状態が取れる価値が大きいため。
     * OSC が来ないタブでは何も起きないのでコストもない。
     */
    onTabStatusOsc?: (state: AgentState | null) => void;
  },
): TerminalRuntime {
  let onEventHandler: ((e: PtyEvent) => void) | null = null;
  let isDisposed = false;
  let spawning = false;
  /**
   * WSL タブなら distro 名 (`-d` 未指定なら空文字)、それ以外のタブは undefined。
   * startSpawn で確定させ、linkHandler が file:// リンクの解決に使う。
   * sleep/wake の再 spawn でも起動引数から取り直される。
   */
  let wslDistro: string | undefined;
  // F-M3: applySettings で前回の transparency を保持し、不要な theme 再構築を回避する
  let lastTransparency: number = settings.transparency ?? 1.0;

  const term = new XTerm({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    scrollback: settings.scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    // OSC 8 ハイパーリンク (Claude Code の file:// リンク等) の受け口。
    // 未設定だと xterm は警告付き confirm ダイアログを出す。linkHandler.ts 参照。
    linkHandler: createLinkHandler({ getWslDistro: () => wslDistro }),
    // v0.5 改善: 透明背景を有効化する (xterm.js の必須オプション)
    // theme.background に rgba/transparent を設定するときに必要。
    // false (default) だと alpha が無視されて opaque で描画される。
    allowTransparency: true,
    theme: {
      // v0.5 改善: 初期 theme.background も transparency を反映する
      // (旧実装は DEFAULT_BG 固定で、新規タブが常に不透明になっていた)
      background: computeBackground(lastTransparency),
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
  });

  term.open(divEl);

  // 配布バイナリでバンドル済の MonaspiceNe NF が初回起動時にロードされる前に WebGL atlas が
  // 焼かれるとフォールバック (Cascadia 等) で描画される問題を防ぐため、フォントロード完了後に
  // fontFamily を再代入して atlas を強制再生成する (Phase 4 P-D で追加)。
  void document.fonts.load(`${settings.fontSize}px "MonaspiceNe NF"`).then(() => {
    if (isDisposed) return;
    // 同じ値を代入することで xterm-webgl の atlas 再生成をトリガーする
    term.options.fontFamily = settings.fontFamily;
  }).catch(() => {});

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  // 画面内容のシリアライズ用。再起動後にタブの中身を復元するために使う。
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  // WebGL renderer は「遅延生成 + LRU 上限」で管理する（#3 Sleep/Wake）。
  // 従来は createRuntime で即 attach していたが、全タブ分の context が常駐して
  // WebView2/Chromium の 16-context 上限を越え、context loss の嵐で固まっていた。
  // 生成はアクティブ化時の wakeWebgl に委ね、直近で使ったタブだけが context を保持する。
  //
  // webglDesired: WebGL を使いたいか。設定で GPU 描画を切っているか、透明度 < 1.0 の
  // ときは false になり DOM/Canvas renderer にフォールバックする（computeWebglDesired 参照）。
  let lastGpuAcceleration = settings.gpuAcceleration !== false;
  let webglDesired = computeWebglDesired(lastGpuAcceleration, lastTransparency);
  let webglHandle: WebglRendererHandle | null = null;

  // §3.2 dispose 順序のため、WebGL の sleep/wake はローカルクロージャに集約する。
  // wake: LRU に空きを作って WebGL を生成。sleep: WebGL を loseContext 込みで破棄。
  function wakeWebglLocal(): void {
    if (isDisposed || !webglDesired) return;
    if (webglHandle) {
      // 既に起きている: LRU を most-recently-used に更新するだけ
      promoteWebglLru(webglLru, tabId);
      return;
    }
    // 生成前に上限を確保する（同時ライブ context が一瞬でも MAX を越えないように）
    const evicted = reserveWebglLru(webglLru, tabId, MAX_WEBGL_CONTEXTS);
    for (const victim of evicted) runtimes.get(victim)?.runtime.sleepWebgl();
    webglHandle = setupWebglRenderer(term, tabId);
    webglLru.push(tabId);
  }
  function sleepWebglLocal(): void {
    dropFromWebglLru(tabId);
    if (!webglHandle) return; // 既に sleep 済 or 未生成
    webglHandle.dispose(); // forceLoseWebglContext 込みで context を即解放 → DOM renderer
    webglHandle = null;
  }

  /**
   * 描画に関わる設定（背景透明度・GPU 描画）の変更を反映する。
   *
   * この 2 つは**どちらも WebGL を使えるかを左右する**ため、片方だけ見て判断すると
   * 取りこぼす（例: 透明度は据え置きで GPU 描画だけ切られたケース）。まとめて扱う。
   *
   * F-M3: 変化が無ければ何もしない（theme 再構築は描画コストがかかる）。
   */
  function applyRendererSettings(s: Settings): void {
    const targetAlpha = s.transparency ?? 1.0;
    const targetGpu = s.gpuAcceleration !== false;
    const alphaChanged = lastTransparency !== targetAlpha;
    const gpuChanged = lastGpuAcceleration !== targetGpu;
    if (!alphaChanged && !gpuChanged) return;

    // F-M4: DEFAULT_BG 定数を使用（ハードコード排除）
    if (alphaChanged) {
      lastTransparency = targetAlpha;
      term.options.theme = {
        ...term.options.theme,
        background: computeBackground(targetAlpha),
      };
    }

    // v0.5 改善: 透明度 < 1.0 のとき WebGL は alpha 尊重しないため Canvas にフォールバック。
    // #3: 無効化で sleep（context を loseContext で解放）する。
    // 有効化時の再生成は次回アクティブ化（wakeWebgl）に委ねる。
    lastGpuAcceleration = targetGpu;
    webglDesired = computeWebglDesired(targetGpu, targetAlpha);
    if (!webglDesired) sleepWebglLocal();
  }

  try {
    fitToConvergence(term, fitAddon);
  } catch (e) {
    console.warn('[terminalRegistry] initial fit failed', e);
  }

  const pendingInputs: string[] = [];
  let ptyHandle: PtyHandle | null = null;

  // #4 フロー制御の状態: outstandingBytes = xterm に write 済みだが未 parse のバイト量。
  // readPaused = Rust の read を pause 要求済みか。high/low watermark でヒステリシス制御する。
  let outstandingBytes = 0;
  let readPaused = false;

  // IME 合成ガード: 合成中 (中間文字列) は onData で drop する。
  // 詳細な race condition 対策と設計理由は attachImeCompositionGuard の docstring を参照。
  const compositionAbort = new AbortController();
  // textarea が undefined の場合は no-op ハンドル (常に shouldDrop()=false) を使用する。
  // 通常 term.open(divEl) 後に textarea は必ずセットされるため、ここに入るのは異常系。
  // フォールバック時は IME 中間文字列もそのまま PTY に流れることに注意。
  let imeGuard: ImeGuardHandle;
  const textarea = term.textarea;
  if (textarea) {
    imeGuard = attachImeCompositionGuard(textarea, compositionAbort.signal);
  } else {
    console.warn(
      `[terminalRegistry] term.textarea is undefined; IME composition guard disabled for tab ${tabId}`,
    );
    imeGuard = {
      state: { isComposing: false, isFinalizingComposition: false },
      shouldDrop: () => false,
      dispose: () => {},
    };
  }

  // onData を spawn より先に登録して DSR-CPR 等を pendingInputs に貯める
  const onDataSub = term.onData((data) => {
    if (isDisposed) return;
    if (imeGuard.shouldDrop()) return;
    if (ptyHandle) {
      void writePty(ptyHandle.id, data).catch(() => {});
    } else {
      pendingInputs.push(data);
    }
  });

  // OSC タイトル変更を購読してタブ名を自動更新する。
  // 編集中ガード: callbacks.isEditing() が true のとき OSC を無視してユーザー編集を保護する。
  // 文字長制限: 256 文字に切り詰め。制御文字フィルタ: sanitizeOscTitle を通してから onOscTitle を呼ぶ。
  // F-S6: onOscTitle callback 内の例外を catch して xterm parser に伝播させない。
  const titleSub = term.onTitleChange((title) => {
    if (isDisposed) return;
    if (callbacks.isEditing()) return;
    const sanitized = sanitizeOscTitle(title);
    if (sanitized.length === 0) return;
    try {
      callbacks.onOscTitle(sanitized);
    } catch (e) {
      console.warn('[terminalRegistry] onOscTitle threw:', e);
    }
  });

  // OSC 7 (cwd 変更通知) を購読して tab.cwd を動的追跡する。
  // nushell / PowerShell / fish 等が標準で発信する: ESC ] 7 ; file://hostname/path BEL
  // parseOsc7Path で Windows パスに変換し、Linux パスは無視する (Phase 5 で対応検討)。
  // false を返すことで xterm が他のハンドラにも伝播する (default behavior 維持)。
  // F-S6: onCwdChange callback 内の例外を catch して xterm parser に伝播させない。
  const oscSub = term.parser.registerOscHandler(7, (data) => {
    if (isDisposed) return false;
    const path = parseOsc7Path(data);
    if (path !== null) {
      try {
        callbacks.onCwdChange(path);
      } catch (e) {
        console.warn('[terminalRegistry] onCwdChange threw:', e);
      }
    }
    return false;
  });

  // --- エージェント状態検出 (Claude タブのみ) ---
  //
  // 検出の流れ:
  //   1. 画面に書き込みがある間は暫定的に 'working' を出して即応性を確保する
  //   2. 書き込みが AGENT_SETTLE_MS 途切れたら、落ち着いた画面のスナップショットを
  //      classifyAgentState に渡して状態を確定する
  //   3. BEL は「完了した」フラグとして貯めておき、確定時に材料として消費する
  //
  // 判定そのものは agentState.ts に一本化しており、ここは材料を集めるだけに徹する。
  const agentDetectionEnabled = typeof callbacks.onAgentState === 'function';
  /** 前回の確定以降に BEL を受信したか。確定時に消費して false に戻す。 */
  let bellPending = false;
  /** 出力停止を待つタイマー。書き込みのたびに張り直す。 */
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最後に通知した状態。同値の再通知を抑止して不要な再レンダーを防ぐ。 */
  let lastAgentState: AgentState | null = null;

  function reportAgentState(next: AgentState): void {
    if (lastAgentState === next) return;
    lastAgentState = next;
    try {
      callbacks.onAgentState?.(next);
    } catch (e) {
      console.warn('[terminalRegistry] onAgentState threw:', e);
    }
  }

  /** 出力が止まるのを待って状態を確定する。書き込みのたびに呼んでタイマーを延長する。 */
  function scheduleAgentSettle(): void {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (isDisposed) return;
      const next = classifyAgentState(readBottomSnapshot(term), bellPending);
      // 確定に使った BEL は消費する。持ち越すと、次に出力が落ち着いたときに
      // 完了していないのに 'done' へ戻ってしまう。
      bellPending = false;
      reportAgentState(next);
    }, AGENT_SETTLE_MS);
  }

  // BEL (\x07) を購読する。BEL 自体では状態を確定せず、フラグを立てて確定を促すだけ。
  // Claude は承認プロンプトの提示時にも BEL を鳴らすため、ここで即 'done' にすると
  // 「応答待ちなのに完了と表示される」誤りが起きる（判定順序は classifyAgentState 参照）。
  const bellSub = term.onBell(() => {
    if (isDisposed || !agentDetectionEnabled) return;
    bellPending = true;
    scheduleAgentSettle();
  });

  /**
   * 前回の保存以降に画面へ書き込みがあったか（定期保存の対象判定に使う）。
   *
   * 初期値 true: 復元内容の書き戻しや、ここで把握できていない書き込み経路があっても
   * 最低 1 回は保存されるようにする。空画面なら serialize が空文字を返すので、
   * 余計なファイルが書かれることはない。
   */
  let screenDirty = true;

  // 画面書き込みのパース完了を購読して「出力が動いている」ことを検知する。
  // PTY データは TerminalPane 側の handlePtyEvent から term.write() されるため、
  // 書き込み元に依存しないこのイベントで捕捉する。
  // あわせて定期保存の dirty 判定にも使う（購読が 2 つの役目を持つ）。
  const writeParsedSub = term.onWriteParsed(() => {
    if (isDisposed) return;
    // 定期保存の dirty 判定。writeOutput (PTY 出力) だけを見ると、復元内容の書き戻し
    // (TerminalPane) のような term.write 直呼びを取りこぼす。xterm の write は最終的に
    // 必ずこのイベントを通るので、書き込み元を数え上げずにここ 1 箇所で拾う。
    screenDirty = true;
    if (!agentDetectionEnabled) return;
    // 出力が動いている = 実行中とみなす暫定表示。AGENT_SETTLE_MS 後に確定判定で上書きされる。
    reportAgentState('working');
    scheduleAgentSettle();
  });

  // OSC 21337 (TAB_STATUS): Claude Code が端末タブへ状態を表示させるために送るシーケンス。
  //   ESC ] 21337 ; indicator=#ff9500;status=Working…;status-color=#ff9500 ST
  // セッションファイルのポーリングより確実で、とくに WSL では PTY を流れてくるぶん
  // \\wsl.localhost のパス解決に依存しない。
  //
  // false を返して他のハンドラにも伝播させる（既定動作を妨げない）。
  const tabStatusSub = term.parser.registerOscHandler(TAB_STATUS_OSC, (data) => {
    if (isDisposed) return false;
    try {
      const payload = parseTabStatusOsc(data);
      if (isTabStatusCleared(payload)) {
        callbacks.onTabStatusOsc?.(null);
      } else {
        const state = agentStateFromTabStatus(payload);
        if (state !== undefined) callbacks.onTabStatusOsc?.(state);
      }
    } catch (e) {
      console.warn('[terminalRegistry] onTabStatusOsc threw:', e);
    }
    return false;
  });

  // OSC 10/11 (default foreground/background color): 「設定」だけを抑止し、「クエリ」は通す。
  //
  // 抑止する理由 (v0.5 からの意図): nushell / PowerShell 等が起動時に OSC 11 で背景色を
  // 設定すると、我々の theme.background (transparency 設定) が上書きされて不透明になる。
  //
  // 一方 ESC ] 11 ; ? BEL は「背景色を教えて」という問い合わせで、vim / neovim 等が
  // background=dark|light の判定に使う。ここを一律 true で潰すと応答が返らず、
  // 明るい背景と誤認して見づらい配色を選ばれたり、応答待ちで起動が遅れたりする。
  // クエリだけ false を返して xterm の setOrReportFgColor / setOrReportBgColor に委ね、
  // ESC ] 11 ; rgb:1a1a/1b1b/2626 ST を PTY へ返させる。
  const osc10Sub = term.parser.registerOscHandler(10, (data) => !isSpecialColorQuery(data));
  const osc11Sub = term.parser.registerOscHandler(11, (data) => !isSpecialColorQuery(data));

  // OSC 110/111 (reset default fg/bg) は抑止のまま。ただし理由は「shell preference に
  // 戻されるから」ではない: xterm の復元先は ThemeService が theme 設定時に取った我々自身の
  // スナップショットで、上記のとおり set を抑止している限り復元しても値は変わらない。
  // にもかかわらず restoreColor は必ず onChangeColors を発火し、WebglRenderer は
  // charAtlas 再取得 + 全画面再構築を走らせる。得るものが無いのにコストだけ払う形なので
  // 通さない。110/111 は payload を持たずクエリ形式も無いので、応答待ちも起きない。
  const osc110Sub = term.parser.registerOscHandler(110, () => true);
  const osc111Sub = term.parser.registerOscHandler(111, () => true);

  // URL Ctrl+クリック機能を有効化する (設計書 Unit 3)
  const webLinksHandle = setupWebLinks(term);

  const runtime: TerminalRuntime = {
    get term() { return term; },
    get fitAddon() { return fitAddon; },
    get ptyHandle() { return ptyHandle; },
    get pendingInputs() { return pendingInputs; },
    onDataSub,
    compositionAbort,
    titleSub,
    oscSub,
    bellSub,
    writeParsedSub,
    tabStatusSub,
    webLinksHandle,

    setOnEvent(handler) {
      if (isDisposed) return;
      onEventHandler = handler;
    },

    startSpawn(opts, onError, bootstrap) {
      if (spawning || ptyHandle !== null) return;
      spawning = true;

      // このタブが WSL かどうかを起動引数から確定させる (linkHandler が使う)。
      // distro 未指定 (`-d` なし) は空文字のまま渡し、既定 distro の解決は Rust に任せる。
      wslDistro = isWslShell(opts.shell) ? parseWslArgs(opts.args).distro : undefined;

      spawnPty(opts, (e) => onEventHandler?.(e))
        .then((handle) => {
          spawning = false;
          if (isDisposed || !runtimes.has(tabId)) {
            // unmount 後 or forceDispose 後: PTY だけ確実に解放してリターン
            void handle.dispose();
            return;
          }
          ptyHandle = handle;
          for (const data of pendingInputs) {
            void writePty(handle.id, data).catch(() => {});
          }
          pendingInputs.length = 0;
          // Claude タブ等の自動起動コマンドをシェルへ流し込む（pendingInputs の後）。
          // シェルがプロンプト準備前でも PTY 入力はバッファされ、REPL 起動後に実行される。
          if (bootstrap) {
            void writePty(handle.id, bootstrap + '\r').catch(() => {});
          }
          void resizePty(handle.id, term.cols, term.rows).catch(() => {});
          callbacks.onLive(handle.id);
        })
        .catch((e) => {
          spawning = false;
          if (isDisposed) return;
          onError(e instanceof Error ? e : new Error(String(e)));
        });
    },

    resetForRecycle() {
      // 旧 ptyHandle 参照を null にして spawning フラグをリセットする。
      // recyclePty から startSpawn を再実行するための前処理。
      // dispose() との違い: xterm / fitAddon / onDataSub / isDisposed には触れない。
      ptyHandle = null;
      spawning = false;
    },

    serializeScreen() {
      if (isDisposed) return '';
      try {
        return serializeAddon.serialize({ scrollback: SAVE_SCROLLBACK_LINES });
      } catch (e) {
        // 保存は付加機能なので、失敗してもターミナルの動作に影響させない
        console.warn('[terminalRegistry] serialize failed:', e);
        return '';
      }
    },

    consumeScreenDirty() {
      // dispose 済みなら保存する意味が無い（serialize しても空文字が返るだけ）
      if (isDisposed || !screenDirty) return false;
      screenDirty = false;
      return true;
    },

    writeInput(data: string) {
      if (isDisposed) return;
      if (ptyHandle) {
        void writePty(ptyHandle.id, data).catch(() => {});
      } else {
        pendingInputs.push(data);
      }
    },

    writeOutput(text: string) {
      if (isDisposed) return;
      // UTF-16 code unit 数を未 parse バイト量の近似として使う（厳密なバイト数は不要）。
      const n = text.length;
      outstandingBytes += n;
      // term.write のコールバックは xterm が当該チャンクを parse し終えた時点で発火する。
      // = UI スレッドが詰まると発火が遅れ、outstandingBytes が積み上がる → pause の契機。
      term.write(text, () => {
        outstandingBytes -= n;
        if (readPaused && !nextPauseState(outstandingBytes, readPaused)) {
          readPaused = false;
          if (ptyHandle) void setReadPaused(ptyHandle.id, false).catch(() => {});
        }
      });
      if (!readPaused && nextPauseState(outstandingBytes, readPaused)) {
        readPaused = true;
        if (ptyHandle) void setReadPaused(ptyHandle.id, true).catch(() => {});
      }
    },

    wakeWebgl() {
      wakeWebglLocal();
    },

    sleepWebgl() {
      sleepWebglLocal();
    },

    reclaimPty() {
      if (isDisposed) return;
      // 旧 PTY を解放して Rust 側 sessions から remove させる。ptyHandle を null にして
      // 以降の二重 kill（recyclePty / dispose 経由）を no-op 化し、未処理 rejection を防ぐ。
      const h = ptyHandle;
      ptyHandle = null;
      // pause 状態もリセット（新 PTY spawn 時に stale な paused を持ち越さない）
      readPaused = false;
      outstandingBytes = 0;
      if (h) void h.dispose().catch(() => {});
    },

    applySettings(settings) {
      // Settings 変更を xterm.options に即時反映する。
      // dispose 済みの xterm に options を書き込むと例外になるため isDisposed ガードを入れる。
      if (isDisposed) return;

      // F-M3: フィールド毎の同値比較で不要な再代入を回避する（描画コスト削減）
      if (term.options.fontSize !== settings.fontSize) {
        term.options.fontSize = settings.fontSize;
      }
      if (term.options.fontFamily !== settings.fontFamily) {
        term.options.fontFamily = settings.fontFamily;
      }
      if (term.options.scrollback !== settings.scrollback) {
        term.options.scrollback = settings.scrollback;
      }

      applyRendererSettings(settings);
    },

    dispose() {
      // §3.2 の順序を厳守。この順序を変えない。
      isDisposed = true;
      onEventHandler = null;
      onDataSub.dispose();
      // OSC タイトル購読を解放する（onDataSub の隣に配置）
      titleSub.dispose();
      // OSC 7 cwd 追跡購読を解放する (Phase 4 P-G で追加)
      oscSub.dispose();
      // BEL 購読を解放する。§3.2 の順序規約に従い oscSub の直後に呼ぶ
      // (onBell コールバック中の use-after-dispose を防ぐため、isDisposed=true を立てた
      // 後に他の dispose と一緒の塊で実行する)
      bellSub.dispose();
      // 画面書き込み購読を解放する (bellSub と同じくエージェント状態検出の入力源)
      writeParsedSub.dispose();
      // OSC 21337 (TAB_STATUS) 購読を解放する
      tabStatusSub.dispose();
      // pending な状態確定タイマーをキャンセルする (dispose 済み term への getLine を防ぐ)
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      // WebLinksAddon を解放する。§3.2 規約: bellSub.dispose() の直後 (webglHandle より前)
      webLinksHandle.dispose();
      // v0.5 改善: OSC 10/11/110/111 (default fg/bg 設定) suppress ハンドラを解放
      osc10Sub.dispose();
      osc11Sub.dispose();
      osc110Sub.dispose();
      osc111Sub.dispose();
      // IME 合成リスナーを一括解除する（AbortController.abort() で signal ベース一括削除）
      compositionAbort.abort();
      // 遅延リセット用 setTimeout が pending な場合はキャンセルする (use-after-dispose 防止)
      imeGuard.dispose();
      // WebGL addon を fitAddon より前に dispose する (Phase 3 Unit P-C1)
      // term.dispose() より先に WebGL context を解放することで WebView2 crash を防ぐ。
      // v0.5 改善: 透明度 < 1.0 のとき null になっている可能性
      // #3: LRU からも除去する（webglHandle.dispose は forceLoseWebglContext 込みで context 解放）
      dropFromWebglLru(tabId);
      webglHandle?.dispose();
      fitAddon.dispose();
      void ptyHandle?.dispose();  // fire-and-forget
      term.dispose();
    },
  };

  return runtime;
}

/**
 * runtime を取得 or 初回 init。
 * - 初回呼び出し: init() を呼び、refs=1 で登録
 * - 2 回目以降: refs を増やして既存 runtime を返す（StrictMode の再 mount 対策）
 */
export function acquireRuntime(
  tabId: string,
  init: () => TerminalRuntime,
): TerminalRuntime {
  const entry = runtimes.get(tabId);
  if (entry) {
    entry.refs++;
    return entry.runtime;
  }
  const runtime = init();
  runtimes.set(tabId, { refs: 1, runtime });
  return runtime;
}

/**
 * runtime を解放。refs が 0 になったら queueMicrotask で dispose。
 * queueMicrotask の間に StrictMode の再 mount が来れば refs が戻り dispose されない。
 */
export function releaseRuntime(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    if (entry.refs < 0) {
      console.warn(
        `[terminalRegistry] refs went negative for ${tabId}. acquire/release asymmetry bug?`,
      );
      entry.refs = 0;
    }
    queueMicrotask(() => {
      const e = runtimes.get(tabId);
      if (e && e.refs === 0) {
        e.runtime.dispose();
        runtimes.delete(tabId);
      }
    });
  }
}

/**
 * タブ削除時の即時破棄（参照カウントを無視）。
 * store の removeTab から呼ぶ。set() より前に呼ぶことで
 * React が TerminalPane を unmount して releaseRuntime が来ても無害化される。
 */
export function forceDisposeRuntime(tabId: string): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  entry.runtime.dispose();
  runtimes.delete(tabId);
}

/**
 * crashed タブの PTY のみを差し替えて再起動する。
 * xterm インスタンスはそのまま維持するため scrollback が保全される。
 *
 * 処理順:
 * 1. 旧 PTY を fire-and-forget で dispose（xterm は維持）
 * 2. resetForRecycle() で ptyHandle=null / spawning=false にリセット
 * 3. startSpawn() で新規 PTY を spawn
 *
 * 呼び出し元責務:
 * - 呼び出し前に setTabStatus(tabId, 'spawning') を呼んで UI 状態を更新すること
 * - onLive 通知は createRuntime 時に渡した callbacks.onLive 経由で行われる
 *   （TerminalPane の handlePtyEvent → setTabStatus が呼ばれる）
 * - 失敗時は onError コールバックが呼ばれるので setTabStatus(tabId, 'crashed') を呼ぶこと
 *
 * NOTE: forceDisposeRuntime は使わない。xterm ごと破棄すると scrollback が失われる。
 */
export function recyclePty(
  tabId: string,
  opts: SpawnOptions,
  onError: (msg: string) => void,
  bootstrap?: string,
): void {
  const entry = runtimes.get(tabId);
  if (!entry) return;
  const runtime = entry.runtime;

  // 旧 PTY を fire-and-forget で解放（xterm は維持）
  void runtime.ptyHandle?.dispose();
  // ptyHandle を null に、spawning フラグをリセット（startSpawn の二重起動防止を通過させる）
  runtime.resetForRecycle();

  // F7: dispose の async 処理中にタブが削除された場合は startSpawn を呼ばない
  if (!runtimes.has(tabId)) return;

  runtime.startSpawn(opts, (err) => {
    onError(err.message);
  }, bootstrap);
}

/**
 * 全 runtime を配列で返す。
 * App.tsx の settings subscribe から applySettings を broadcast するために使用する。
 */
export function getAllRuntimes(): TerminalRuntime[] {
  return Array.from(runtimes.values()).map((e) => e.runtime);
}

/**
 * 指定タブの画面内容をシリアライズして返す。
 *
 * runtime が無い（まだ mount していない / 既に破棄された）タブや、
 * 内容が空のタブは null を返す。空を保存すると、次回の復元で
 * 「中身が消えた」ように見えてしまうため。
 */
export function getRuntimeScreen(tabId: string): string | null {
  const entry = runtimes.get(tabId);
  if (!entry) return null;
  const content = entry.runtime.serializeScreen();
  return content.length > 0 ? content : null;
}

/**
 * 前回の保存以降に書き込みがあったタブだけ、画面内容をシリアライズして返す。
 * 変化していなければ serialize すら行わずに null を返す。定期保存が重い原因は
 * serialize なので、ここで弾けることが目的。
 *
 * dirty フラグは問い合わせた時点で落ちる。保存の invoke が失敗しても再試行しないが、
 * 保存は付加機能であり、失敗しても前回のファイルが残る（1 世代古い内容が復元される
 * だけ）ので、リトライの仕組みは持たない。
 */
export function getRuntimeScreenIfDirty(tabId: string): string | null {
  const runtime = runtimes.get(tabId)?.runtime;
  if (!runtime || !runtime.consumeScreenDirty()) return null;
  return getRuntimeScreen(tabId);
}

/**
 * アトラス作り直しの手順を決める純関数。テスト用に export する。
 *
 * **必ず新しい配列を返す**のが肝。sleepWebgl は dropFromWebglLru 経由で webglLru を
 * その場で splice するため、webglLru を舐めながら sleep すると要素を飛ばす。
 *
 * wake は表示中のタブを優先し、居なければ MRU（末尾）にする。通常はアクティブ化の
 * たびに wakeWebgl → promoteWebglLru が走るので両者は一致するが、一致を前提にしない。
 */
export function planAtlasRecycle(
  lru: readonly string[],
  activeTabId: string | null,
): { sleepIds: string[]; wakeId: string | null } {
  if (lru.length === 0) return { sleepIds: [], wakeId: null };
  const sleepIds = [...lru];
  const wakeId =
    activeTabId !== null && sleepIds.includes(activeTabId)
      ? activeTabId
      : sleepIds[sleepIds.length - 1];
  return { sleepIds, wakeId };
}

/**
 * WebGL の共有グリフアトラス（TextureAtlas）を作り直す（#5）。App.tsx から一定間隔で呼ぶ。
 *
 * **なぜクリアではなく作り直しなのか。**
 * アトラスは端末どうしで共有される（xterm の acquireTextureAtlas はフォント・テーマ・
 * セル寸法が同じ端末へ同一インスタンスを配る作りで、racker は全タブ同設定なので実体は
 * 1 つしかない）。以前はこの共有物を term.clearTextureAtlas() で外から突いていたが、
 * これはアトラスのページを原点から詰め直す一方で、モデルと頂点バッファを捨てて全画面
 * 再描画を予約するのは**呼んだ端末だけ**。しかも clearTexture はページ結合と違って
 * 「全端末のモデルを捨てさせる」フラグ (_requestClearModel) を立てないため、他タブは
 * 古い UV を指したまま残り、同じ座標に別の字が焼かれた瞬間にその字に化ける。
 * 共有アトラスを無防備に無効化できる経路はここだけで、報告されている
 * 「文字が空白になる / 別の字になる」と機構が一致する。
 * （なお対象を全タブにしても 1 タブにしても化けは報告されており、真因がこれだけである
 * 確証まではコードからは取れない。だからこそ「突く」のをやめる。）
 *
 * そこで sleep/wake で renderer ごと捨てる。最後の owner が抜けた時点で xterm が
 * アトラスを charAtlasCache から外すので、clearTexture では残っていたグリフのメタデータ
 * （AtlasPage の _glyphs / _usedPixels）やページ canvas まで丸ごと GC 対象になり、回収量は
 * クリアより多い。ページ結合で一度 true になると戻らない _requestClearModel（立つと共有
 * 相手の全タブが毎フレーム全画面再描画に落ちる）も、新しいインスタンスなのでリセットされる。
 * 何より全タブの renderer がゼロから作り直されるので、**原因が何であれ化けた状態は
 * 定期的に必ず治る**。context loss でハンドルが残ったまま WebGL に戻れなくなったタブ
 * （setupWebglRenderer の onContextLoss は webglHandle も LRU も戻さない）も、ここの
 * sleep が stale なハンドルを捨てるので同時に復帰する。
 *
 * **sleep と wake を別タスクに分けてはいけない。** xterm の renderer 差し替えは同期で、
 * 再描画は rAF デバウンス越しに走る。1 タスク内で sleep→wake すれば途中の DOM renderer は
 * 一度も描画されないのでちらつかない。分けると DOM renderer で 1 フレーム描いてしまう。
 * 逆順（新しい addon を先に load してから旧を dispose）も不可: WebglAddon の dispose は
 * 必ず renderService を DOM renderer に戻すため、新しい renderer が上書きされて悪化する。
 *
 * アクティブタブを落として即座に作り直すのは、LRU eviction では起きない新しい経路
 * （reserveWebglLru はアクティブタブを victim にしない）。上記の同期差し替えが根拠で、
 * GPU 描画設定を切り替えたときの全タブ sleep は既に同じ密度で出荷している。
 *
 * WebGL を使っているタブが 1 つも無ければ（全タブ sleep / 透明 / GPU 描画 OFF）no-op。
 *
 * @param activeTabId 表示中のタブ。作り直した後にここだけ即座に起こし直す。
 * @param lru 対象の LRU。既定はモジュール内の webglLru で、引数はテスト用の継ぎ目。
 */
export function recycleTextureAtlas(
  activeTabId: string | null = null,
  lru: readonly string[] = webglLru,
): void {
  const { sleepIds, wakeId } = planAtlasRecycle(lru, activeTabId);
  // 全 WebGL タブを sleep させる。最後の owner が抜けた時点で共有アトラスが解放される。
  for (const id of sleepIds) runRecycleStep(id, 'sleepWebgl');
  // 表示中のタブだけその場で起こし直す（DOM renderer に落ちたままにしない）。
  // ここで新しいアトラスが 1 つ作られ、他タブは次にアクティブ化されたときに合流する。
  // 生成に失敗しても握り潰される（setupWebglRenderer 参照）が、次の周期の sleep で
  // ハンドルが捨てられて再挑戦されるので、最長 1 周期で復帰する。
  if (wakeId !== null) runRecycleStep(wakeId, 'wakeWebgl');
}

/**
 * recycleTextureAtlas の 1 手を実行する。
 *
 * 個別に例外を握るのは、1 タブの失敗で残りの sleep と wake を巻き添えにしないため。
 * 全員 sleep できなければアトラスは解放されないが、その回を諦めるだけで次の周期に
 * 再挑戦できる。一方 wake まで飛ばすと表示中のタブが DOM renderer に落ちたまま
 * 次の周期まで戻らない。
 */
function runRecycleStep(tabId: string, step: 'sleepWebgl' | 'wakeWebgl'): void {
  try {
    runtimes.get(tabId)?.runtime[step]();
  } catch (e) {
    console.warn(`[terminalRegistry] ${step} failed during atlas recycle:`, e);
  }
}

/**
 * tabId に紐づく runtime を返す。未登録なら null。
 * useFileDropToTerminal 等、外部から特定タブへ writeInput を行う際に使用する。
 */
export function getRuntime(tabId: string): TerminalRuntime | null {
  return runtimes.get(tabId)?.runtime ?? null;
}

/** テスト用: 登録済みの runtime 数を返す */
export function getRuntimeCount(): number {
  return runtimes.size;
}

/** テスト用: 特定 tabId の参照カウントを返す */
export function getRefs(tabId: string): number {
  return runtimes.get(tabId)?.refs ?? 0;
}

/**
 * すべての runtime を即時破棄して registry を空にする。
 * HMR の import.meta.hot.dispose hook で呼ぶことで、HMR 更新時に
 * xterm/PTY がリークするのを防ぐ。
 * dispose() の呼び出し順序は §3.2 の規約通り。
 *
 * 注: Map をコピーしてから dispose() ループに入る理由:
 * - 現状 dispose() は Map を変更しないが、Phase 3 で永続化等の副作用が
 *   入った場合にループ中の Map 変化を防ぐ防御的設計。
 */
export function forceDisposeAll(): void {
  // Map をコピーしてから dispose（dispose 中に Map が変化しないように）
  const entries = Array.from(runtimes.entries());
  for (const [tabId, entry] of entries) {
    entry.runtime.dispose();
    runtimes.delete(tabId);
  }
}

/**
 * 6 桁 hex カラーコードを rgba 文字列に変換する純関数。
 * - 入力: '#1a1b26' または '1a1b26' (# なしも可)
 * - 出力: 'rgba(26, 27, 38, 0.8)' のような文字列
 * - 不正な hex → 元の文字列をそのまま返す
 *
 * テスト容易性のためモジュール外から import できる形で export する。
 * Phase 4 P-B-2 で追加。
 */
export function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})$/);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 透明度と base hex から xterm theme.background 値を計算する純関数。
 * - alpha < 1.0: RGB は baseHex のまま alpha だけ 0 にした 'rgba(26, 27, 38, 0)' を返す。
 *   透明にする理由: 親の .terminal-pane が var(--terminal-bg) で半透明背景を描画しているため、
 *   xterm 自身も rgba(R,G,B,alpha) で塗ると 2 重描画になり実効不透明度が上がる
 *   (例: 0.7 + 0.7 → 0.91 で sidebar の 0.7 より不透明に見える)。
 *   RGB を捨てない理由: xterm は theme.background の RGB を描画以外にも流用する。
 *   OSC 11 のクエリ応答、反転表示 (inverse) の文字色 (color.opaque(background))、
 *   選択色・カーソル色のブレンド (color.blend(background, ...)) がそれで、'rgba(0,0,0,0)' だと
 *   「背景は真っ黒」と名乗ることになり、これらが黒基準で計算されて見づらくなる。
 *   実際に見えているのは親が塗る baseHex なので、alpha だけ 0 にして RGB は正直に残す。
 *   alpha=0 なので合成結果 (見た目の背景) は従来と同じ。
 * - alpha >= 1.0: baseHex をそのまま返す（不透明 hex）
 *
 * F-S1 テスト用に export する。F-M4: DEFAULT_BG をデフォルト値として使用。
 * Phase 4 P-B-2 で追加。
 */
export function computeBackground(alpha: number, baseHex: string = DEFAULT_BG): string {
  if (alpha >= 1.0) return baseHex;
  const transparent = hexToRgba(baseHex, 0);
  // hexToRgba は #rrggbb 以外を素通しする。不透明値をそのまま返すと 2 重描画になるので、
  // その場合だけ従来の完全透明へ倒す（現状の呼び出しは DEFAULT_BG のみなので保険）。
  return transparent === baseHex ? 'rgba(0, 0, 0, 0)' : transparent;
}

/**
 * OSC タイトル文字列をサニタイズする純関数。
 * - C0 制御文字 (U+0000-U+001F) を除去する
 * - DEL (U+007F) + C1 制御文字 (U+0080-U+009F) を除去する
 * - Bidi 制御文字 (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) を除去する
 * - 上記除去後に 256 文字に切り詰める
 *
 * テスト容易性のためモジュール外から import できる形で export する。
 */
export function sanitizeOscTitle(title: string): string {
  return title
    // C0 制御文字 (U+0000-U+001F) を除去
    .replace(/[\x00-\x1f]/g, '')
    // DEL (U+007F) + C1 制御文字 (U+0080-U+009F) を除去
    .replace(/[-]/g, '')
    // Bidi 制御文字を除去:
    //   LRM (U+200E), RLM (U+200F)
    //   LRE (U+202A), RLE (U+202B), PDF (U+202C), LRO (U+202D), RLO (U+202E)
    //   LRI (U+2066), RLI (U+2067), FSI (U+2068), PDI (U+2069)
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .slice(0, 256);
}

/**
 * OSC 10/11 の payload が「全パートが色の問い合わせ (?)」かを判定する純関数。
 *
 * xterm は payload を ';' で分割し、スロットごとに「'?' なら報告 / それ以外なら設定」を
 * 1 回のハンドラ呼び出しでまとめて処理する。ハンドラの戻り値は payload 単位の
 * all-or-nothing なので「クエリ部分だけ xterm に任せる」ことはできない。
 * 委譲できるのは全パートが '?' のときだけで、設定が 1 つでも混ざる
 * (ESC ] 10 ; ? ; #ff0000 ST) なら抑止側に倒す ── 混在は実在のシェル / TUI がまず送らない形で、
 * 透過設定を守る方を優先する。
 *
 * 判定は xterm と同じ厳密比較 ('?' そのもの) にして解釈のズレを作らない。
 * payload 空 (ESC ] 11 ST) は設定でもクエリでもないので false。xterm 側も空文字では
 * 何もしないため、抑止しても挙動は変わらない。
 *
 * テスト容易性のためモジュール外から import できる形で export する。
 */
export function isSpecialColorQuery(data: string): boolean {
  // 特殊色は fg/bg/cursor の 3 つだけなので意味のある最長は '?;?;?' (5 文字)。
  // OSC payload の上限は 10MB なので、長い文字列を split しないよう先に長さで弾く。
  if (data.length === 0 || data.length > 8) return false;
  return data.split(';').every((slot) => slot === '?');
}
