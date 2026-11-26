import { describe, it, expect } from 'vitest';
import {
  buildQuickAccessLaunch,
  parseWslUncPath,
  quickAccessMode,
  toggleQuickAccessPath,
} from './quickAccess';

const CLAUDE = { launchClaude: true, bypass: false };
const SHELL_ONLY = { launchClaude: false, bypass: false };

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
    expect(buildQuickAccessLaunch({ name: 'dev', path }, CLAUDE)).toEqual({
      userTitle: 'dev',
      cwd: path,
      launchClaude: true,
    });
  });

  it('WSL のフォルダはその distro の中で開く', () => {
    expect(buildQuickAccessLaunch({ name: 'jdf-dev', path: WSL_DIR }, CLAUDE)).toEqual({
      userTitle: 'jdf-dev',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/jdf-dev'],
      launchClaude: true,
    });
  });

  it('タブ名はエクスプローラーの表示名を使う (ドライブ直下でも名前が付く)', () => {
    expect(
      buildQuickAccessLaunch({ name: 'Google Drive (I:)', path: 'I:\\' }, CLAUDE).userTitle,
    ).toBe('Google Drive (I:)');
  });

  it('claude を起動しない設定なら、同じ場所にシェルだけを開く', () => {
    const path = String.raw`C:\Users\me\dev`;
    expect(buildQuickAccessLaunch({ name: 'dev', path }, SHELL_ONLY)).toEqual({
      userTitle: 'dev',
      cwd: path,
      launchClaude: false,
    });
    // WSL のフォルダも distro の中に開く (そこで自分で claude を打つことがあるため)
    expect(buildQuickAccessLaunch({ name: 'jdf-dev', path: WSL_DIR }, SHELL_ONLY)).toEqual({
      userTitle: 'jdf-dev',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/jdf-dev'],
      launchClaude: false,
    });
  });

  it('権限バイパスを付けるフォルダは、タブにバイパスを残す (WSL でも同じ)', () => {
    const path = String.raw`C:\Users\me\dev`;
    const bypass = { launchClaude: true, bypass: true };
    expect(buildQuickAccessLaunch({ name: 'dev', path }, bypass)).toEqual({
      userTitle: 'dev',
      cwd: path,
      launchClaude: true,
      bypassPermissions: true,
    });
    expect(buildQuickAccessLaunch({ name: 'jdf-dev', path: WSL_DIR }, bypass)).toEqual({
      userTitle: 'jdf-dev',
      shell: 'wsl.exe',
      args: ['-d', 'Ubuntu-22.04', '--cd', '/home/me/jdf-dev'],
      launchClaude: true,
      bypassPermissions: true,
    });
  });

  it('claude を起動しないならバイパスは付けない (渡されても無視する)', () => {
    const launch = buildQuickAccessLaunch(
      { name: 'dev', path: String.raw`C:\Users\me\dev` },
      { launchClaude: false, bypass: true },
    );
    expect(launch.bypassPermissions).toBeUndefined();
  });
});

describe('quickAccessMode', () => {
  const DEV = String.raw`C:\Users\me\dev`;

  it('既定 (設定なし) はどのフォルダも claude を起動し、バイパスは付けない', () => {
    expect(quickAccessMode(DEV, {})).toEqual(CLAUDE);
    expect(
      quickAccessMode(DEV, { quickAccessShellOnlyPaths: [], quickAccessBypassPaths: [] }),
    ).toEqual(CLAUDE);
  });

  it('シェルだけの一覧に載っているフォルダは起動しない (大文字小文字は区別しない)', () => {
    expect(quickAccessMode(DEV, { quickAccessShellOnlyPaths: [DEV] })).toEqual(SHELL_ONLY);
    expect(quickAccessMode(DEV, { quickAccessShellOnlyPaths: [DEV.toUpperCase()] })).toEqual(
      SHELL_ONLY,
    );
    expect(
      quickAccessMode(String.raw`C:\Users\me\other`, { quickAccessShellOnlyPaths: [DEV] }),
    ).toEqual(CLAUDE);
  });

  it('バイパスの一覧に載っているフォルダだけバイパスを付ける (大文字小文字は区別しない)', () => {
    const bypass = { launchClaude: true, bypass: true };
    expect(quickAccessMode(DEV, { quickAccessBypassPaths: [DEV] })).toEqual(bypass);
    expect(quickAccessMode(DEV, { quickAccessBypassPaths: [DEV.toUpperCase()] })).toEqual(bypass);
    expect(
      quickAccessMode(String.raw`C:\Users\me\other`, { quickAccessBypassPaths: [DEV] }),
    ).toEqual(CLAUDE);
  });

  it('シェルだけを開くフォルダでは、バイパスの一覧に載っていても付けない', () => {
    expect(
      quickAccessMode(DEV, { quickAccessShellOnlyPaths: [DEV], quickAccessBypassPaths: [DEV] }),
    ).toEqual(SHELL_ONLY);
  });
});

describe('toggleQuickAccessPath', () => {
  const DEV = String.raw`C:\Users\me\dev`;

  it('切り替えるたびに一覧へ足し / 外す', () => {
    const on = toggleQuickAccessPath(undefined, DEV);
    expect(on).toEqual([DEV]);
    expect(toggleQuickAccessPath(on, DEV)).toEqual([]);
  });

  it('外すときは表記ゆれ (大文字小文字) があっても外れ、他のフォルダは残す', () => {
    const other = String.raw`D:\work`;
    expect(toggleQuickAccessPath([DEV.toUpperCase(), other], DEV)).toEqual([other]);
  });
});
