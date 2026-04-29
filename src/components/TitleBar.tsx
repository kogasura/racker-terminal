import { useMemo } from 'react';
import { Window } from '@tauri-apps/api/window';

/**
 * frameless window 用カスタムタイトルバー。
 * data-tauri-drag-region 属性によりドラッグ領域を宣言する。
 * 最小化・最大化トグル・閉じるボタンを提供する。
 * Phase 4 P-B-2 で追加。
 *
 * F-S2: Window.getCurrent() を useMemo でメモ化し、描画ごとの再呼び出しを防ぐ。
 */
export function TitleBar() {
  // F-S2: Window.getCurrent() は描画ごとに呼ばれないよう useMemo でメモ化する
  const win = useMemo(() => Window.getCurrent(), []);

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar__title" data-tauri-drag-region>
        Racker Terminal
      </div>
      <div className="title-bar__actions">
        <button
          type="button"
          className="title-bar__btn"
          onClick={() => {
            win.minimize().catch((e) => console.warn('[TitleBar] minimize failed:', e));
          }}
          aria-label="Minimize"
        >
          —
        </button>
        <button
          type="button"
          className="title-bar__btn"
          onClick={() => {
            win.toggleMaximize().catch((e) => console.warn('[TitleBar] toggleMaximize failed:', e));
          }}
          aria-label="Maximize"
        >
          □
        </button>
        <button
          type="button"
          className="title-bar__btn title-bar__btn--close"
          onClick={() => {
            win.close().catch((e) => console.warn('[TitleBar] close failed:', e));
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
    </div>
  );
}
