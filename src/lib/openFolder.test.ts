import { describe, it, expect } from 'vitest';
import { folderName, buildFolderLaunch } from './openFolder';
import { buildProfileTemplates, findTemplate } from './profileTemplates';

describe('folderName', () => {
  it('Windows パスの末尾フォルダ名を返す', () => {
    expect(folderName('C:\\Users\\me\\projects\\racker')).toBe('racker');
  });
  it('POSIX パスの末尾フォルダ名を返す', () => {
    expect(folderName('/home/me/dev/app')).toBe('app');
  });
  it('末尾スラッシュがあっても末尾フォルダ名を返す', () => {
    expect(folderName('C:\\Users\\me\\')).toBe('me');
  });
  it('ドライブ直下は Terminal にフォールバックする', () => {
    expect(folderName('C:\\')).toBe('Terminal');
    expect(folderName('C:')).toBe('Terminal');
  });
  it('空文字列は Terminal にフォールバックする', () => {
    expect(folderName('')).toBe('Terminal');
  });
});

describe('buildFolderLaunch', () => {
  const winPath = 'C:\\Users\\me\\projects\\myapp';

  it('template=null（既定 Nushell）は shell 未指定・cwd に選択パス', () => {
    const launch = buildFolderLaunch(null, winPath);
    expect(launch.shell).toBeUndefined();
    expect(launch.cwd).toBe(winPath);
    expect(launch.args).toBeUndefined();
    expect(launch.title).toBe('myapp');
  });

  it('Windows ネイティブシェル (PowerShell 7) は shell/args を引き継ぎ cwd に選択パス', () => {
    const templates = buildProfileTemplates([]);
    const pwsh = findTemplate(templates, 'pwsh7')!;
    const launch = buildFolderLaunch(pwsh, winPath);
    expect(launch.shell).toBe('pwsh.exe');
    expect(launch.args).toEqual(['-NoLogo']);
    expect(launch.cwd).toBe(winPath);
    expect(launch.title).toBe('myapp');
  });

  it('cmd はシンプルに shell=cmd.exe・args なし・cwd に選択パス', () => {
    const templates = buildProfileTemplates([]);
    const cmd = findTemplate(templates, 'cmd')!;
    const launch = buildFolderLaunch(cmd, winPath);
    expect(launch.shell).toBe('cmd.exe');
    expect(launch.args).toBeUndefined();
    expect(launch.cwd).toBe(winPath);
  });

  it('WSL は wsl.exe で -d <distro> --cd <Windowsパス> を組み立て cwd は undefined', () => {
    const templates = buildProfileTemplates(['Ubuntu-22.04']);
    const wsl = findTemplate(templates, 'wsl-Ubuntu-22.04')!;
    const launch = buildFolderLaunch(wsl, winPath);
    expect(launch.shell).toBe('wsl.exe');
    // Windows パスをそのまま --cd に渡す（wsl.exe が Linux パスへ自動変換）
    expect(launch.args).toEqual(['-d', 'Ubuntu-22.04', '--cd', winPath]);
    expect(launch.cwd).toBeUndefined();
    expect(launch.title).toBe('myapp');
  });

  it('args はテンプレート配列と参照独立（shallow copy されている）', () => {
    const templates = buildProfileTemplates([]);
    const pwsh = findTemplate(templates, 'pwsh7')!;
    const launch = buildFolderLaunch(pwsh, winPath);
    launch.args!.push('mutated');
    // 元テンプレートには影響しない
    expect(pwsh.args).toEqual(['-NoLogo']);
  });
});
