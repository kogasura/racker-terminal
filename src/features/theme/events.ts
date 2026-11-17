/**
 * theme 機能のイベント定義。
 *
 * View（設定ダイアログ）から上がる「操作」と、副作用（themes フォルダの読み込み）から
 * 返る「結果」を同じチェーンに流し、Mediator に裁定させる。
 *
 * テーマの選択そのものは設定の一部なので、ここではなく `settings/changed` で流す。
 * この機能が扱うのは、ユーザーのテーマファイルの読み込みと themes フォルダまわり、
 * それと設定ダイアログでの「試しに表示」（保存前に窓へ当ててみる）だけ。
 */

import type { ChainEvent } from '../../architecture/chain';
import type { ThemeDefinition } from '../../lib/theme/types';

/** 読み込めなかったテーマファイル 1 件。設定画面にファイル名と理由を並べる。 */
export interface ThemeFileError {
  readonly fileName: string;
  readonly error: string;
}

/** View から上がる操作。 */
export type ThemeIntent =
  /** テーマファイルを読み直してほしい（「再読み込み」ボタン、設定ダイアログを開いたとき） */
  | { readonly type: 'theme/reload-requested' }
  /** themes フォルダを Explorer で見たい */
  | { readonly type: 'theme/open-folder-requested' }
  /** 「Claude でテーマを作る」が押された */
  | { readonly type: 'theme/create-with-claude-requested' }
  /**
   * 設定ダイアログでテーマのカードが押された。保存する前に、そのテーマを窓に当ててみる。
   * 設定は変えない（確定は「保存」で `settings/changed` が担う）。
   */
  | { readonly type: 'theme/preview-requested'; readonly themeId: string }
  /** 試しに表示をやめて、窓を本来のテーマに戻す（保存・キャンセル・Esc・ダイアログを閉じたとき） */
  | { readonly type: 'theme/preview-ended' };

/** 副作用から返る結果。 */
export type ThemeOutcome = {
  readonly type: 'theme/loaded';
  /** 検証を通ったユーザーのテーマ（ファイル名順） */
  readonly themes: readonly ThemeDefinition[];
  /** 読めなかった・検証で弾いたファイル */
  readonly errors: readonly ThemeFileError[];
};

export type ThemeEvent = ThemeIntent | ThemeOutcome;

/** チェーンに流せる形であることを型で確かめておく (実行時のコードは生まない)。 */
type _AssertChainEvent = ThemeEvent extends ChainEvent ? true : never;
export type { _AssertChainEvent };
