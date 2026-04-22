import { useEffect, useRef } from "react";
import { Terminal as XTerm, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawnPty, writePty, resizePty, type PtyHandle } from "../lib/pty";

// Terminal は PTY/xterm.js のライフサイクル管理が複雑なため HMR 対象外とする。
// このファイルが変更された場合、Vite は full reload を行う。
// Phase 2 以降で複数タブ対応時に、各タブの冪等マウントを再設計する。
if (import.meta.hot) {
  import.meta.hot.invalidate();
}

// デバッグ用: true にすると xterm.js だけ表示して PTY spawn をスキップ
const DEBUG_SKIP_PTY = false;

export default function Terminal() {
  const divRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const handleRef = useRef<PtyHandle | null>(null);
  const dataSubRef = useRef<IDisposable | null>(null);

  useEffect(() => {
    if (!divRef.current) return;

    let disposed = false;

    const term = new XTerm({
      fontFamily: '"MonaspiceNe NF", "Cascadia Code", "Consolas", monospace',
      fontSize: 12.5,
      scrollback: 10000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    });

    term.open(divRef.current);
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    try {
      fitAddon.fit();
    } catch (e) {
      console.warn("initial fit failed", e);
    }

    if (DEBUG_SKIP_PTY) {
      term.writeln("\x1b[32m[xterm.js is working]\x1b[0m");
      term.writeln("PTY spawn is skipped for diagnostics.");
      term.writeln(`Size: ${term.cols} cols x ${term.rows} rows`);
      term.write("$ ");
      return () => {
        disposed = true;
        fitAddonRef.current?.dispose();
        fitAddonRef.current = null;
        termRef.current?.dispose();
        termRef.current = null;
      };
    }

    const cols = Math.max(1, term.cols || 80);
    const rows = Math.max(1, term.rows || 24);

    // spawn 完了前の入力（xterm が自動応答する DSR 等）をバッファしておく
    const pendingInputs: string[] = [];

    // onData を spawn より先に登録。
    // handle 確定前の入力（xterm が自動応答する Device Status Report 等）を pendingInputs に貯めて、
    // spawn 完了後に flush する。これがないと cmd.exe のカーソル位置クエリに応答できず起動が止まる。
    const dataSub = term.onData((data) => {
      if (disposed) return;
      if (handleRef.current) {
        void writePty(handleRef.current.id, data).catch(() => {});
      } else {
        pendingInputs.push(data);
      }
    });
    dataSubRef.current = dataSub;

    spawnPty({ cols, rows }, (event) => {
      // disposed 済み term への write は WebView2 レベルのクラッシュを起こすため必ずガード
      if (disposed) return;
      switch (event.type) {
        case "data":
          term.write(event.text);
          break;
        case "exit":
          term.writeln(
            `\r\n\x1b[33m[exited${event.code != null ? ` ${event.code}` : ""}]\x1b[0m`,
          );
          break;
        case "error":
          term.writeln(`\r\n\x1b[31m[error]: ${event.message}\x1b[0m`);
          break;
      }
    })
      .then((handle) => {
        if (disposed) {
          void handle.dispose();
          return;
        }
        handleRef.current = handle;

        // pendingInputs を flush（spawn 完了前に貯まった xterm の自動応答等を送る）
        for (const data of pendingInputs) {
          void writePty(handle.id, data).catch(() => {});
        }
        pendingInputs.length = 0;

        void resizePty(handle.id, term.cols, term.rows).catch(() => {});
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        term.writeln("\r\n\x1b[31m[spawn error]: " + msg + "\x1b[0m");
      });

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (handleRef.current) {
        void resizePty(handleRef.current.id, term.cols, term.rows).catch(
          () => {},
        );
      }
    });
    resizeObserver.observe(divRef.current);

    return () => {
      disposed = true;
      dataSubRef.current?.dispose();
      dataSubRef.current = null;
      resizeObserver.disconnect();
      void handleRef.current?.dispose();
      handleRef.current = null;
      fitAddonRef.current?.dispose();
      fitAddonRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  return <div ref={divRef} className="h-full w-full" />;
}
