import { describe, it, expect } from 'vitest';
import { buildQuickAccessLaunch, parseWslUncPath } from './quickAccess';

// バックスラッシュの数え間違いを避けるため、パスは String.raw で書く。
const WSL_DIR = String.raw`\\wsl.localhost\Ubuntu-22.04\home\me\jdf-dev`;

describe('parseWslUncPath', () => {
  it('wsl.localhost の UNC を distro と Linux パスに分ける', () => {
    expect(parseWslUncPath(WSL_DIR)).toEqual({
      distro: 'Ubuntu-22.04',
      dir: '/home/me/jdf-dev',
    });
  });

  it('旧形式の wsl$ も受ける', () => {
    expect(parseWslUncPath(String.raw`\\wsl$\Debian\srv` + '\\')).toEqual({
      distro: 'Debian',
      dir: '/srv',
    });
  });

  it('distro 直下はルートになる', () => {
    expect(parseWslUncPath(String.raw`\\wsl.localhost\Ubuntu`)).toEqual({
      distro: 'Ubuntu',
      dir: '/',
    });
    expect(parseWslUncPath(String.raw`\\wsl.localhost\Ubuntu` + '\\')).toEqual({
      distro: 'Ubuntu',
      dir: '/',
    });
  });

  it('WSL 以外のパスは null', () => {
    expect(parseWslUncPath(String.raw`C:\Users\me\dev`)).toBeNull();
    expect(parseWslUncPath(String.raw`\\fileserver\share\dir`)).toBeNull();
    expect(parseWslUncPath('I:\\')).toBeNull();
  });
});

describe('buildQuickAccessLaunch', () => {
  it('Windows のフォルダは既定シェルで cwd を指定し、claude を起動する', () => {
    const path = String.raw`C:\Users\me\dev`;
    expect(buildQuickAccessLaunch({ name: 'dev', path })).toEqual({
      userTitle: 'dev',
      cwd: path,
      launchClaude: true,
    });
  });

  it('WSL のフォルダはその distro の中で開く', () => {
    expect(buildQuickAccessLaunch({ name: 'jdf-dev', path: WSL_DIR })).toEqual({
      userTitle: 'jdf-dev',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/jdf-dev'],
      launchClaude: true,
    });
  });

  it('タブ名はエクスプローラーの表示名を使う (ドライブ直下でも名前が付く)', () => {
    expect(buildQuickAccessLaunch({ name: 'Google Drive (I:)', path: 'I:\\' }).userTitle).toBe(
      'Google Drive (I:)',
    );
  });
});
