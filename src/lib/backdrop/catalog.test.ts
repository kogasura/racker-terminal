import { describe, it, expect } from 'vitest';
import { BUILTIN_SCENES, sceneSvg } from './catalog';

const HEX = /^#[0-9a-f]{6}$/;

/** WCAG の相対輝度。 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** SVG の名前空間の宣言。これだけは http: を含んでよい（参照ではない）。 */
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

const cases = BUILTIN_SCENES.map((s) => [s.id, s] as const);

describe('BUILTIN_SCENES', () => {
  it('本家と同じ 20 シーンがある', () => {
    expect(BUILTIN_SCENES).toHaveLength(20);
  });

  it('ID が重複しない', () => {
    const ids = BUILTIN_SCENES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('twin は互いを指し、ライトとダークの組になっている', () => {
    const byId = new Map(BUILTIN_SCENES.map((s) => [s.id, s]));
    const paired = BUILTIN_SCENES.filter((s) => s.twin !== undefined);
    expect(paired).toHaveLength(8);
    for (const scene of paired) {
      const twin = byId.get(scene.twin ?? '');
      expect(twin, scene.id).toBeDefined();
      expect(twin?.twin).toBe(scene.id);
      expect(twin?.window).not.toBe(scene.window);
    }
  });

  it.each(cases)('%s: accent / accent2 / glass.tint が #rrggbb で、glass が範囲内', (_id, scene) => {
    expect(scene.accent).toMatch(HEX);
    expect(scene.accent2).toMatch(HEX);
    expect(scene.glass.tint).toMatch(HEX);
    expect(scene.glass.blur).toBeGreaterThanOrEqual(0);
    expect(scene.glass.blur).toBeLessThanOrEqual(40);
    expect(scene.glass.opacity).toBeGreaterThanOrEqual(0);
    expect(scene.glass.opacity).toBeLessThanOrEqual(1);
  });

  it.each(cases)('%s: accent / accent2 が tint の上で 4.5:1 以上で読める', (_id, scene) => {
    expect(contrast(scene.accent, scene.glass.tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(scene.accent2, scene.glass.tint)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)('%s: title と blurb が空でない', (_id, scene) => {
    expect(scene.title.trim()).not.toBe('');
    expect(scene.blurb.trim()).not.toBe('');
  });
});

describe('sceneSvg', () => {
  it.each(cases)('%s: 整形式の SVG として読める', (id) => {
    const svg = sceneSvg(id);
    expect(svg).toBeDefined();
    const doc = new DOMParser().parseFromString(svg ?? '', 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.tagName.toLowerCase()).toBe('svg');
  });

  it.each(cases)('%s: script・イベント属性・外部参照を含まない', (id) => {
    const svg = sceneSvg(id) ?? '';
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
    expect(svg.split(SVG_NS).join('')).not.toMatch(/https?:/i);
  });

  it.each(cases)('%s: prefers-reduced-motion で止める指定が入っている', (id) => {
    expect(sceneSvg(id)).toContain('prefers-reduced-motion: reduce');
  });

  it('2 回呼ぶと同じ文字列を返す', () => {
    const first = sceneSvg('aurora');
    expect(first).toBeDefined();
    expect(sceneSvg('aurora')).toBe(first);
  });

  it('組み込みに無い ID には undefined を返す', () => {
    expect(sceneSvg('no-such-scene')).toBeUndefined();
    expect(sceneSvg('')).toBeUndefined();
    expect(sceneSvg('toString')).toBeUndefined();
  });
});
