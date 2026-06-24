import { describe, it, expect } from 'vitest';
import { cwdBasename, sanitizeSessionName, isWslShell, buildWslClaudeArgs } from './TerminalPane';
import { isWslShell as isWslShellSrc } from '../lib/profileTemplates';

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

describe('isWslShell (re-export)', () => {
  // 振る舞いの網羅テストは profileTemplates.test.ts 側にあるため、
  // ここでは TerminalPane が実体を素通しで再エクスポートしていることだけ検証する。
  it('profileTemplates の実体をそのまま再エクスポートしている', () => {
    expect(isWslShell).toBe(isWslShellSrc);
  });
});

describe('buildWslClaudeArgs', () => {
  it('baseArgs の末尾に直接 exec 起動コマンドを注入する', () => {
    const out = buildWslClaudeArgs(
      ['-d', 'Ubuntu-22.04', '--cd', '~/jdf-dev/uranus2/server'],
      'claude --session-id abc -n uranus2',
    );
    expect(out).toEqual([
      '-d', 'Ubuntu-22.04', '--cd', '~/jdf-dev/uranus2/server',
      '--', 'bash', '-ic', 'claude --session-id abc -n uranus2; exec "$SHELL"',
    ]);
  });

  it('resume コマンドも同様に注入する', () => {
    const out = buildWslClaudeArgs(['-d', 'Ubuntu-22.04', '--cd', '~'], 'claude --resume xyz');
    expect(out[out.length - 1]).toBe('claude --resume xyz; exec "$SHELL"');
    expect(out.slice(-4, -1)).toEqual(['--', 'bash', '-ic']);
  });

  it('baseArgs が undefined でも動く', () => {
    const out = buildWslClaudeArgs(undefined, 'claude --resume xyz');
    expect(out).toEqual(['--', 'bash', '-ic', 'claude --resume xyz; exec "$SHELL"']);
  });

  it('既に -- を含む場合は注入せず baseArgs を同一参照で返す（明示コマンド尊重）', () => {
    const base = ['-d', 'Ubuntu-22.04', '--', 'bash', '-lc', 'echo hi'];
    const out = buildWslClaudeArgs(base, 'claude --resume xyz');
    expect(out).toEqual(base);
    // computeClaudeLaunch は `wslArgs === baseArgs` で「注入できなかった」を判定し
    // タイプ送信へフォールバックするため、同一参照で返すことが契約 (レビュー B1)。
    expect(out).toBe(base);
  });
});
