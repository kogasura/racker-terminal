import { memo, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useEmit } from '../architecture/chain';
import { useQuickAccessView } from '../features/tabs/TabsRoot';
import type { QuickAccessItemViewModel } from '../features/tabs/viewModel';
import type { TabsEvent } from '../features/tabs/events';
import { ClaudeMark } from './ClaudeMark';

/**
 * クイックアクセスの 1 行。
 *
 * クリックでそのフォルダを開く。claude を起動するか・権限バイパスを付けるかはフォルダごとに
 * 右クリックで切り替え、claude を起動するフォルダにだけ印を付ける（既定は起動する・バイパスなし）。
 */
function QuickAccessItem({ item }: { item: QuickAccessItemViewModel }) {
  const emit = useEmit<TabsEvent>();
  const open = () => emit({ type: 'tabs/quick-access-open-requested', path: item.path });

  return (
    // メニューの開閉は tabs の Mediator に伝える (開いている間はキーコマンドが止まる)
    <ContextMenu.Root
      onOpenChange={(isOpen) =>
        emit({ type: isOpen ? 'tabs/context-menu-opened' : 'tabs/context-menu-closed' })
      }
    >
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          className="favorite-item quick-access-item"
          title={item.tooltip}
          onClick={open}
        >
          <span className="favorite-item__icon">📁</span>
          <span className="favorite-item__title">{item.name}</span>
          {item.launchClaude && <ClaudeMark />}
        </button>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item className="context-menu__item" onSelect={open}>
            開く
          </ContextMenu.Item>

          <ContextMenu.Separator className="context-menu__separator" />

          <ContextMenu.CheckboxItem
            className="context-menu__item"
            checked={item.launchClaude}
            onCheckedChange={() =>
              emit({ type: 'tabs/quick-access-claude-toggled', path: item.path })
            }
          >
            <span className="context-menu__check">
              <ContextMenu.ItemIndicator>✓</ContextMenu.ItemIndicator>
            </span>
            開いたら claude を起動する
          </ContextMenu.CheckboxItem>

          {/* claude を起動しないフォルダでは意味が無いので押せなくする */}
          <ContextMenu.CheckboxItem
            className="context-menu__item"
            checked={item.bypass}
            disabled={!item.launchClaude}
            onCheckedChange={() =>
              emit({ type: 'tabs/quick-access-bypass-toggled', path: item.path })
            }
          >
            <span className="context-menu__check">
              <ContextMenu.ItemIndicator>✓</ContextMenu.ItemIndicator>
            </span>
            権限プロンプトをバイパスする
          </ContextMenu.CheckboxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * サイドバーの Quick Access セクション。
 *
 * Windows エクスプローラーのクイックアクセス (ピン留め + よく使うフォルダ) を並べ、
 * クリックするとそのフォルダでタブを開く (既定は claude を起動する。フォルダごとに
 * 右クリックでシェルだけを開くようにできる)。お気に入りに登録するほどではない
 * フォルダを、エクスプローラーと同じ顔ぶれから 1 クリックで開くための導線。
 *
 * 一覧はエクスプローラー側の持ち物なので、ここでは並び替えも編集もさせない。
 * ピン留めを変えたあとは ↻ で読み直す。
 */
export const QuickAccessSection = memo(function QuickAccessSection() {
  // 折りたたみは FavoritesSection と同じく、この View の中だけの見た目の状態
  const [collapsed, setCollapsed] = useState(false);
  const { visible, items } = useQuickAccessView();
  const emit = useEmit<TabsEvent>();

  if (!visible) return null;

  return (
    <div className="favorites-section">
      <div
        className="favorites-header"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          // 中の ↻ ボタンからバブルしてきたキーでは開閉しない
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') setCollapsed((c) => !c);
        }}
      >
        <span className="favorites-header__title">
          {collapsed ? '› Quick Access' : '⌄ Quick Access'}
        </span>
        <button
          type="button"
          className="favorites-header__action"
          title="クイックアクセスを読み直す"
          aria-label="クイックアクセスを読み直す"
          onClick={(e) => {
            // ヘッダの開閉に巻き込まない
            e.stopPropagation();
            emit({ type: 'tabs/quick-access-refresh-requested' });
          }}
        >
          ↻
        </button>
      </div>

      {!collapsed && (
        <div className="favorites-list">
          {items.map((item) => (
            <QuickAccessItem key={item.path} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});
