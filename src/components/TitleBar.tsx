import { useMemo } from 'react';
import { Window } from '@tauri-apps/api/window';
import { useEmit } from '../architecture/chain';
import { useTabsView } from '../features/tabs/TabsRoot';
import type { TabsEvent } from '../features/tabs/events';
import { useUpdaterView } from '../features/updater/UpdaterRoot';
import { UpdateBadgeView } from '../features/updater/views/UpdateBadgeView';

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

  const emit = useEmit<TabsEvent>();

  // 左サイドバーの開閉ボタン。開いているか・何と読み上げるかは View モデルが決める。
  const { sidebarToggle } = useTabsView();

  // 自動更新バッジ。状態は updater の Root から View モデルとして降ってくる。
  const { badge } = useUpdaterView();

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
      {/* 左サイドバーの開閉。ウィンドウを半分の幅などで使うときにターミナルの幅を稼ぐ */}
      <button
        type="button"
        className={`title-bar__btn--sidebar${sidebarToggle.expanded ? ' title-bar__btn--sidebar-expanded' : ''}`}
        onClick={() => emit({ type: 'tabs/sidebar-toggle-clicked' })}
        aria-label={sidebarToggle.label}
        aria-expanded={sidebarToggle.expanded}
        title={sidebarToggle.label}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
          <rect className="title-bar__sidebar-icon-fill" x="2" y="3" width="4" height="10" fill="currentColor" />
        </svg>
      </button>

      <div className="title-bar__title" data-tauri-drag-region>
        Racker Terminal
      </div>

      {/* 自動更新バッジ: 出すかどうかも文言も View モデルが決めている */}
      <UpdateBadgeView vm={badge} />

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
