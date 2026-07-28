import { describe, it, expect } from 'vitest';
import { prBadgeKind, prTooltip, isWindowsPath, groupTabsByCwd } from './prStatus';

describe('prBadgeKind', () => {
  it('1: OPEN は open', () => {
    expect(prBadgeKind({ branch: 'b', number: 1, state: 'OPEN' })).toBe('open');
  });

  it('2: draft は open より優先する（state は OPEN のまま isDraft が立つため）', () => {
    expect(prBadgeKind({ branch: 'b', number: 1, state: 'OPEN', isDraft: true })).toBe('draft');
  });

  it('3: MERGED / CLOSED をそれぞれ区別する', () => {
    expect(prBadgeKind({ branch: 'b', number: 1, state: 'MERGED' })).toBe('merged');
    expect(prBadgeKind({ branch: 'b', number: 1, state: 'CLOSED' })).toBe('closed');
  });

  it('4: PR 番号が無ければ表示しない（ブランチだけでは出さない）', () => {
    expect(prBadgeKind({ branch: 'feat/x' })).toBeNull();
  });

  it('5: null / undefined は表示しない', () => {
    expect(prBadgeKind(null)).toBeNull();
    expect(prBadgeKind(undefined)).toBeNull();
  });

  it('6: 未知の state は表示しない（gh の出力が変わっても壊れない）', () => {
    expect(prBadgeKind({ branch: 'b', number: 1, state: 'BRAND_NEW' })).toBeNull();
  });

  it('7: マージ済みの PR に isDraft が残っていても merged を優先する', () => {
    expect(prBadgeKind({ branch: 'b', number: 1, state: 'MERGED', isDraft: true })).toBe('merged');
  });
});

describe('prTooltip', () => {
  it('8: 番号・状態・ブランチ名を含める', () => {
    const t = prTooltip({ branch: 'feat/x', number: 63, state: 'MERGED' });
    expect(t).toContain('#63');
    expect(t).toContain('マージ済み');
    expect(t).toContain('feat/x');
  });
});

describe('isWindowsPath', () => {
  it('9: ドライブレター始まりを Windows パスと判定する', () => {
    expect(isWindowsPath('C:\\Users\\me\\dev')).toBe(true);
    expect(isWindowsPath('D:/projects')).toBe(true);
  });

  it('10: WSL の Linux パスは対象外（Windows の git から辿れないため）', () => {
    expect(isWindowsPath('/home/me/dev')).toBe(false);
  });

  it('11: undefined / 空は対象外', () => {
    expect(isWindowsPath(undefined)).toBe(false);
    expect(isWindowsPath('')).toBe(false);
  });
});

describe('groupTabsByCwd', () => {
  it('12: 同じ cwd のタブをまとめる（gh を叩く回数を抑えるため）', () => {
    const tabs = [
      { id: 't1', cwd: 'C:\\dev\\app' },
      { id: 't2', cwd: 'C:\\dev\\app' },
      { id: 't3', cwd: 'C:\\dev\\other' },
    ];

    const grouped = groupTabsByCwd(tabs);

    expect(grouped.get('C:\\dev\\app')).toEqual(['t1', 't2']);
    expect(grouped.get('C:\\dev\\other')).toEqual(['t3']);
  });

  it('13: WSL タブと cwd 無しのタブは除外する', () => {
    const tabs = [
      { id: 't1', cwd: '/home/me/dev' },
      { id: 't2' },
      { id: 't3', cwd: 'C:\\dev\\app' },
    ];

    const grouped = groupTabsByCwd(tabs);

    expect(grouped.size).toBe(1);
    expect(grouped.get('C:\\dev\\app')).toEqual(['t3']);
  });

  it('14: 対象が無ければ空', () => {
    expect(groupTabsByCwd([{ id: 't1', cwd: '/home/me' }]).size).toBe(0);
  });
});
