/**
 * 状態 → View モデルの射影。純粋関数。
 *
 * Passive View に「判断」を持ち込ませないための層。ボタンを出すか、文言は何か、
 * 押せるかどうかは全部ここで決めきって、View は受け取った値を並べるだけにする。
 * 分岐がここに集まるので、見た目の仕様はテストで直接固定できる。
 */

import type { UpdateInfo } from '../../types';
import type { UpdaterState } from './machine';

/** タイトルバーのバッジ。 */
export interface BadgeViewModel {
  readonly visible: boolean;
  readonly label: string;
  readonly description: string;
  readonly variant: 'ready' | 'error';
}

/** 更新ダイアログの本文の出し分け。 */
export type DialogBody = 'ready' | 'installing' | 'error';

export interface DialogViewModel {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly body: DialogBody;
  /** リリースノート。無ければ null。 */
  readonly notes: string | null;
  readonly errorMessage: string | null;
  /** 閉じる操作を受け付けるか (インストール中は false)。 */
  readonly dismissible: boolean;
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
}

/** 前回の更新が反映されなかったことの通知。 */
export interface FailureNoticeViewModel {
  readonly visible: boolean;
  readonly version: string;
  readonly currentVersion: string;
}

/** 設定画面の「アップデートを確認」まわり。 */
export interface SettingsSectionViewModel {
  readonly buttonLabel: string;
  readonly buttonDisabled: boolean;
  /** 押したときにダイアログを開く段階か (設定ダイアログを閉じる必要がある)。 */
  readonly opensDialog: boolean;
  readonly message: string | null;
}

export function selectBadge(state: UpdaterState): BadgeViewModel {
  const { flow } = state;
  if (flow.status === 'error') {
    return {
      visible: true,
      label: '!',
      description: 'アップデートエラー',
      variant: 'error',
    };
  }
  if (flow.status === 'ready') {
    return {
      visible: true,
      label: '↑',
      description: '再起動して更新を適用',
      variant: 'ready',
    };
  }
  return { visible: false, label: '', description: '', variant: 'ready' };
}

/** ダイアログを出さないときの既定値。 */
const HIDDEN_DIALOG: DialogViewModel = {
  open: false,
  title: '',
  description: '',
  body: 'ready',
  notes: null,
  errorMessage: null,
  dismissible: true,
  primaryLabel: '',
  secondaryLabel: '',
};

/** ダイアログ共通の見出し。 */
function dialogTitle(info: UpdateInfo): string {
  return `アップデートが利用可能です (${info.currentVersion} → ${info.version})`;
}

/** ready 以外で使う、現在のバージョンを示す説明文。 */
function versionLine(info: UpdateInfo): string {
  return `現在のバージョン: ${info.currentVersion}${info.date ? ` — リリース: ${info.date}` : ''}`;
}

/** 再起動待ち。ノートを見せて適用を促す。 */
function readyDialog(info: UpdateInfo): DialogViewModel {
  return {
    ...HIDDEN_DIALOG,
    open: true,
    title: dialogTitle(info),
    description: '新しいバージョンのダウンロードが完了しました。再起動して適用しますか?',
    body: 'ready',
    notes: info.notes ? info.notes : null,
    primaryLabel: '今すぐ再起動',
    secondaryLabel: 'あとで',
  };
}

/** インストール中。中断する手段がないので閉じる操作を受け付けない。 */
function installingDialog(info: UpdateInfo): DialogViewModel {
  return {
    ...HIDDEN_DIALOG,
    open: true,
    title: dialogTitle(info),
    description: versionLine(info),
    body: 'installing',
    dismissible: false,
  };
}

/** 失敗。理由を見せてリトライさせる。 */
function errorDialog(info: UpdateInfo, message: string): DialogViewModel {
  return {
    ...HIDDEN_DIALOG,
    open: true,
    title: dialogTitle(info),
    description: versionLine(info),
    body: 'error',
    errorMessage: message || 'アップデートに失敗しました。',
    primaryLabel: 'リトライ',
    secondaryLabel: '閉じる',
  };
}

export function selectDialog(state: UpdaterState): DialogViewModel {
  const { flow } = state;

  // idle / checking / downloading はダイアログを持たない (バッジも出ていない)。
  if (flow.status !== 'ready' && flow.status !== 'installing' && flow.status !== 'error') {
    return HIDDEN_DIALOG;
  }
  if (!flow.dialogOpen) return HIDDEN_DIALOG;

  if (flow.status === 'installing') return installingDialog(flow.info);
  if (flow.status === 'error') return errorDialog(flow.info, flow.message);
  return readyDialog(flow.info);
}

export function selectFailureNotice(state: UpdaterState): FailureNoticeViewModel {
  const failure = state.installFailure;
  if (!failure) return { visible: false, version: '', currentVersion: '' };
  return {
    visible: true,
    version: failure.version,
    currentVersion: failure.currentVersion,
  };
}

export function selectSettingsSection(state: UpdaterState): SettingsSectionViewModel {
  const { flow } = state;

  const busy =
    flow.status === 'checking' || flow.status === 'downloading' || flow.status === 'installing';

  const buttonLabel = (() => {
    if (flow.status === 'checking') return '確認中…';
    if (flow.status === 'downloading') return 'ダウンロード中…';
    if (flow.status === 'installing') return 'インストール中…';
    if (flow.status === 'ready') return '再起動して適用';
    if (flow.status === 'error') return 'エラー詳細を表示';
    return 'アップデートを確認';
  })();

  const message = (() => {
    if (flow.status === 'ready') return `v${flow.info.version} の準備ができています。`;
    if (state.manualCheck === 'no-update') return '最新バージョンです。';
    if (state.manualCheck === 'found' && flow.status === 'downloading') {
      return `v${flow.info.version} が見つかりました。ダウンロード後にお知らせします。`;
    }
    if (state.manualCheck === 'error') {
      return '確認に失敗しました。ネットワークを確認してください。';
    }
    return null;
  })();

  return {
    buttonLabel,
    buttonDisabled: busy,
    opensDialog: flow.status === 'ready' || flow.status === 'error',
    message,
  };
}
