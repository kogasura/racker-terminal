import { describe, it, expect } from 'vitest';
import { PROFILE_TEMPLATES, findTemplate } from './profileTemplates';

describe('findTemplate', () => {
  it("findTemplate('wsl') で WSL テンプレが返る", () => {
    const result = findTemplate('wsl');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('wsl');
    expect(result!.label).toBe('WSL');
    expect(result!.title).toBe('WSL');
    expect(result!.shell).toBe('wsl.exe');
  });

  it("WSL テンプレの args が ['--cd', '~'] であること", () => {
    const result = findTemplate('wsl');
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(['--cd', '~']);
  });

  it("Git Bash テンプレの args が ['--login', '-i'] であること", () => {
    const result = findTemplate('gitbash');
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(['--login', '-i']);
  });

  it("PowerShell 5.1 テンプレの args が ['-NoLogo'] であること", () => {
    const result = findTemplate('pwsh5');
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(['-NoLogo']);
  });

  it("PowerShell 7+ テンプレの args が ['-NoLogo'] であること", () => {
    const result = findTemplate('pwsh7');
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(['-NoLogo']);
  });

  it("cmd テンプレには args が undefined であること", () => {
    const result = findTemplate('cmd');
    expect(result).not.toBeNull();
    expect(result!.args).toBeUndefined();
  });

  it("Nushell テンプレには args が undefined であること", () => {
    const result = findTemplate('nushell');
    expect(result).not.toBeNull();
    expect(result!.args).toBeUndefined();
  });

  it("findTemplate('unknown') で null が返る", () => {
    expect(findTemplate('unknown')).toBeNull();
  });

  it("findTemplate('') で null が返る", () => {
    expect(findTemplate('')).toBeNull();
  });
});

describe('PROFILE_TEMPLATES', () => {
  it('重複 id がない', () => {
    const ids = PROFILE_TEMPLATES.map((t) => t.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('各エントリで shell が空文字列でない', () => {
    for (const tpl of PROFILE_TEMPLATES) {
      expect(tpl.shell.length, `${tpl.id}.shell が空`).toBeGreaterThan(0);
    }
  });

  it('各エントリで title が空文字列でない', () => {
    for (const tpl of PROFILE_TEMPLATES) {
      expect(tpl.title.length, `${tpl.id}.title が空`).toBeGreaterThan(0);
    }
  });

  it('各エントリで label が空文字列でない', () => {
    for (const tpl of PROFILE_TEMPLATES) {
      expect(tpl.label.length, `${tpl.id}.label が空`).toBeGreaterThan(0);
    }
  });
});
