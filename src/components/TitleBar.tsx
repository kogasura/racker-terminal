import { useMemo } from 'react';
import { Window } from '@tauri-apps/api/window';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEmit } from '../architecture/chain';
import { useNewTabMenuView } from '../features/tabs/TabsRoot';
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
 * Phase 4 P-H で新規タブ split button を追加。
 *
 * F-S2: Window.getCurrent() を useMemo でメモ化し、描画ごとの再呼び出しを防ぐ。
 */
export function TitleBar() {
  // F-S2: Window.getCurrent() は描画ごとに呼ばれないよう useMemo でメモ化する
  const win = useMemo(() => Window.getCurrent(), []);

  // 新規タブメニュー。並べるもの (星の種類・ショートカット表示) は View モデルが決める。
  const newTabMenu = useNewTabMenuView();
  const emit = useEmit<TabsEvent>();

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
      <div className="title-bar__title" data-tauri-drag-region>
        Racker Terminal
      </div>

      {/* 自動更新バッジ: 出すかどうかも文言も View モデルが決めている */}
      <UpdateBadgeView vm={badge} />

      {/* 新規タブ split button */}
      <div className="title-bar__new-tab-group">
        {/* + ボタン: spawnDefaultOrNew */}
        <button
          type="button"
          className="title-bar__btn--new-tab"
          onClick={() => emit({ type: 'tabs/default-tab-open-requested' })}
          aria-label="新しいタブ"
          title="新しいタブ (Ctrl+T)"
        >
          +
        </button>

        {/* ▼ ボタン: DropdownMenu トリガー */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="title-bar__btn--new-tab-arrow"
              aria-label="新規タブメニューを開く"
            >
              ▼
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="dropdown-menu__content"
              align="end"
              sideOffset={4}
            >
              {/* 「新しいタブ (既定)」 */}
              <DropdownMenu.Item
                className="dropdown-menu__item"
                onSelect={() => emit({ type: 'tabs/default-tab-open-requested' })}
              >
                新しいタブ (既定)
                <span className="dropdown-menu__shortcut">Ctrl+T</span>
              </DropdownMenu.Item>

              {/* お気に入り一覧 (0 件のときはセパレータ・一覧ともに非表示) */}
              {newTabMenu.hasFavorites && (
                <>
                  <DropdownMenu.Separator className="dropdown-menu__separator" />
                  {newTabMenu.items.map((item) => (
                    <DropdownMenu.Item
                      key={item.favoriteId}
                      className="dropdown-menu__item"
                      onSelect={() =>
                        emit({
                          type: 'tabs/favorite-spawn-requested',
                          favoriteId: item.favoriteId,
                        })
                      }
                    >
                      <span className="dropdown-menu__fav-icon">{item.icon}</span>
                      {item.title}
                      {item.shortcut && (
                        <span className="dropdown-menu__shortcut">{item.shortcut}</span>
                      )}
                    </DropdownMenu.Item>
                  ))}
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
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
