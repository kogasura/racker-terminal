import { describe, it, expect } from 'vitest';
import { cwdBasename, sanitizeSessionName } from './TerminalPane';

describe('cwdBasename', () => {
  it('POSIX パスの末尾フォルダ名を返す', () => {
    expect(cwdBasename('/home/user/projects/racker-terminal')).toBe('racker-terminal');
  });

  it('Windows パスの末尾フォルダ名を返す', () => {
    expect(cwdBasename('C:\\Users\\foo\\dev\\my-app')).toBe('my-app');
  });

  it('末尾スラッシュ・重複区切りを無視する', () => {
    expect(cwdBasename('/a/b/c//')).toBe('c');
    expect(cwdBasename('C:\\a\\b\\')).toBe('b');
  });

  it('~ は除外する', () => {
    expect(cwdBasename('~')).toBeNull();
  });

  it('undefined / 空文字は null', () => {
    expect(cwdBasename(undefined)).toBeNull();
    expect(cwdBasename('')).toBeNull();
  });
});

describe('sanitizeSessionName', () => {
  it('通常の名前はそのまま（英数・ハイフン・アンダースコア）', () => {
    expect(sanitizeSessionName('auth-refactor_2')).toBe('auth-refactor_2');
  });

  it('空白はハイフンに置換する', () => {
    expect(sanitizeSessionName('my feature work')).toBe('my-feature-work');
  });

  it('日本語（unicode 文字）は保持する', () => {
    expect(sanitizeSessionName('認証まわり')).toBe('認証まわり');
  });

  it('シェルメタ文字・引用符は除去する（injection 防止）', () => {
    // `;`, `$`, バッククォート, 引用符, パイプ等が混ざっても安全なトークンになる
    expect(sanitizeSessionName('x; rm -rf /')).toBe('x-rm-rf');
    expect(sanitizeSessionName('a$(whoami)b')).toBe('awhoamib');
    expect(sanitizeSessionName('na"me`cmd`')).toBe('namecmd');
  });

  it('60 文字に切り詰める', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeSessionName(long)?.length).toBe(60);
  });

  it('空・null・サニタイズ後に空になるものは null', () => {
    expect(sanitizeSessionName(null)).toBeNull();
    expect(sanitizeSessionName(undefined)).toBeNull();
    expect(sanitizeSessionName('   ')).toBeNull();
    expect(sanitizeSessionName('"\'`$;|&')).toBeNull();
  });
});
