import { describe, it, expect } from 'vitest';
import { initialState, type FlowState, type UpdaterState } from './machine';
import {
  selectBadge,
  selectDialog,
  selectFailureNotice,
  selectSettingsSection,
} from './viewModel';
import type { UpdateInfo } from '../../types';

// 見た目の仕様をここで固定する。View はこの結果を並べるだけなので、
// 「どの状態で何が出るか」はレンダリングせずに確かめられる。

const info: UpdateInfo = { version: '1.2.0', currentVersion: '1.1.0', notes: 'リリースノート' };

function state(flow: FlowState, rest: Partial<UpdaterState> = {}): UpdaterState {
  return { ...initialState, flow, ...rest };
}

describe('selectBadge', () => {
  it('idle / checking / downloading では出さない', () => {
    expect(selectBadge(initialState).visible).toBe(false);
    expect(selectBadge(state({ status: 'checking', manual: false })).visible).toBe(false);
    expect(selectBadge(state({ status: 'downloading', info, progress: 0.5 })).visible).toBe(false);
  });

  it('ready では ↑ を出す', () => {
    const vm = selectBadge(state({ status: 'ready', info, dialogOpen: false, refreshing: false }));
    expect(vm).toMatchObject({ visible: true, label: '↑', variant: 'ready' });
  });

  it('error では ! を出す', () => {
    const vm = selectBadge(state({ status: 'error', info, message: 'boom', dialogOpen: false }));
    expect(vm).toMatchObject({ visible: true, label: '!', variant: 'error' });
  });
});

describe('selectDialog', () => {
  it('dialogOpen が false なら閉じている', () => {
    const vm = selectDialog(state({ status: 'ready', info, dialogOpen: false, refreshing: false }));
    expect(vm.open).toBe(false);
  });

  it('ready ではノートと 2 つのボタンを出す', () => {
    const vm = selectDialog(state({ status: 'ready', info, dialogOpen: true, refreshing: false }));
    expect(vm).toMatchObject({
      open: true,
      body: 'ready',
      notes: 'リリースノート',
      dismissible: true,
      primaryLabel: '今すぐ再起動',
      secondaryLabel: 'あとで',
    });
    expect(vm.title).toContain('1.1.0 → 1.2.0');
  });

  it('ノートが空なら出さない', () => {
    const vm = selectDialog(
      state({ status: 'ready', info: { ...info, notes: '' }, dialogOpen: true, refreshing: false }),
    );
    expect(vm.notes).toBeNull();
  });

  it('インストール中は閉じさせない', () => {
    const vm = selectDialog(state({ status: 'installing', info, dialogOpen: true }));
    expect(vm).toMatchObject({ open: true, body: 'installing', dismissible: false });
  });

  it('error では理由とリトライを出す', () => {
    const vm = selectDialog(state({ status: 'error', info, message: 'boom', dialogOpen: true }));
    expect(vm).toMatchObject({
      body: 'error',
      errorMessage: 'boom',
      primaryLabel: 'リトライ',
      dismissible: true,
    });
  });

  it('理由が空でも既定の文言を出す', () => {
    const vm = selectDialog(state({ status: 'error', info, message: '', dialogOpen: true }));
    expect(vm.errorMessage).toBe('アップデートに失敗しました。');
  });
});

describe('selectFailureNotice', () => {
  it('無ければ出さない', () => {
    expect(selectFailureNotice(initialState).visible).toBe(false);
  });

  it('あれば両方のバージョンを渡す', () => {
    const vm = selectFailureNotice(
      state({ status: 'idle' }, { installFailure: { version: '1.9.3', currentVersion: '1.9.2' } }),
    );
    expect(vm).toEqual({ visible: true, version: '1.9.3', currentVersion: '1.9.2' });
  });
});

describe('selectSettingsSection', () => {
  it('idle では押せる', () => {
    expect(selectSettingsSection(initialState)).toMatchObject({
      buttonLabel: 'アップデートを確認',
      buttonDisabled: false,
      opensDialog: false,
      message: null,
    });
  });

  it('進行中は押せない', () => {
    expect(selectSettingsSection(state({ status: 'checking', manual: true }))).toMatchObject({
      buttonLabel: '確認中…',
      buttonDisabled: true,
    });
    expect(
      selectSettingsSection(state({ status: 'downloading', info, progress: 0.2 })),
    ).toMatchObject({ buttonLabel: 'ダウンロード中…', buttonDisabled: true });
    expect(selectSettingsSection(state({ status: 'installing', info, dialogOpen: true }))).toMatchObject(
      { buttonLabel: 'インストール中…', buttonDisabled: true },
    );
  });

  it('ready では適用へ誘導し、待機中の版を知らせる', () => {
    expect(
      selectSettingsSection(state({ status: 'ready', info, dialogOpen: false, refreshing: false })),
    ).toMatchObject({
      buttonLabel: '再起動して適用',
      opensDialog: true,
      message: 'v1.2.0 の準備ができています。',
    });
  });

  it('手動チェックで更新が無かったことを伝える', () => {
    expect(selectSettingsSection(state({ status: 'idle' }, { manualCheck: 'no-update' })).message).toBe(
      '最新バージョンです。',
    );
  });

  it('手動チェックで見つかった版は DL 中に知らせる', () => {
    expect(
      selectSettingsSection(
        state({ status: 'downloading', info, progress: 0 }, { manualCheck: 'found' }),
      ).message,
    ).toBe('v1.2.0 が見つかりました。ダウンロード後にお知らせします。');
  });
});
