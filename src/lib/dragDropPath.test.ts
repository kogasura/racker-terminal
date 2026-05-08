import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  convertWindowsPathToWsl,
  needsQuoting,
  formatPathForShell,
  formatDroppedPaths,
} from './dragDropPath';

describe('convertWindowsPathToWsl', () => {
  it("'C:\\\\Users\\\\foo\\\\bar.png' → '/mnt/c/Users/foo/bar.png'", () => {
    expect(convertWindowsPathToWsl('C:\\Users\\foo\\bar.png')).toBe('/mnt/c/Users/foo/bar.png');
  });

  it("'C:\\\\' → '/mnt/c/'", () => {
    expect(convertWindowsPathToWsl('C:\\')).toBe('/mnt/c/');
  });

  it("'C:' (セパレータなし) → null", () => {
    expect(convertWindowsPathToWsl('C:')).toBeNull();
  });

  it("'c:\\\\foo' (lowercase) → '/mnt/c/foo'", () => {
    expect(convertWindowsPathToWsl('c:\\foo')).toBe('/mnt/c/foo');
  });

  it("'D:/foo/bar' (forward slash) → '/mnt/d/foo/bar'", () => {
    expect(convertWindowsPathToWsl('D:/foo/bar')).toBe('/mnt/d/foo/bar');
  });

  it("'\\\\\\\\server\\\\share\\\\foo' (UNC) → null", () => {
    expect(convertWindowsPathToWsl('\\\\server\\share\\foo')).toBeNull();
  });

  it("'' (空文字列) → null", () => {
    expect(convertWindowsPathToWsl('')).toBeNull();
  });

  it("'foo\\\\bar' (相対パス) → null", () => {
    expect(convertWindowsPathToWsl('foo\\bar')).toBeNull();
  });
});

describe('needsQuoting', () => {
  it("'C:\\\\Users\\\\foo.png' → false", () => {
    expect(needsQuoting('C:\\Users\\foo.png')).toBe(false);
  });

  it("'C:\\\\Program Files\\\\foo.txt' (スペースあり) → true", () => {
    expect(needsQuoting('C:\\Program Files\\foo.txt')).toBe(true);
  });

  it("'/mnt/c/Users/foo.png' → false", () => {
    expect(needsQuoting('/mnt/c/Users/foo.png')).toBe(false);
  });

  it("'C:\\\\foo&bar' (& あり) → true", () => {
    expect(needsQuoting('C:\\foo&bar')).toBe(true);
  });

  it("\"C:\\\\foo'bar\" (single-quote あり) → true", () => {
    expect(needsQuoting("C:\\foo'bar")).toBe(true);
  });

  it("'/home/user/日本語.png' (non-ASCII) → false", () => {
    expect(needsQuoting('/home/user/日本語.png')).toBe(false);
  });

  it("'' (空文字列) → false", () => {
    expect(needsQuoting('')).toBe(false);
  });

  it("'a}b' (} あり) → true (Critical 1 リグレッション防止)", () => {
    expect(needsQuoting('a}b')).toBe(true);
  });

  it("'foo\\nbar' (改行) → false (\\n は needsQuoting 対象外)", () => {
    expect(needsQuoting('foo\nbar')).toBe(false);
  });

  it("'foo\\rbar' (CR) → false (\\r は needsQuoting 対象外)", () => {
    expect(needsQuoting('foo\rbar')).toBe(false);
  });

  it("'foo\\0bar' (NUL) → false (\\0 は needsQuoting 対象外)", () => {
    expect(needsQuoting('foo\0bar')).toBe(false);
  });
});

describe('formatPathForShell', () => {
  it("Windows: クオート不要パスはそのまま返す", () => {
    expect(formatPathForShell('C:\\Users\\foo.png', false)).toEqual({
      formatted: 'C:\\Users\\foo.png',
      convertedToWsl: true,
    });
  });

  it("Windows: スペースありパスを double-quote で囲む", () => {
    expect(formatPathForShell('C:\\Program Files\\foo.txt', false)).toEqual({
      formatted: '"C:\\Program Files\\foo.txt"',
      convertedToWsl: true,
    });
  });

  it("WSL: クオート不要パスを /mnt/c/... に変換してそのまま返す", () => {
    expect(formatPathForShell('C:\\Users\\foo.png', true)).toEqual({
      formatted: '/mnt/c/Users/foo.png',
      convertedToWsl: true,
    });
  });

  it("WSL: スペースありパスを /mnt/... に変換して single-quote で囲む", () => {
    expect(formatPathForShell('C:\\Program Files\\foo.txt', true)).toEqual({
      formatted: "'/mnt/c/Program Files/foo.txt'",
      convertedToWsl: true,
    });
  });

  it("WSL: パス内の single-quote を '\\\\'' でエスケープする", () => {
    // C:\foo'bar → /mnt/c/foo'bar → '/mnt/c/foo'\''bar'
    expect(formatPathForShell("C:\\foo'bar", true)).toEqual({
      formatted: "'/mnt/c/foo'\\''bar'",
      convertedToWsl: true,
    });
  });

  it("WSL: UNC パスは変換失敗 → convertedToWsl: false で single-quote フォールバックを返す", () => {
    // \\server\share\foo は needsQuoting で false → そのまま返る
    expect(formatPathForShell('\\\\server\\share\\foo', true)).toEqual({
      formatted: '\\\\server\\share\\foo',
      convertedToWsl: false,
    });
  });

  it("WSL: \\ を含む UNC fallback パスが single-quote 化される", () => {
    // \\server\share\foo bar (スペースあり) → single-quote エスケープ
    expect(formatPathForShell('\\\\server\\share\\foo bar', true)).toEqual({
      formatted: "'\\\\server\\share\\foo bar'",
      convertedToWsl: false,
    });
  });
});

describe('formatDroppedPaths', () => {
  it("空配列 → ''", () => {
    expect(formatDroppedPaths([], false)).toBe('');
  });

  it("1 ファイル (クオート不要) → そのまま", () => {
    expect(formatDroppedPaths(['C:\\foo.png'], false)).toBe('C:\\foo.png');
  });

  it("複数ファイル (全クオート不要) → スペース区切り", () => {
    expect(formatDroppedPaths(['C:\\foo.png', 'C:\\bar.png'], false)).toBe(
      'C:\\foo.png C:\\bar.png',
    );
  });

  it("複数ファイル (一部クオート必要) → 必要なもののみ double-quote", () => {
    expect(
      formatDroppedPaths(['C:\\foo.png', 'C:\\Program Files\\bar.png'], false),
    ).toBe('C:\\foo.png "C:\\Program Files\\bar.png"');
  });

  it("WSL モード: 複数ファイルを /mnt/... に変換してスペース区切り", () => {
    expect(formatDroppedPaths(['C:\\foo.png', 'D:\\bar.png'], true)).toBe(
      '/mnt/c/foo.png /mnt/d/bar.png',
    );
  });

  it("改行を含むパスがフィルタアウトされ warn が 1 回だけ発火する", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = formatDroppedPaths(['C:\\foo.png', 'C:\\foo\nbar.png'], false);
      expect(result).toBe('C:\\foo.png');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[dragDropPath] dropping unsafe path(s) containing CR/LF/NUL:',
        ['C:\\foo\nbar.png'],
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("全パスが危険パスの場合 '' を返す", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = formatDroppedPaths(['C:\\foo\nbar.png', 'C:\\baz\0.png'], false);
      expect(result).toBe('');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("WSL: 複数 UNC を drop したとき warn が 1 回だけ発火しメッセージに失敗パス配列が含まれる", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = formatDroppedPaths(
        ['\\\\server\\share\\foo', '\\\\server\\share\\bar'],
        true,
      );
      expect(result).toBe('\\\\server\\share\\foo \\\\server\\share\\bar');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[dragDropPath] cannot convert to WSL paths (fallback to raw):',
        ['\\\\server\\share\\foo', '\\\\server\\share\\bar'],
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// afterEach でスパイが残留しないことの保証（個別テスト内で restore しているが念のため）
afterEach(() => {
  vi.restoreAllMocks();
});
