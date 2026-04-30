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
