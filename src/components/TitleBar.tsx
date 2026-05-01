import { useMemo } from 'react';
import { Window } from '@tauri-apps/api/window';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';

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

  // favorites と defaultFavoriteId を subscribe (useShallow で参照比較の最適化)
  const favorites = useAppStore(useShallow((s) => s.favorites));
  const defaultFavoriteId = useAppStore((s) => s.settings.defaultFavoriteId);
  const spawnDefaultOrNew = useAppStore((s) => s.spawnDefaultOrNew);
  const spawnFavorite = useAppStore((s) => s.spawnFavorite);

  // 自動更新バッジ
  const updatePhase = useAppStore((s) => s.updatePhase);
  const openUpdateDialog = useAppStore((s) => s.openUpdateDialog);

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

      {/* 自動更新バッジ */}
      {updatePhase !== 'idle' && updatePhase !== 'checking' && (
        <button
          type="button"
          className="title-bar__update-badge"
          onClick={openUpdateDialog}
          aria-label="アップデートが利用可能"
          title={updatePhase === 'error' ? 'アップデートエラー' : 'アップデートあり'}
        >
          {updatePhase === 'error' ? '!' : '↑'}
        </button>
      )}

      {/* 新規タブ split button */}
      <div className="title-bar__new-tab-group">
        {/* + ボタン: spawnDefaultOrNew */}
        <button
          type="button"
          className="title-bar__btn--new-tab"
          onClick={() => spawnDefaultOrNew()}
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
                onSelect={() => spawnDefaultOrNew()}
              >
                新しいタブ (既定)
                <span className="dropdown-menu__shortcut">Ctrl+T</span>
              </DropdownMenu.Item>

              {/* お気に入り一覧 (0 件のときはセパレータ・一覧ともに非表示) */}
              {favorites.length > 0 && (
                <>
                  <DropdownMenu.Separator className="dropdown-menu__separator" />
                  {favorites.map((fav, idx) => {
                    const isDefault = fav.id === defaultFavoriteId;
                    const icon = isDefault ? '⭐' : '★';
                    // 最初の 9 件のみショートカットラベルを表示
                    const shortcut = idx < 9 ? `Ctrl+Shift+${idx + 1}` : undefined;
                    return (
                      <DropdownMenu.Item
                        key={fav.id}
                        className="dropdown-menu__item"
                        onSelect={() => spawnFavorite(fav.id)}
                      >
                        <span className="dropdown-menu__fav-icon">{icon}</span>
                        {fav.title}
                        {shortcut && (
                          <span className="dropdown-menu__shortcut">{shortcut}</span>
                        )}
                      </DropdownMenu.Item>
                    );
                  })}
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
