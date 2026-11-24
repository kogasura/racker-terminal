import { describe, it, expect } from 'vitest';
import {
  buildQuickAccessLaunch,
  isQuickAccessClaude,
  parseWslUncPath,
  toggleQuickAccessClaude,
} from './quickAccess';

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
    expect(buildQuickAccessLaunch({ name: 'dev', path }, true)).toEqual({
      userTitle: 'dev',
      cwd: path,
      launchClaude: true,
    });
  });

  it('WSL のフォルダはその distro の中で開く', () => {
    expect(buildQuickAccessLaunch({ name: 'jdf-dev', path: WSL_DIR }, true)).toEqual({
      userTitle: 'jdf-dev',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/jdf-dev'],
      launchClaude: true,
    });
  });

  it('タブ名はエクスプローラーの表示名を使う (ドライブ直下でも名前が付く)', () => {
    expect(buildQuickAccessLaunch({ name: 'Google Drive (I:)', path: 'I:\\' }, true).userTitle).toBe(
      'Google Drive (I:)',
    );
  });

  it('claude を起動しない設定なら、同じ場所にシェルだけを開く', () => {
    const path = String.raw`C:\Users\me\dev`;
    expect(buildQuickAccessLaunch({ name: 'dev', path }, false)).toEqual({
      userTitle: 'dev',
      cwd: path,
      launchClaude: false,
    });
    // WSL のフォルダも distro の中に開く (そこで自分で claude を打つことがあるため)
    expect(buildQuickAccessLaunch({ name: 'jdf-dev', path: WSL_DIR }, false)).toEqual({
      userTitle: 'jdf-dev',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/jdf-dev'],
      launchClaude: false,
    });
  });
});

describe('isQuickAccessClaude / toggleQuickAccessClaude', () => {
  const DEV = String.raw`C:\Users\me\dev`;

  it('既定 (設定なし) はどのフォルダも claude を起動する', () => {
    expect(isQuickAccessClaude(DEV, undefined)).toBe(true);
    expect(isQuickAccessClaude(DEV, [])).toBe(true);
  });

  it('シェルだけの一覧に載っているフォルダは起動しない (大文字小文字は区別しない)', () => {
    expect(isQuickAccessClaude(DEV, [DEV])).toBe(false);
    expect(isQuickAccessClaude(DEV, [DEV.toUpperCase()])).toBe(false);
    expect(isQuickAccessClaude(String.raw`C:\Users\me\other`, [DEV])).toBe(true);
  });

  it('切り替えるたびに一覧へ足し / 外す', () => {
    const off = toggleQuickAccessClaude(undefined, DEV);
    expect(off).toEqual([DEV]);
    expect(toggleQuickAccessClaude(off, DEV)).toEqual([]);
  });

  it('外すときは表記ゆれ (大文字小文字) があっても外れ、他のフォルダは残す', () => {
    const other = String.raw`D:\work`;
    expect(toggleQuickAccessClaude([DEV.toUpperCase(), other], DEV)).toEqual([other]);
  });
});
