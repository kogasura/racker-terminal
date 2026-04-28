import { Terminal as XTerm, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { PtyHandle, PtyEvent, SpawnOptions } from './pty';
import type { Settings } from '../types';
import { spawnPty, writePty, resizePty } from './pty';

interface WebglRendererHandle {
  /** dispose() で WebGL addon と onContextLoss listener を解放 */
  dispose: () => void;
}

/**
 * xterm に WebGL renderer を attach する。
 * - new WebglAddon() / term.loadAddon() で失敗した場合は Canvas fallback (warn ログ)
 * - GPU context loss 時は WebglAddon を dispose して Canvas fallback (warn ログ + xterm 内通知)
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
      console.warn(
        `[terminalRegistry] WebGL context lost for tab ${tabId}, falling back to Canvas`,
      );
      // xterm 内に視覚通知
      try {
        term.write('\r\n\x1b[33m[Renderer fell back to Canvas]\x1b[0m\r\n');
      } catch {}
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
    // 初期化失敗時のクリーンアップ
    ctxLossSub?.dispose();
    ctxLossSub = null;
    webglAddon?.dispose();
    webglAddon = null;
  }

  return {
    dispose: () => {
      ctxLossSub?.dispose();
      webglAddon?.dispose();
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
   * OSC 7 (cwd 変更通知) 購読の IDisposable。
   * createRuntime 内で term.parser.registerOscHandler(7, ...) で取得する。
   * dispose() の中で oscSub.dispose() を呼ぶ (titleSub の後)。
   * Phase 4 P-G で追加。
   */
  oscSub: { dispose: () => void };

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
    /**
     * OSC 7 (cwd 変更通知) 受信時のコールバック。
     * parseOsc7Path で Windows パスに変換済みの値が渡される。
     * TerminalPane の useEffect 内で `(cwd) => updateTabCwd(tabId, cwd)` を渡す。
     * Phase 4 P-G で追加。
     */
    onCwdChange: (cwd: string) => void;
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

  // WebGL renderer 有効化 (Phase 3 Unit P-C1)
  // setupWebglRenderer ヘルパーで WebGL を attach する。
  // onContextLoss で Canvas renderer に自動フォールバックする堅牢性を確保する。
  // dispose 順序: webglHandle.dispose() は fitAddon.dispose() の前に呼ぶ (§3.2 参照)。
  const webglHandle = setupWebglRenderer(term, tabId);

  try {
    fitAddon.fit();
  } catch (e) {
    console.warn('[terminalRegistry] initial fit failed', e);
  }

  const pendingInputs: string[] = [];
  let ptyHandle: PtyHandle | null = null;

  // IME 合成中フラグ: compositionstart で true、compositionend で false になる。
  // Windows ConPTY + nushell/PowerShell で変換中の中間文字列が PTY に流れて
  // 画面が崩れる問題を防ぐため、onData ハンドラで合成中の入力を drop する。
  // xterm の onData は確定文字列を再発火する設計のため、合成中 drop しても確定後に再送される。
  let isComposing = false;
  const compositionAbort = new AbortController();
  const { signal: compositionSignal } = compositionAbort;

  // 注: xterm 内部 textarea は term.dispose() まで同じインスタンスを維持する前提
  //     (recyclePty では textarea を差し替えない)。
  // term.textarea は term.open() の後でセットされる (xterm 公式型: HTMLTextAreaElement | undefined)
  const textarea = term.textarea;
  if (textarea) {
    textarea.addEventListener('compositionstart', () => { isComposing = true; }, { signal: compositionSignal });
    textarea.addEventListener('compositionend', () => { isComposing = false; }, { signal: compositionSignal });
  } else {
    console.warn(
      `[terminalRegistry] term.textarea is undefined; IME composition guard disabled for tab ${tabId}`,
    );
  }

  // onData を spawn より先に登録して DSR-CPR 等を pendingInputs に貯める
  const onDataSub = term.onData((data) => {
    if (isDisposed) return;
    // IME 合成中は中間文字列を drop する（確定後に xterm が再発火するため入力は失われない）
    if (isComposing) return;
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

  const runtime: TerminalRuntime = {
    get term() { return term; },
    get fitAddon() { return fitAddon; },
    get ptyHandle() { return ptyHandle; },
    get pendingInputs() { return pendingInputs; },
    onDataSub,
    compositionAbort,
    titleSub,
    oscSub,

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
      // dispose 済みの xterm に options を書き込むと例外になるため isDisposed ガードを入れる。
      if (isDisposed) return;
      term.options.fontSize = settings.fontSize;
      term.options.fontFamily = settings.fontFamily;
      term.options.scrollback = settings.scrollback;
      // 透明度反映: theme.background を rgba 化
      if (settings.transparency !== undefined && settings.transparency < 1.0) {
        const bg = term.options.theme?.background ?? '#1a1b26';
        term.options.theme = {
          ...term.options.theme,
          background: hexToRgba(bg, settings.transparency),
        };
      } else {
        // transparency が 1.0 (不透明) のとき: 元の不透明 hex に戻す
        term.options.theme = {
          ...term.options.theme,
          background: '#1a1b26',
        };
      }
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
      // IME 合成リスナーを一括解除する（AbortController.abort() で signal ベース一括削除）
      compositionAbort.abort();
      // WebGL addon を fitAddon より前に dispose する (Phase 3 Unit P-C1)
      // term.dispose() より先に WebGL context を解放することで WebView2 crash を防ぐ。
      webglHandle.dispose();
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
