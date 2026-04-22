import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// StrictMode は Phase 1 では無効化。
// React 19 + xterm.js + PTY の組み合わせで二重マウント時に WebView2 クラッシュが発生するため、
// Phase 2 以降で単一タブ設計を複数タブ化する際に併せて対応する。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
