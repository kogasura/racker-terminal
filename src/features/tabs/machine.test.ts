import { describe, it, expect } from 'vitest';
import { initialState, transition, type TabsState } from './machine';
import type { TabsEvent } from './events';

// コマンドを通すかどうかの裁定。純粋関数なのでそのまま踏める。

const suspended: TabsState = { input: 'suspended' };

/** 発行された効果を取り出す。裁定で落ちたら null。 */
function effectsOf(state: TabsState, event: TabsEvent) {
  const step = transition(state, event);
  return step ? (step.effects ?? []) : null;
}

const COMMANDS: readonly TabsEvent[] = [
  { type: 'tabs/close-active-requested' },
  { type: 'tabs/navigate-requested', direction: 'next' },
  { type: 'tabs/restore-requested' },
  { type: 'tabs/spawn-default-requested' },
  { type: 'tabs/spawn-favorite-requested', index: 0 },
];

describe('tabs machine', () => {
  describe('入力モード', () => {
    it('コンテキストメニューが開くと止まる', () => {
      expect(transition(initialState, { type: 'tabs/context-menu-opened' })?.state).toEqual(
        suspended,
      );
    });

    it('閉じると戻る', () => {
      expect(transition(suspended, { type: 'tabs/context-menu-closed' })?.state).toEqual(
        initialState,
      );
    });

    it('同じモードへの変化は無視する（無駄な再描画を出さない）', () => {
      expect(transition(initialState, { type: 'tabs/context-menu-closed' })).toBeNull();
      expect(transition(suspended, { type: 'tabs/context-menu-opened' })).toBeNull();
    });
  });

  describe('コマンドの裁定', () => {
    it('accepting なら効果を出す', () => {
      expect(effectsOf(initialState, { type: 'tabs/close-active-requested' })).toEqual([
        { kind: 'close-active' },
      ]);
      expect(effectsOf(initialState, { type: 'tabs/navigate-requested', direction: 'prev' })).toEqual(
        [{ kind: 'navigate', direction: 'prev' }],
      );
      expect(effectsOf(initialState, { type: 'tabs/restore-requested' })).toEqual([
        { kind: 'restore' },
      ]);
      expect(effectsOf(initialState, { type: 'tabs/spawn-default-requested' })).toEqual([
        { kind: 'spawn-default' },
      ]);
      expect(
        effectsOf(initialState, { type: 'tabs/spawn-favorite-requested', index: 8 }),
      ).toEqual([{ kind: 'spawn-favorite', index: 8 }]);
    });

    it('suspended ならどのコマンドも捨てる', () => {
      for (const command of COMMANDS) {
        expect(transition(suspended, command)).toBeNull();
      }
    });

    it('コマンドは状態を変えない（効果を出すだけ）', () => {
      for (const command of COMMANDS) {
        expect(transition(initialState, command)?.state).toBe(initialState);
      }
    });
  });

  describe('ポインタ由来のコマンドは止めない', () => {
    // メニューが開いているときにボタンを押せば、まずメニューが閉じてから
    // クリックが届く。キーボードと違って誤爆の経路が無いので止める理由がない。
    const POINTER_COMMANDS: readonly TabsEvent[] = [
      { type: 'tabs/tab-create-requested' },
      { type: 'tabs/group-create-requested' },
    ];

    it('accepting でも suspended でも効果を出す', () => {
      for (const command of POINTER_COMMANDS) {
        expect(transition(initialState, command)?.effects).toHaveLength(1);
        expect(transition(suspended, command)?.effects).toHaveLength(1);
      }
    });

    it('タブ追加 / グループ追加がそれぞれの効果になる', () => {
      expect(effectsOf(initialState, { type: 'tabs/tab-create-requested' })).toEqual([
        { kind: 'create-tab' },
      ]);
      expect(effectsOf(initialState, { type: 'tabs/group-create-requested' })).toEqual([
        { kind: 'create-group' },
      ]);
    });
  });
});
