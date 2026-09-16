import { useState, memo } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useEmit } from '../architecture/chain';
import { useFavoritesView } from '../features/tabs/TabsRoot';
import type { TabsEvent } from '../features/tabs/events';
import { FavoriteDialog } from './FavoriteDialog';
import type { Favorite } from '../types';
import { DRAG_KIND } from '../lib/dndResolve';

type DialogState =
  | { mode: 'add' }
  | { mode: 'edit'; favorite: Favorite }
  | null;

/** B2: お気に入りアイテムを D&D 並び替え可能にする sortable ラッパー */
function SortableFavoriteItem({
  fav,
  isDefault,
  onSpawn,
  onEdit,
  onRemove,
  onSetDefault,
  onContextMenuOpen,
}: {
  fav: Favorite;
  isDefault: boolean;
  onSpawn: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onSetDefault: () => void;
  onContextMenuOpen: (open: boolean) => void;
}) {
  // F-M6: kind は DRAG_KIND 定数経由で指定（typo を型レベルで検出）
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: fav.id,
    data: { kind: DRAG_KIND.FAVORITE },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const iconClass = isDefault
    ? 'favorite-item__icon favorite-item__icon--default'
    : 'favorite-item__icon';
  const icon = isDefault ? '⭐' : '★';
  const titleAttr = isDefault ? `${fav.title} (既定)` : fav.title;

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
          title={titleAttr}
        >
          <span className={iconClass}>{icon}</span>
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

          {/* Phase 4 P-H: 既定として設定 / 既定を解除 */}
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={onSetDefault}
          >
            {isDefault ? '既定を解除' : '既定として設定'}
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

  const { items, isEmpty } = useFavoritesView();
  // メニューの開閉は tabs の Mediator に伝える (開いている間はキーコマンドが止まる)
  const emit = useEmit<TabsEvent>();

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
          {isEmpty ? (
            <div className="favorites-empty">
              お気に入りはまだありません。タブを右クリックするか、下のボタンから登録してください。
            </div>
          ) : (
            // B2: SortableContext で favorites の D&D 並び替えを有効化する
            <SortableContext
              items={items.map((item) => item.favorite.id)}
              strategy={verticalListSortingStrategy}
            >
              {items.map(({ favorite, isDefault }) => (
                <SortableFavoriteItem
                  key={favorite.id}
                  fav={favorite}
                  isDefault={isDefault}
                  onSpawn={() =>
                    emit({ type: 'tabs/favorite-spawn-requested', favoriteId: favorite.id })
                  }
                  onEdit={() => setDialogState({ mode: 'edit', favorite })}
                  onRemove={() =>
                    emit({ type: 'tabs/favorite-remove-requested', favoriteId: favorite.id })
                  }
                  onSetDefault={() =>
                    emit({ type: 'tabs/favorite-default-toggled', favoriteId: favorite.id })
                  }
                  onContextMenuOpen={(open) =>
                    emit({ type: open ? 'tabs/context-menu-opened' : 'tabs/context-menu-closed' })
                  }
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
            emit({ type: 'tabs/favorite-added', favorite: data });
            setDialogState(null);
          }}
          onClose={() => {
            setDialogState(null);
            // F-S5: ContextMenu → Dialog 遷移でメニューが開いたままになるリスクへの念のためリセット
            emit({ type: 'tabs/context-menu-closed' });
          }}
        />
      )}
      {dialogState?.mode === 'edit' && (
        <FavoriteDialog
          mode="edit"
          initial={dialogState.favorite}
          onSubmit={(data) => {
            emit({
              type: 'tabs/favorite-updated',
              favoriteId: dialogState.favorite.id,
              favorite: data,
            });
            setDialogState(null);
          }}
          onClose={() => {
            setDialogState(null);
            // F-S5: ContextMenu → Dialog 遷移でメニューが開いたままになるリスクへの念のためリセット
            emit({ type: 'tabs/context-menu-closed' });
          }}
        />
      )}
    </div>
  );
});
