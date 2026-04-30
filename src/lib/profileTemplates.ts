/**
 * お気に入り登録時のテンプレート定数・ユーティリティ。
 * Windows 標準シェル + 一般的に使われるシェルを静的テンプレートとして提供し、
 * WSL distro 一覧を受け取って動的にテンプレートを構築する。
 * 選択しても上書き編集可能。
 *
 * @module profileTemplates
 * @since Phase 4 P-I で追加、P-K で動的化
 */

/** お気に入り登録時のテンプレート型定義 */
export interface ProfileTemplate {
  id: string;
  /** Select option に表示するラベル */
  label: string;
  /** 自動入力する title 候補 */
  title: string;
  /** shell の実行ファイルパス */
  shell: string;
  /**
   * shell 起動時の引数配列。空配列 / undefined は引数なし。
   * 選択時に FavoriteDialog の argsText に自動入力される。
   */
  args?: string[];
}

/**
 * 静的 (常に表示される) テンプレート一覧。
 * WSL distro とは独立して常に表示される。
 */
const STATIC_TEMPLATES: readonly ProfileTemplate[] = [
  { id: 'pwsh5',   label: 'Windows PowerShell (5.1)',  title: 'PowerShell', shell: 'powershell.exe',                              args: ['-NoLogo'] },
  { id: 'pwsh7',   label: 'PowerShell 7+',             title: 'PowerShell', shell: 'pwsh.exe',                                    args: ['-NoLogo'] },
  { id: 'cmd',     label: 'Command Prompt',            title: 'cmd',        shell: 'cmd.exe' },
  { id: 'gitbash', label: 'Git Bash',                  title: 'Git Bash',   shell: 'C:\\Program Files\\Git\\bin\\bash.exe',        args: ['--login', '-i'] },
  { id: 'nushell', label: 'Nushell (デフォルト)',      title: 'Nushell',    shell: 'nu' },
] as const;

/**
 * インストール済 WSL distro 一覧から動的にテンプレートを構築する純関数。
 * - distro が空 → 静的テンプレートのみ返す
 * - distro が 1 件以上 → 各 distro を `WSL: <name>` エントリとして先頭に追加
 *
 * @param wslDistros - インストール済 WSL distro 名の一覧 (docker-desktop 除外済)
 * @returns WSL エントリ (先頭) + 静的テンプレートの配列
 * @since Phase 4 P-K で追加
 */
export function buildProfileTemplates(wslDistros: readonly string[]): ProfileTemplate[] {
  const wslEntries: ProfileTemplate[] = wslDistros.map((distro) => ({
    id: `wsl-${distro}`,
    label: `WSL: ${distro}`,
    title: distro,                          // タブ名は distro 名
    shell: 'wsl.exe',
    args: ['-d', distro, '--cd', '~'],      // distro 指定 + WSL ホーム
  }));
  return [...wslEntries, ...STATIC_TEMPLATES];
}

/**
 * テンプレート ID から ProfileTemplate を取得する純関数。
 * 見つからない場合は null を返す。
 *
 * @param templates - buildProfileTemplates で構築したテンプレート配列
 * @param id - テンプレート ID (例: 'wsl-Ubuntu-22.04', 'pwsh7')
 * @returns 対応する ProfileTemplate、見つからない場合は null
 * @since Phase 4 P-I で追加、P-K で signature 変更
 */
export function findTemplate(
  templates: readonly ProfileTemplate[],
  id: string,
): ProfileTemplate | null {
  return templates.find((t) => t.id === id) ?? null;
}
