import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyCachedThemeVars } from "./features/theme/themeCache";
import { Roots } from "./Roots";
import "./styles.css";

// 前回のテーマの色を描画前に当て直す。これが無いと、起動のたびに初期値 (Tokyo Night) が
// 一瞬見えてから、選んだテーマに切り替わる。
applyCachedThemeVars();

// Phase 2 Unit H で StrictMode を復活。
// terminalRegistry の参照カウント方式（acquireRuntime / releaseRuntime + queueMicrotask）により
// StrictMode の二重 mount → cleanup → mount サイクルで PTY が二重 spawn されないことを確認済み。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <Roots>
        <App />
      </Roots>
    </ErrorBoundary>
  </StrictMode>,
);
