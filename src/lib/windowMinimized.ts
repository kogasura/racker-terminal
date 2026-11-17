/**
 * 窓が最小化されているかを追う。
 *
 * Tauri の WebView2 では、窓を最小化しても `document.hidden` が false のままで、
 * 背景のアニメーションが動き続ける（dev 版で約 2.5 コア）。そこで窓のイベントのたびに
 * `isMinimized()` を問い合わせる。最小化と元に戻すときは onResized が届き、元に戻すときは
 * フォーカスも戻るので、onFocusChanged でも問い合わせ直す（フォーカスが外れただけでは
 * 最小化ではないので、値は isMinimized の答えに従う）。
 *
 * Tauri の外（vite dev のブラウザ・テスト）では窓を追えないので、何もしない。
 *
 * @module windowMinimized
 */

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/**
 * 最小化の状態が分かるたびに onChange を呼ぶ。最初の 1 回は購読を始めた直後に問い合わせる。
 * @returns 購読をやめる関数
 */
export function subscribeWindowMinimized(onChange: (minimized: boolean) => void): () => void {
  let cancelled = false;
  const unlisteners: (() => void)[] = [];

  void (async () => {
    try {
      const win = getCurrentWebviewWindow();
      const check = async () => {
        try {
          const minimized = await win.isMinimized();
          if (!cancelled) onChange(minimized);
        } catch (e) {
          console.warn('[window] isMinimized failed:', e);
        }
      };
      for (const listen of [win.onResized.bind(win), win.onFocusChanged.bind(win)]) {
        const unlisten = await listen(() => void check());
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      }
      if (!cancelled) await check();
    } catch (e) {
      // 窓を追えない環境では、最小化していないものとして扱う
      console.warn('[window] minimize tracking failed:', e);
    }
  })();

  return () => {
    cancelled = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}
