import { useState, memo } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { FavoriteDialog } from './FavoriteDialog';
import type { Favorite } from '../types';

type DialogState =
  | { mode: 'add' }
  | { mode: 'edit'; favorite: Favorite }
  | null;

/** B2: お気に入りアイテムを D&D 並び替え可能にする sortable ラッパー */
function SortableFavoriteItem({
  fav,
  onSpawn,
  onEdit,
  onRemove,
  onContextMenuOpen,
}: {
  fav: Favorite;
  onSpawn: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onContextMenuOpen: (open: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: fav.id,
    data: { kind: 'favorite' },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <ContextMenu.Root onOpenChange={onContextMenuOpen}>
      <ContextMenu.Trigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          data-dragging={isDragging || undefined}
          className="favorite-item"
          onClick={onSpawn}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onSpawn();
          }}
          {...attributes}
          {...listeners}
          // role と tabIndex は attributes に含まれるため、明示指定は attributes スプレッドの後に置く
          role="button"
          tabIndex={0}
        >
          <span className="favorite-item__icon">★</span>
          <span className="favorite-item__title">{fav.title}</span>
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={onSpawn}
          >
            ここから spawn
          </ContextMenu.Item>

          <ContextMenu.Item
            className="context-menu__item"
            onSelect={onEdit}
          >
            編集
          </ContextMenu.Item>

          <ContextMenu.Separator className="context-menu__separator" />

          <ContextMenu.Item
            className="context-menu__item context-menu__item--danger"
            onSelect={onRemove}
          >
            削除
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

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
            // B2: SortableContext で favorites の D&D 並び替えを有効化する
            <SortableContext
              items={favorites.map((f) => f.id)}
              strategy={verticalListSortingStrategy}
            >
              {favorites.map((fav) => (
                <SortableFavoriteItem
                  key={fav.id}
                  fav={fav}
                  onSpawn={() => spawnFavorite(fav.id)}
                  onEdit={() => setDialogState({ mode: 'edit', favorite: fav })}
                  onRemove={() => removeFavorite(fav.id)}
                  onContextMenuOpen={(open) => setContextMenuOpen(open)}
                />
              ))}
            </SortableContext>
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
          onClose={() => {
            setDialogState(null);
            // F-S5: ContextMenu → Dialog 遷移で contextMenuOpen が true で残るリスクに対する念のためリセット
            setContextMenuOpen(false);
          }}
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
          onClose={() => {
            setDialogState(null);
            // F-S5: ContextMenu → Dialog 遷移で contextMenuOpen が true で残るリスクに対する念のためリセット
            setContextMenuOpen(false);
          }}
        />
      )}
    </div>
  );
});
