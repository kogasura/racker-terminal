import { useMemo } from 'react';
import { Window } from '@tauri-apps/api/window';

/**
 * frameless window 用カスタムタイトルバー。
 * data-tauri-drag-region 属性によりドラッグ領域を宣言する。
 * 加えて onMouseDown で win.startDragging() を明示的に呼ぶフォールバックを実装する
 * (data-tauri-drag-region 属性のみだと WebView2 環境で稼働しないケースがあるため)。
 * 最小化・最大化トグル・閉じるボタンを提供する。
 * Phase 4 P-B-2 で追加。
 *
 * F-S2: Window.getCurrent() を useMemo でメモ化し、描画ごとの再呼び出しを防ぐ。
 */
export function TitleBar() {
  // F-S2: Window.getCurrent() は描画ごとに呼ばれないよう useMemo でメモ化する
  const win = useMemo(() => Window.getCurrent(), []);

  // data-tauri-drag-region フォールバック: 左クリックの mousedown でウィンドウドラッグを開始する。
  // ボタンクリック時は button.onClick が e.stopPropagation 相当の動作をしないので
  // target が button のときのみスキップする。
  // 注: capabilities/default.json に core:window:allow-start-dragging が必要。
  const handleDragMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    win.startDragging().catch((err) => console.warn('[TitleBar] startDragging failed:', err));
  };

  return (
    <div
      className="title-bar"
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
    >
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
