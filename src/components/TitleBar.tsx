import { Window } from '@tauri-apps/api/window';

/**
 * frameless window 用カスタムタイトルバー。
 * data-tauri-drag-region 属性によりドラッグ領域を宣言する。
 * 最小化・最大化トグル・閉じるボタンを提供する。
 * Phase 4 P-B-2 で追加。
 */
export function TitleBar() {
  const win = Window.getCurrent();

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar__title" data-tauri-drag-region>
        Racker Terminal
      </div>
      <div className="title-bar__actions">
        <button
          type="button"
          className="title-bar__btn"
          onClick={() => void win.minimize()}
          aria-label="Minimize"
        >
          —
        </button>
        <button
          type="button"
          className="title-bar__btn"
          onClick={() => void win.toggleMaximize()}
          aria-label="Maximize"
        >
          □
        </button>
        <button
          type="button"
          className="title-bar__btn title-bar__btn--close"
          onClick={() => void win.close()}
          aria-label="Close"
        >
          ×
        </button>
      </div>
    </div>
  );
}
