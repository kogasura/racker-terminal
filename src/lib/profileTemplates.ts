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

// ─── WSL 引数ユーティリティ ───────────────────────────────────────────────────
// WSL お気に入りの「distro + 作業ディレクトリ」を args 配列と相互変換する純関数群。
// FavoriteDialog の WSL 専用フィールドが、低レベルな `-d` / `--cd` の手書きを隠すために使う。

/**
 * shell が WSL (wsl.exe) かどうかを判定する純関数。
 * フルパス指定 (C:\Windows\System32\wsl.exe) や大文字小文字の差異も許容する。
 */
export function isWslShell(shell: string | undefined): boolean {
  if (!shell) return false;
  const base = shell.split(/[\\/]+/).pop()?.toLowerCase() ?? '';
  return base === 'wsl.exe' || base === 'wsl';
}

/**
 * distro と作業ディレクトリ (Linux パス) から wsl.exe の起動引数を組み立てる純関数。
 * - distro が空なら `-d` を省略（既定 distro で起動）。
 * - dir が空なら `--cd ~`（WSL ホーム）にフォールバックする。
 *
 * 例: ('Ubuntu-22.04', '~/jdf-dev/uranus2/server')
 *     → ['-d', 'Ubuntu-22.04', '--cd', '~/jdf-dev/uranus2/server']
 */
export function buildWslArgs(distro: string, dir: string): string[] {
  const args: string[] = [];
  const d = distro.trim();
  if (d) args.push('-d', d);
  args.push('--cd', dir.trim() || '~');
  return args;
}

/**
 * wsl.exe の args 配列から distro と作業ディレクトリを抽出する純関数。
 * 編集時に WSL 専用フィールドへ prefill するために使う。見つからなければ空文字。
 */
export function parseWslArgs(args: readonly string[] | undefined): { distro: string; dir: string } {
  let distro = '';
  let dir = '';
  const a = args ?? [];
  for (let i = 0; i < a.length; i++) {
    if ((a[i] === '-d' || a[i] === '--distribution') && i + 1 < a.length) distro = a[i + 1];
    else if (a[i] === '--cd' && i + 1 < a.length) dir = a[i + 1];
  }
  return { distro, dir };
}

/**
 * args が「distro + 作業ディレクトリ」だけで表現できる素直な WSL 引数かを判定する純関数。
 * `-d <v>` / `--distribution <v>` / `--cd <v>` のペアのみで構成されていれば true。
 * `--`（明示コマンド）や `-u` / `-e` 等の未知トークンを含む場合は false（= WSL フォームでは
 * 安全に往復できないため手動引数モードにフォールバックすべき）。空配列は true。
 */
export function isStandardWslArgs(args: readonly string[] | undefined): boolean {
  const a = args ?? [];
  let i = 0;
  while (i < a.length) {
    const tok = a[i];
    if (tok === '-d' || tok === '--distribution' || tok === '--cd') {
      if (i + 1 >= a.length) return false; // 値が欠落
      i += 2;
    } else {
      return false; // 未知トークン → 手動モード
    }
  }
  return true;
}
