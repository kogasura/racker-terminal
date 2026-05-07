import { describe, it, expect } from 'vitest';
import { isAllowedUrl } from './urlValidator';

describe('isAllowedUrl', () => {
  it('1: http URL → true', () => {
    expect(isAllowedUrl('http://example.com')).toBe(true);
  });

  it('2: https URL with path / query / hash → true', () => {
    expect(isAllowedUrl('https://example.com/path?q=1#hash')).toBe(true);
  });

  it('3: javascript: スキーム → false', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
  });

  it('4: file: スキーム → false', () => {
    expect(isAllowedUrl('file:///c:/win.ini')).toBe(false);
  });

  it('5: data: スキーム → false', () => {
    expect(isAllowedUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('6: ftp: スキーム → false', () => {
    expect(isAllowedUrl('ftp://example.com')).toBe(false);
  });

  it('7: 制御文字混入 (BEL \\x07) → false', () => {
    expect(isAllowedUrl('https://exam\x07ple.com')).toBe(false);
  });

  it('8: 2048 文字超の巨大 URL → false', () => {
    // "https://x.com/" (14 文字) + 2035 文字 = 2049 文字 > 2048
    const url = 'https://x.com/' + 'a'.repeat(2035);
    expect(url.length).toBeGreaterThan(2048);
    expect(isAllowedUrl(url)).toBe(false);
  });

  it('9: 空文字列 → false', () => {
    expect(isAllowedUrl('')).toBe(false);
  });

  it('10: 不正な URL (parse 失敗) → false', () => {
    expect(isAllowedUrl('not a url')).toBe(false);
  });

  it('11: C1 制御文字 (U+0085 NEL) 混入 → false', () => {
    expect(isAllowedUrl('https://exam\x85ple.com')).toBe(false);
  });

  it('12: Bidi 上書き文字 (RLO U+202E) 混入による URL 偽装 → false', () => {
    // 'https://safe.com/' + RLO + 'moc.live/login' のような偽装攻撃を弾く
    const spoofed = 'https://safe.com/‮moc.live/login';
    expect(isAllowedUrl(spoofed)).toBe(false);
  });
});
