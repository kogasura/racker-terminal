import { memo, useState } from 'react';
import { useEmit } from '../architecture/chain';
import { useQuickAccessView } from '../features/tabs/TabsRoot';
import type { TabsEvent } from '../features/tabs/events';

/**
 * サイドバーの Quick Access セクション。
 *
 * Windows エクスプローラーのクイックアクセス (ピン留め + よく使うフォルダ) を並べ、
 * クリックするとそのフォルダで claude を起動するタブを開く。お気に入りに登録するほど
 * ではないフォルダを、エクスプローラーと同じ顔ぶれから 1 クリックで開くための導線。
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
            <button
              key={item.path}
              type="button"
              className="favorite-item quick-access-item"
              title={item.tooltip}
              onClick={() => emit({ type: 'tabs/quick-access-open-requested', path: item.path })}
            >
              <span className="favorite-item__icon">📁</span>
              <span className="favorite-item__title">{item.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
