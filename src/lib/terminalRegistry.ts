import { Terminal as XTerm, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { PtyHandle, PtyEvent, SpawnOptions } from './pty';
import type { Settings } from '../types';
import { spawnPty, writePty, resizePty } from './pty';

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
   * PTY イベント受信時のコールバック。
   * TerminalPane の useEffect 内で登録し、cleanup で null を渡す。
   * null の場合 runtime は何もしない（unmount 後の書き込みを防ぐ）。
   */
  setOnEvent(handler: ((e: PtyEvent) => void) | null): void;

  /**
   * PTY spawn を開始する。内部で spawning フラグを管理し、
   * 二重呼び出し（ptyHandle セット済み or spawn 中）は no-op。
   */
  startSpawn(opts: SpawnOptions, onError: (e: Error) => void): void;

  /**
   * recyclePty 専用: 旧 PTY ハンドルを null にして spawning フラグをリセットする。
   * startSpawn の二重起動防止チェックを通過させるために必要。
   * recyclePty 以外から呼ばないこと。
   */
  resetForRecycle(): void;

  /**
   * OSC タイトル変更購読の IDisposable。
   * createRuntime 内で term.onTitleChange を購読して取得する。
   * dispose() の中で titleSub.dispose() を呼ぶ。
   */
  titleSub: IDisposable;

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
  },
): TerminalRuntime {
  let onEventHandler: ((e: PtyEvent) => void) | null = null;
  let isDisposed = false;
  let spawning = false;

  const term = new XTerm({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    scrollback: settings.scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: '#1a1b26',
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

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  try {
    fitAddon.fit();
  } catch (e) {
    console.warn('[terminalRegistry] initial fit failed', e);
  }

  const pendingInputs: string[] = [];
  let ptyHandle: PtyHandle | null = null;

  // onData を spawn より先に登録して DSR-CPR 等を pendingInputs に貯める
  const onDataSub = term.onData((data) => {
    if (isDisposed) return;
    if (ptyHandle) {
      void writePty(ptyHandle.id, data).catch(() => {});
    } else {
      pendingInputs.push(data);
    }
  });

  // OSC タイトル変更を購読してタブ名を自動更新する。
  // 編集中ガード: callbacks.isEditing() が true のとき OSC を無視してユーザー編集を保護する。
  // 文字長制限: 256 文字に切り詰め。制御文字フィルタ: sanitizeOscTitle を通してから onOscTitle を呼ぶ。
  const titleSub = term.onTitleChange((title) => {
    if (isDisposed) return;
    if (callbacks.isEditing()) return;
    const sanitized = sanitizeOscTitle(title);
    if (sanitized.length === 0) return;
    callbacks.onOscTitle(sanitized);
  });

  const runtime: TerminalRuntime = {
    get term() { return term; },
    get fitAddon() { return fitAddon; },
    get ptyHandle() { return ptyHandle; },
    get pendingInputs() { return pendingInputs; },
    onDataSub,
    titleSub,

    setOnEvent(handler) {
      if (isDisposed) return;
      onEventHandler = handler;
    },

    startSpawn(opts, onError) {
      if (spawning || ptyHandle !== null) return;
      spawning = true;

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

    applySettings(settings) {
      // Settings 変更を xterm.options に即時反映する。
      // Settings UI は Phase 3 送りのため、Phase 2 では機構のみ用意する。
      // dispose 済みの xterm に options を書き込むと例外になるため isDisposed ガードを入れる。
      if (isDisposed) return;
      term.options.fontSize = settings.fontSize;
      term.options.fontFamily = settings.fontFamily;
      term.options.scrollback = settings.scrollback;
    },

    dispose() {
      // §3.2 の順序を厳守。この順序を変えない。
      isDisposed = true;
      onEventHandler = null;
      onDataSub.dispose();
      // OSC タイトル購読を解放する（onDataSub の隣に配置）
      titleSub.dispose();
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
  });
}

/**
 * 全 runtime を配列で返す。
 * App.tsx の settings subscribe から applySettings を broadcast するために使用する。
 */
export function getAllRuntimes(): TerminalRuntime[] {
  return Array.from(runtimes.values()).map((e) => e.runtime);
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
