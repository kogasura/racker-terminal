import { memo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEmit } from '../architecture/chain';
import { useFolderTemplatesView } from '../features/tabs/TabsRoot';
import type { TabsEvent } from '../features/tabs/events';

/**
 * 「フォルダを選んで開く」ボタン（サイドバー下部）。
 *
 * クリックするとシェル一覧（Nushell / PowerShell / cmd / Git Bash / WSL:<distro>）の
 * ドロップダウンが開き、シェルを選ぶと Windows のフォルダ選択ダイアログが表示される。
 * フォルダを選ぶと、そのシェルで選択フォルダを作業ディレクトリにした新しいタブを開く。
 * お気に入り登録は不要で、臨時のフォルダをその場で開くための導線。
 *
 * ダイアログの表示も effects の担当にしてある。ここは「どのシェルで開きたいか」を
 * 流すだけで、I/O を持たない。
 */
export const OpenFolderButton = memo(function OpenFolderButton() {
  // インストール済 WSL distro を含むシェルテンプレート一覧。
  const templates = useFolderTemplatesView();
  const emit = useEmit<TabsEvent>();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="sidebar__open-folder-btn"
          title="フォルダを選んで開く"
          aria-label="フォルダを選んで開く"
        >
          📁
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-menu__content"
          side="top"
          align="start"
          sideOffset={4}
        >
          <DropdownMenu.Label className="dropdown-menu__label">
            フォルダを開くシェルを選択
          </DropdownMenu.Label>
          {templates.map((tpl) => (
            <DropdownMenu.Item
              key={tpl.templateId}
              className="dropdown-menu__item"
              onSelect={() =>
                emit({ type: 'tabs/folder-open-requested', templateId: tpl.templateId })
              }
            >
              {tpl.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
});
