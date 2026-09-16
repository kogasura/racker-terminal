import { describe, it, expect } from 'vitest';
import { favoriteIndexFromKey, tabCommandForKey } from './keys';

// キーと コマンドの対応表。純粋関数なので DOM も store も要らない。
// 判定順に意味がある (Ctrl+Shift+T を Ctrl+T より先に見る) ので、そこを固定する。

function key(init: Partial<KeyboardEvent> & { code?: string; key?: string }): KeyboardEvent {
  return {
    shiftKey: false,
    code: '',
    key: '',
    ...init,
  } as KeyboardEvent;
}

describe('tabCommandForKey', () => {
  it('Shift+W → アクティブタブを閉じる', () => {
    expect(tabCommandForKey(key({ shiftKey: true, code: 'KeyW' }))).toEqual({
      type: 'tabs/close-active-requested',
    });
  });

  it('Tab → 次へ、Shift+Tab → 前へ', () => {
    expect(tabCommandForKey(key({ code: 'Tab' }))).toEqual({
      type: 'tabs/navigate-requested',
      direction: 'next',
    });
    expect(tabCommandForKey(key({ shiftKey: true, code: 'Tab' }))).toEqual({
      type: 'tabs/navigate-requested',
      direction: 'prev',
    });
  });

  it('Shift+T は復元、T は既定タブ（順序が入れ替わらない）', () => {
    expect(tabCommandForKey(key({ shiftKey: true, code: 'KeyT' }))).toEqual({
      type: 'tabs/restore-requested',
    });
    expect(tabCommandForKey(key({ code: 'KeyT' }))).toEqual({
      type: 'tabs/spawn-default-requested',
    });
  });

  it('Shift+1..9 → お気に入り 0..8', () => {
    expect(tabCommandForKey(key({ shiftKey: true, code: 'Digit1' }))).toEqual({
      type: 'tabs/spawn-favorite-requested',
      index: 0,
    });
    expect(tabCommandForKey(key({ shiftKey: true, code: 'Numpad9' }))).toEqual({
      type: 'tabs/spawn-favorite-requested',
      index: 8,
    });
  });

  it('割り当ての無いキーは null', () => {
    expect(tabCommandForKey(key({ code: 'KeyQ' }))).toBeNull();
    expect(tabCommandForKey(key({ shiftKey: true, code: 'KeyZ' }))).toBeNull();
    // ターミナル面の操作はここでは拾わない
    expect(tabCommandForKey(key({ code: 'KeyV' }))).toBeNull();
    expect(tabCommandForKey(key({ code: 'KeyC' }))).toBeNull();
    expect(tabCommandForKey(key({ code: 'Enter' }))).toBeNull();
  });

  it('合成キー (e.code が空) は e.key でフォールバック判定する', () => {
    expect(tabCommandForKey(key({ code: '', key: 't' }))).toEqual({
      type: 'tabs/spawn-default-requested',
    });
    expect(tabCommandForKey(key({ shiftKey: true, code: '', key: '1' }))).toEqual({
      type: 'tabs/spawn-favorite-requested',
      index: 0,
    });
  });
});

describe('favoriteIndexFromKey', () => {
  it('Shift が無ければ対象外', () => {
    expect(favoriteIndexFromKey(key({ code: 'Digit1' }))).toBeNull();
  });

  it('0 は対象外 (1..9 のみ)', () => {
    expect(favoriteIndexFromKey(key({ shiftKey: true, code: 'Digit0' }))).toBeNull();
  });

  it('Digit / Numpad どちらでも取れる', () => {
    expect(favoriteIndexFromKey(key({ shiftKey: true, code: 'Digit5' }))).toBe(4);
    expect(favoriteIndexFromKey(key({ shiftKey: true, code: 'Numpad5' }))).toBe(4);
  });
});
