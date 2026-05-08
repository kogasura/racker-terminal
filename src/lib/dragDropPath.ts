/**
 * ファイル D&D 時のパス変換・クオート処理ユーティリティ。
 *
 * ドロップされた Windows パスを、ターミナルのシェル環境（WSL / Windows）に合わせて
 * 適切な形式に整形し、コマンドラインに挿入できる文字列を生成する。
 */

// Windows ドライブレター付きパスの正規表現: "C:\..." または "C:/..."
const WINDOWS_DRIVE_RE = /^([a-zA-Z]):[\\\/](.*)$/;

/**
 * Windows パスを WSL パス (/mnt/x/...) に変換する。
 * UNC パス・ドライブレターなしのパス等、変換できない場合は null を返す。
 *
 * @example
 * convertWindowsPathToWsl('C:\\Users\\foo\\bar.png') // => '/mnt/c/Users/foo/bar.png'
 * convertWindowsPathToWsl('\\\\server\\share')       // => null
 */
export function convertWindowsPathToWsl(path: string): string | null {
  const match = WINDOWS_DRIVE_RE.exec(path);
  if (!match) return null;

  const driveLetter = match[1].toLowerCase();
  // rest 部分のバックスラッシュを forward slash に置換
  const rest = match[2].replace(/\\/g, '/');

  return `/mnt/${driveLetter}/${rest}`;
}

// シェル特殊文字と空白文字の正規表現（} を追加）
const NEEDS_QUOTING_RE = /[ \t"'()&|;<>$`*?[\]{}#^!]/;

// 改行・CR・NUL を含む危険パスの正規表現
const UNSAFE_PATH_RE = /[\r\n\0]/;

/**
 * パスがシェルでクオートを必要とする文字を含むか判定する。
 *
 * スペース・タブ・各種シェル特殊文字が対象。
 * non-ASCII 文字（日本語等）はクオート不要なので false。
 * \r / \n / \0 はクオートでは安全に扱えないため対象外（isUnsafePath で別途 reject）。
 *
 * @example
 * needsQuoting('C:\\Users\\foo.png')         // => false
 * needsQuoting('C:\\Program Files\\foo.txt') // => true
 */
export function needsQuoting(path: string): boolean {
  return NEEDS_QUOTING_RE.test(path);
}

/**
 * 改行・キャリッジリターン・NUL を含むパスは PTY に流すと行区切り扱いになり危険なので reject する。
 */
function isUnsafePath(path: string): boolean {
  return UNSAFE_PATH_RE.test(path);
}

/**
 * シェル向けにパスを整形して返す。
 *
 * - WSL の場合: Windows パスを /mnt/x/... 形式に変換し、必要なら single-quote で囲む。
 *   変換できない場合は Windows 形式のまま single-quote エスケープにフォールバック。
 * - Windows の場合: 必要なら double-quote で囲む。
 *
 * 戻り値の `convertedToWsl` は WSL 変換成否（呼び出し側で warn 集約に利用）。
 * isWsl=false の場合 convertedToWsl は常に true（変換概念なし）。
 *
 * @param path - 元のパス文字列
 * @param isWsl - WSL 環境かどうか
 */
export function formatPathForShell(
  path: string,
  isWsl: boolean,
): { formatted: string; convertedToWsl: boolean } {
  if (isWsl) {
    const wslPath = convertWindowsPathToWsl(path);
    const target = wslPath ?? path; // fallback でも single-quote ロジックに乗せる
    if (!needsQuoting(target)) {
      return { formatted: target, convertedToWsl: wslPath !== null };
    }
    const escaped = target.replace(/'/g, "'\\''");
    return { formatted: `'${escaped}'`, convertedToWsl: wslPath !== null };
  }

  // Windows 形式
  if (!needsQuoting(path)) return { formatted: path, convertedToWsl: true };
  return { formatted: `"${path}"`, convertedToWsl: true };
}

/**
 * 複数パスを整形してスペース区切りで連結する。
 *
 * CR / LF / NUL を含む危険パスは除外して warn する。
 * WSL タブで WSL 変換できなかったパスがある場合は 1 回だけ warn する。
 *
 * @param paths - パスの配列
 * @param isWsl - WSL 環境かどうか
 */
export function formatDroppedPaths(paths: string[], isWsl: boolean): string {
  if (paths.length === 0) return '';

  // 危険パス（CR/LF/NUL 含む）を除外
  const unsafe = paths.filter(isUnsafePath);
  if (unsafe.length > 0) {
    console.warn(
      '[dragDropPath] dropping unsafe path(s) containing CR/LF/NUL:',
      unsafe,
    );
  }
  const safe = paths.filter((p) => !isUnsafePath(p));
  if (safe.length === 0) return '';

  const results = safe.map((p) => formatPathForShell(p, isWsl));

  // WSL タブで変換できなかったパスがあれば 1 回だけ warn
  if (isWsl) {
    const failed = safe.filter((_, i) => !results[i].convertedToWsl);
    if (failed.length > 0) {
      console.warn(
        '[dragDropPath] cannot convert to WSL paths (fallback to raw):',
        failed,
      );
    }
  }

  return results.map((r) => r.formatted).join(' ');
}
