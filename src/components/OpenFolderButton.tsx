import { memo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { open } from '@tauri-apps/plugin-dialog';
import { useShallow } from 'zustand/shallow';
import { useAppStore } from '../store/appStore';
import { buildProfileTemplates, type ProfileTemplate } from '../lib/profileTemplates';
import { buildFolderLaunch } from '../lib/openFolder';

/**
 * 「フォルダを選んで開く」ボタン（サイドバー下部）。
 *
 * クリックするとシェル一覧（Nushell / PowerShell / cmd / Git Bash / WSL:<distro>）の
 * ドロップダウンが開き、シェルを選ぶと Windows のフォルダ選択ダイアログが表示される。
 * フォルダを選ぶと、そのシェルで選択フォルダを作業ディレクトリにした新しいタブを開く。
 * お気に入り登録は不要で、臨時のフォルダをその場で開くための導線。
 */
export const OpenFolderButton = memo(function OpenFolderButton() {
  // インストール済 WSL distro を含むシェルテンプレート一覧を構築する。
  const wslDistros = useAppStore(useShallow((s) => s.wslDistros));
  const templates = buildProfileTemplates(wslDistros);

  async function handlePick(template: ProfileTemplate) {
    let selected: string | string[] | null;
    try {
      selected = await open({
        directory: true,
        multiple: false,
        title: `${template.label} で開くフォルダを選択`,
      });
    } catch (e) {
      console.warn('[open-folder] フォルダ選択ダイアログの表示に失敗:', e);
      return;
    }
    // キャンセル時は null。multiple:false なので文字列で返る。
    if (typeof selected !== 'string' || selected.length === 0) return;

    const launch = buildFolderLaunch(template, selected);
    useAppStore.getState().createTab(undefined, {
      userTitle: launch.title,
      shell: launch.shell,
      cwd: launch.cwd,
      args: launch.args,
    });
  }

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
              key={tpl.id}
              className="dropdown-menu__item"
              onSelect={() => {
                // onSelect でメニューを閉じたあとにネイティブダイアログを開く。
                void handlePick(tpl);
              }}
            >
              {tpl.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
});
