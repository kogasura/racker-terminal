import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Phase 2 Unit H で StrictMode を復活。
// terminalRegistry の参照カウント方式（acquireRuntime / releaseRuntime + queueMicrotask）により
// StrictMode の二重 mount → cleanup → mount サイクルで PTY が二重 spawn されないことを確認済み。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
