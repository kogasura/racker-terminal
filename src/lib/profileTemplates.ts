/**
 * お気に入り登録時のテンプレート定数・ユーティリティ。
 * Windows 標準シェル + 一般的に使われるシェルをハードコードで提供する。
 * 選択しても上書き編集可能。
 *
 * @module profileTemplates
 * @since Phase 4 P-I で追加
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
 * 組み込みプロファイルテンプレート一覧。
 * 各エントリは FavoriteDialog のテンプレート select から選択できる。
 *
 * @since Phase 4 P-I で追加
 */
export const PROFILE_TEMPLATES: readonly ProfileTemplate[] = [
  { id: 'wsl',     label: 'WSL',                       title: 'WSL',        shell: 'wsl.exe',                                     args: ['--cd', '~'] },
  { id: 'pwsh5',   label: 'Windows PowerShell (5.1)',  title: 'PowerShell', shell: 'powershell.exe',                              args: ['-NoLogo'] },
  { id: 'pwsh7',   label: 'PowerShell 7+',             title: 'PowerShell', shell: 'pwsh.exe',                                    args: ['-NoLogo'] },
  { id: 'cmd',     label: 'Command Prompt',            title: 'cmd',        shell: 'cmd.exe' },
  { id: 'gitbash', label: 'Git Bash',                  title: 'Git Bash',   shell: 'C:\\Program Files\\Git\\bin\\bash.exe',        args: ['--login', '-i'] },
  { id: 'nushell', label: 'Nushell (デフォルト)',      title: 'Nushell',    shell: 'nu' },
] as const;

/**
 * テンプレート ID から ProfileTemplate を取得する純関数。
 * 見つからない場合は null を返す。
 *
 * @param id - テンプレート ID (例: 'wsl', 'pwsh7')
 * @returns 対応する ProfileTemplate、見つからない場合は null
 * @since Phase 4 P-I で追加
 */
export function findTemplate(id: string): ProfileTemplate | null {
  return PROFILE_TEMPLATES.find((t) => t.id === id) ?? null;
}
