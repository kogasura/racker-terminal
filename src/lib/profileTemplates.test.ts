import { describe, it, expect } from 'vitest';
import {
  buildProfileTemplates,
  findTemplate,
  isWslShell,
  buildWslArgs,
  parseWslArgs,
  isStandardWslArgs,
} from './profileTemplates';

describe('buildProfileTemplates', () => {
  it('distro なしで静的テンプレ 5 件のみ返す', () => {
    const templates = buildProfileTemplates([]);
    expect(templates).toHaveLength(5);
    const ids = templates.map((t) => t.id);
    expect(ids).toContain('pwsh5');
    expect(ids).toContain('pwsh7');
    expect(ids).toContain('cmd');
    expect(ids).toContain('gitbash');
    expect(ids).toContain('nushell');
  });

  it('Ubuntu-22.04 1 件で WSL エントリ 1 件 + 静的 5 件 = 6 件', () => {
    const templates = buildProfileTemplates(['Ubuntu-22.04']);
    expect(templates).toHaveLength(6);
  });

  it('WSL エントリが先頭に来ること', () => {
    const templates = buildProfileTemplates(['Ubuntu-22.04']);
    expect(templates[0].id).toBe('wsl-Ubuntu-22.04');
    expect(templates[0].label).toBe('WSL: Ubuntu-22.04');
    expect(templates[0].title).toBe('Ubuntu-22.04');
    expect(templates[0].shell).toBe('wsl.exe');
  });

  it('WSL エントリの args が [-d, distro, --cd, ~] であること', () => {
    const templates = buildProfileTemplates(['Ubuntu-22.04']);
    expect(templates[0].args).toEqual(['-d', 'Ubuntu-22.04', '--cd', '~']);
  });

  it('複数 distro で WSL 2 件が順序通り先頭に来る', () => {
    const templates = buildProfileTemplates(['Ubuntu', 'Debian']);
    expect(templates).toHaveLength(7);
    expect(templates[0].id).toBe('wsl-Ubuntu');
    expect(templates[1].id).toBe('wsl-Debian');
    // 静的テンプレートは後続
    expect(templates[2].id).toBe('pwsh5');
  });

  it('各 distro の args が正しく設定される', () => {
    const templates = buildProfileTemplates(['Ubuntu', 'Debian']);
    expect(templates[0].args).toEqual(['-d', 'Ubuntu', '--cd', '~']);
    expect(templates[1].args).toEqual(['-d', 'Debian', '--cd', '~']);
  });

  it('静的テンプレの args が正しい (pwsh5)', () => {
    const templates = buildProfileTemplates([]);
    const pwsh5 = findTemplate(templates, 'pwsh5');
    expect(pwsh5).not.toBeNull();
    expect(pwsh5!.args).toEqual(['-NoLogo']);
  });

  it('静的テンプレの args が正しい (pwsh7)', () => {
    const templates = buildProfileTemplates([]);
    const pwsh7 = findTemplate(templates, 'pwsh7');
    expect(pwsh7).not.toBeNull();
    expect(pwsh7!.args).toEqual(['-NoLogo']);
  });

  it('静的テンプレの args が正しい (gitbash)', () => {
    const templates = buildProfileTemplates([]);
    const gitbash = findTemplate(templates, 'gitbash');
    expect(gitbash).not.toBeNull();
    expect(gitbash!.args).toEqual(['--login', '-i']);
  });

  it('静的テンプレの args が undefined (cmd)', () => {
    const templates = buildProfileTemplates([]);
    const cmd = findTemplate(templates, 'cmd');
    expect(cmd).not.toBeNull();
    expect(cmd!.args).toBeUndefined();
  });

  it('静的テンプレの args が undefined (nushell)', () => {
    const templates = buildProfileTemplates([]);
    const nushell = findTemplate(templates, 'nushell');
    expect(nushell).not.toBeNull();
    expect(nushell!.args).toBeUndefined();
  });
});

describe('findTemplate', () => {
  it('WSL エントリが取れる', () => {
    const templates = buildProfileTemplates(['Ubuntu']);
    const result = findTemplate(templates, 'wsl-Ubuntu');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('wsl-Ubuntu');
    expect(result!.shell).toBe('wsl.exe');
  });

  it("findTemplate(templates, 'unknown') で null が返る", () => {
    const templates = buildProfileTemplates(['Ubuntu']);
    expect(findTemplate(templates, 'unknown')).toBeNull();
  });

  it("findTemplate(templates, '') で null が返る", () => {
    const templates = buildProfileTemplates([]);
    expect(findTemplate(templates, '')).toBeNull();
  });
});

describe('buildProfileTemplates 整合性', () => {
  it('各エントリで shell が空文字列でない', () => {
    const templates = buildProfileTemplates(['Ubuntu-22.04']);
    for (const tpl of templates) {
      expect(tpl.shell.length, `${tpl.id}.shell が空`).toBeGreaterThan(0);
    }
  });

  it('各エントリで title が空文字列でない', () => {
    const templates = buildProfileTemplates(['Ubuntu-22.04']);
    for (const tpl of templates) {
      expect(tpl.title.length, `${tpl.id}.title が空`).toBeGreaterThan(0);
    }
  });

  it('各エントリで label が空文字列でない', () => {
    const templates = buildProfileTemplates(['Ubuntu-22.04']);
    for (const tpl of templates) {
      expect(tpl.label.length, `${tpl.id}.label が空`).toBeGreaterThan(0);
    }
  });

  it('id 重複がない', () => {
    const templates = buildProfileTemplates(['Ubuntu', 'Debian']);
    const ids = templates.map((t) => t.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe('isWslShell', () => {
  it('wsl.exe / フルパス / 大文字 / 拡張子なし を WSL と判定', () => {
    expect(isWslShell('wsl.exe')).toBe(true);
    expect(isWslShell('C:\\Windows\\System32\\wsl.exe')).toBe(true);
    expect(isWslShell('WSL.EXE')).toBe(true);
    expect(isWslShell('wsl')).toBe(true);
  });

  it('他シェル・未指定は false', () => {
    expect(isWslShell('nu')).toBe(false);
    expect(isWslShell('powershell.exe')).toBe(false);
    expect(isWslShell(undefined)).toBe(false);
    expect(isWslShell('')).toBe(false);
  });
});

describe('buildWslArgs', () => {
  it('distro + dir から -d / --cd を組み立てる', () => {
    expect(buildWslArgs('Ubuntu-22.04', '~/jdf-dev/uranus2/server')).toEqual([
      '-d', 'Ubuntu-22.04', '--cd', '~/jdf-dev/uranus2/server',
    ]);
  });

  it('dir 空は --cd ~ にフォールバック', () => {
    expect(buildWslArgs('Ubuntu', '')).toEqual(['-d', 'Ubuntu', '--cd', '~']);
    expect(buildWslArgs('Ubuntu', '   ')).toEqual(['-d', 'Ubuntu', '--cd', '~']);
  });

  it('distro 空は -d を省略', () => {
    expect(buildWslArgs('', '~/x')).toEqual(['--cd', '~/x']);
  });
});

describe('parseWslArgs', () => {
  it('-d / --cd の値を取り出す', () => {
    expect(parseWslArgs(['-d', 'Ubuntu-22.04', '--cd', '~/x'])).toEqual({
      distro: 'Ubuntu-22.04', dir: '~/x',
    });
  });

  it('--distribution も distro として扱う', () => {
    expect(parseWslArgs(['--distribution', 'Debian']).distro).toBe('Debian');
  });

  it('見つからなければ空文字 / undefined でも安全', () => {
    expect(parseWslArgs(['--cd', '~'])).toEqual({ distro: '', dir: '~' });
    expect(parseWslArgs(undefined)).toEqual({ distro: '', dir: '' });
    expect(parseWslArgs([])).toEqual({ distro: '', dir: '' });
  });
});

describe('isStandardWslArgs', () => {
  it('-d / --cd ペアのみは標準形 (true)', () => {
    expect(isStandardWslArgs(['-d', 'Ubuntu', '--cd', '~'])).toBe(true);
    expect(isStandardWslArgs(['--cd', '~/x'])).toBe(true);
    expect(isStandardWslArgs([])).toBe(true);
    expect(isStandardWslArgs(undefined)).toBe(true);
  });

  it('-- や未知トークンを含むと非標準 (false)', () => {
    expect(isStandardWslArgs(['-d', 'Ubuntu', '--', 'bash', '-ic', 'claude'])).toBe(false);
    expect(isStandardWslArgs(['-u', 'root'])).toBe(false);
    expect(isStandardWslArgs(['-d', 'Ubuntu', '--cd'])).toBe(false); // 値欠落
  });
});
