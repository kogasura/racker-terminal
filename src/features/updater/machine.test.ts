import { describe, it, expect } from 'vitest';
import { initialState, transition, type FlowState, type UpdaterState } from './machine';
import type { UpdaterEvent } from './events';
import type { UpdateInfo } from '../../types';

// 遷移関数は純粋なので、非同期も DOM も無しで全パターンを踏める。
// store 時代は同じ検証のために downloadUpdate をモックして await が必要だった。

const info: UpdateInfo = { version: '1.2.0', currentVersion: '1.1.0', notes: 'note' };
const newer: UpdateInfo = { version: '1.4.0', currentVersion: '1.1.0', notes: '' };

function state(flow: FlowState, rest: Partial<UpdaterState> = {}): UpdaterState {
  return { ...initialState, flow, ...rest };
}

/** 遷移させて次の状態を取り出す。無視されたら元の状態をそのまま返す。 */
function next(s: UpdaterState, event: UpdaterEvent): UpdaterState {
  return transition(s, event)?.state ?? s;
}

/** 発行された副作用の種類。 */
function effects(s: UpdaterState, event: UpdaterEvent): string[] {
  return (transition(s, event)?.effects ?? []).map((e) => e.kind);
}

describe('updater machine', () => {
  describe('チェック', () => {
    it('idle → checking し、check 副作用を出す', () => {
      const e = { type: 'updater/check-requested', manual: false } as const;
      expect(next(initialState, e).flow.status).toBe('checking');
      expect(effects(initialState, e)).toEqual(['check']);
    });

    it('checking 中の再チェックは無視する', () => {
      const s = state({ status: 'checking', manual: false });
      expect(transition(s, { type: 'updater/check-requested', manual: false })).toBeNull();
    });

    it('downloading 中の再チェックは無視する', () => {
      const s = state({ status: 'downloading', info, progress: 0.3 });
      expect(transition(s, { type: 'updater/check-requested', manual: false })).toBeNull();
    });

    it('更新ありなら downloading へ進み、download 副作用を出す', () => {
      const s = state({ status: 'checking', manual: false });
      const e = { type: 'updater/check-succeeded', info } as const;
      expect(next(s, e).flow).toEqual({ status: 'downloading', info, progress: 0 });
      expect(effects(s, e)).toEqual(['download']);
    });

    it('更新なしなら idle に戻る', () => {
      const s = state({ status: 'checking', manual: false });
      expect(next(s, { type: 'updater/check-succeeded', info: null }).flow.status).toBe('idle');
    });
  });

  describe('ダウンロード', () => {
    it('1% 以上の変化だけ進捗を反映する', () => {
      const s = state({ status: 'downloading', info, progress: 0.5 });
      expect(transition(s, { type: 'updater/download-progressed', ratio: 0.505 })).toBeNull();
      const moved = next(s, { type: 'updater/download-progressed', ratio: 0.52 });
      expect(moved.flow).toMatchObject({ status: 'downloading', progress: 0.52 });
    });

    it('不明 (-1) と既知の行き来は変化として扱う', () => {
      const unknown = state({ status: 'downloading', info, progress: -1 });
      expect(next(unknown, { type: 'updater/download-progressed', ratio: 0 }).flow).toMatchObject({
        progress: 0,
      });
    });

    it('完了で ready になり、ダイアログは閉じたままにする', () => {
      const s = state({ status: 'downloading', info, progress: 1 });
      expect(next(s, { type: 'updater/download-succeeded' }).flow).toEqual({
        status: 'ready',
        info,
        dialogOpen: false,
        refreshing: false,
      });
    });

    it('DL 失敗は idle に戻す (ユーザーには見せない)', () => {
      const s = state({ status: 'downloading', info, progress: 0.4 });
      expect(next(s, { type: 'updater/download-failed' }).flow.status).toBe('idle');
    });
  });

  describe('待機中の差し替え', () => {
    it('ready のときのチェックは refresh 副作用になり、status は ready のまま', () => {
      const s = state({ status: 'ready', info, dialogOpen: false, refreshing: false });
      const e = { type: 'updater/check-requested', manual: false } as const;
      expect(effects(s, e)).toEqual(['refresh']);
      expect(next(s, e).flow).toMatchObject({ status: 'ready', refreshing: true });
    });

    it('差し替え中の再チェックは二重に走らせない', () => {
      const s = state({ status: 'ready', info, dialogOpen: false, refreshing: true });
      expect(transition(s, { type: 'updater/check-requested', manual: false })).toBeNull();
    });

    it('より新しい版に差し替わる', () => {
      const s = state({ status: 'ready', info, dialogOpen: false, refreshing: true });
      expect(next(s, { type: 'updater/refresh-succeeded', info: newer }).flow).toMatchObject({
        status: 'ready',
        info: newer,
        refreshing: false,
      });
    });

    it('差し替え中にユーザーが適用を始めていたら結果を捨てる', () => {
      const s = state({ status: 'installing', info, dialogOpen: true });
      expect(transition(s, { type: 'updater/refresh-succeeded', info: newer })).toBeNull();
    });
  });

  describe('ダイアログ', () => {
    it('ready でバッジを押すと開く', () => {
      const s = state({ status: 'ready', info, dialogOpen: false, refreshing: false });
      expect(next(s, { type: 'updater/badge-clicked' }).flow).toMatchObject({ dialogOpen: true });
    });

    it('downloading 中はバッジを押しても何も起きない (そもそも出ていない)', () => {
      const s = state({ status: 'downloading', info, progress: 0.2 });
      expect(transition(s, { type: 'updater/badge-clicked' })).toBeNull();
    });

    it('閉じられる', () => {
      const s = state({ status: 'ready', info, dialogOpen: true, refreshing: false });
      expect(next(s, { type: 'updater/dialog-dismissed' }).flow).toMatchObject({
        dialogOpen: false,
      });
    });

    it('インストール中は閉じられない', () => {
      const s = state({ status: 'installing', info, dialogOpen: true });
      expect(transition(s, { type: 'updater/dialog-dismissed' })).toBeNull();
    });
  });

  describe('適用', () => {
    it('ready から installing へ進み、install 副作用を出す', () => {
      const s = state({ status: 'ready', info, dialogOpen: true, refreshing: false });
      expect(effects(s, { type: 'updater/apply-requested' })).toEqual(['install']);
      expect(next(s, { type: 'updater/apply-requested' }).flow.status).toBe('installing');
    });

    it('error からもリトライできる', () => {
      const s = state({ status: 'error', info, message: 'boom', dialogOpen: true });
      expect(next(s, { type: 'updater/apply-requested' }).flow.status).toBe('installing');
    });

    it('idle / downloading からは適用できない', () => {
      expect(transition(initialState, { type: 'updater/apply-requested' })).toBeNull();
      const dl = state({ status: 'downloading', info, progress: 0.5 });
      expect(transition(dl, { type: 'updater/apply-requested' })).toBeNull();
    });

    it('installing 中の再入は弾く', () => {
      const s = state({ status: 'installing', info, dialogOpen: true });
      expect(transition(s, { type: 'updater/apply-requested' })).toBeNull();
    });

    it('失敗すると error になり、理由を保持する', () => {
      const s = state({ status: 'installing', info, dialogOpen: true });
      expect(next(s, { type: 'updater/install-failed', message: 'boom' }).flow).toEqual({
        status: 'error',
        info,
        message: 'boom',
        dialogOpen: true,
      });
    });

    it('error をリセットすると idle に戻る', () => {
      const s = state({ status: 'error', info, message: 'boom', dialogOpen: true });
      expect(next(s, { type: 'updater/error-reset' }).flow.status).toBe('idle');
    });
  });

  describe('直交リージョン: 前回の更新失敗', () => {
    const failure = { version: '1.9.3', currentVersion: '1.9.2' };

    it('フローの状態に関係なく立つ', () => {
      const dl = state({ status: 'downloading', info, progress: 0.5 });
      const after = next(dl, { type: 'updater/previous-attempt-detected', failure });
      expect(after.installFailure).toEqual(failure);
      // フロー側は動かない
      expect(after.flow).toEqual(dl.flow);
    });

    it('閉じると消える', () => {
      const s = state({ status: 'idle' }, { installFailure: failure });
      expect(next(s, { type: 'updater/failure-notice-dismissed' }).installFailure).toBeNull();
    });

    it('何も出ていないときに閉じても何も起きない', () => {
      expect(transition(initialState, { type: 'updater/failure-notice-dismissed' })).toBeNull();
    });
  });

  describe('直交リージョン: 手動チェックの結果', () => {
    it('手動で更新なしなら no-update', () => {
      const s = state({ status: 'checking', manual: true });
      expect(next(s, { type: 'updater/check-succeeded', info: null }).manualCheck).toBe('no-update');
    });

    it('手動で更新ありなら found', () => {
      const s = state({ status: 'checking', manual: true });
      expect(next(s, { type: 'updater/check-succeeded', info }).manualCheck).toBe('found');
    });

    it('自動チェックの結果はメッセージ欄に出さない', () => {
      const s = state({ status: 'checking', manual: false }, { manualCheck: 'no-update' });
      expect(next(s, { type: 'updater/check-succeeded', info }).manualCheck).toBe('no-update');
    });

    it('手動チェックのたびに前回のメッセージを消す', () => {
      const s = state({ status: 'idle' }, { manualCheck: 'no-update' });
      expect(next(s, { type: 'updater/check-requested', manual: true }).manualCheck).toBe('none');
    });

    it('チェックに失敗したら error', () => {
      const s = state({ status: 'checking', manual: true });
      expect(next(s, { type: 'updater/check-failed' }).manualCheck).toBe('error');
      expect(next(s, { type: 'updater/check-failed' }).flow.status).toBe('idle');
    });
  });
});
