import { useState, memo } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { FavoriteDialog } from './FavoriteDialog';
import type { Favorite } from '../types';

type DialogState =
  | { mode: 'add' }
  | { mode: 'edit'; favorite: Favorite }
  | null;

export const FavoritesSection = memo(function FavoritesSection() {
  const [collapsed, setCollapsed] = useState(false);
  const [dialogState, setDialogState] = useState<DialogState>(null);

  // favorites 配列のみ subscribe（id/title/shell 等の変化のみで再レンダー）
  const favorites = useAppStore(useShallow((s) => s.favorites));
  const spawnFavorite = useAppStore((s) => s.spawnFavorite);
  const removeFavorite = useAppStore((s) => s.removeFavorite);
  const addFavorite = useAppStore((s) => s.addFavorite);
  const updateFavorite = useAppStore((s) => s.updateFavorite);
  const setContextMenuOpen = useAppStore((s) => s.setContextMenuOpen);

  return (
    <div className="favorites-section">
      <div
        className="favorites-header"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setCollapsed((c) => !c);
        }}
      >
        <span className="favorites-header__title">
          {collapsed ? '› Favorites' : '⌄ Favorites'}
        </span>
      </div>

      {!collapsed && (
        <div className="favorites-list">
          {favorites.length === 0 ? (
            <div className="favorites-empty">
              お気に入りはまだありません。タブを右クリックするか、下のボタンから登録してください。
            </div>
          ) : (
            favorites.map((fav) => (
              <ContextMenu.Root
                key={fav.id}
                onOpenChange={(open) => setContextMenuOpen(open)}
              >
                <ContextMenu.Trigger asChild>
                  <div
                    className="favorite-item"
                    onClick={() => spawnFavorite(fav.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') spawnFavorite(fav.id);
                    }}
                  >
                    <span className="favorite-item__icon">★</span>
                    <span className="favorite-item__title">{fav.title}</span>
                  </div>
                </ContextMenu.Trigger>

                <ContextMenu.Portal>
                  <ContextMenu.Content className="context-menu__content">
                    <ContextMenu.Item
                      className="context-menu__item"
                      onSelect={() => spawnFavorite(fav.id)}
                    >
                      ここから spawn
                    </ContextMenu.Item>

                    <ContextMenu.Item
                      className="context-menu__item"
                      onSelect={() => setDialogState({ mode: 'edit', favorite: fav })}
                    >
                      編集
                    </ContextMenu.Item>

                    <ContextMenu.Separator className="context-menu__separator" />

                    <ContextMenu.Item
                      className="context-menu__item context-menu__item--danger"
                      onSelect={() => removeFavorite(fav.id)}
                    >
                      削除
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            ))
          )}

          <button
            type="button"
            className="favorites-add-btn"
            onClick={() => setDialogState({ mode: 'add' })}
          >
            + Add Favorite
          </button>
        </div>
      )}

      {dialogState?.mode === 'add' && (
        <FavoriteDialog
          mode="add"
          onSubmit={(data) => {
            addFavorite(data);
            setDialogState(null);
          }}
          onClose={() => setDialogState(null)}
        />
      )}
      {dialogState?.mode === 'edit' && (
        <FavoriteDialog
          mode="edit"
          initial={dialogState.favorite}
          onSubmit={(data) => {
            updateFavorite(dialogState.favorite.id, data);
            setDialogState(null);
          }}
          onClose={() => setDialogState(null)}
        />
      )}
    </div>
  );
});
