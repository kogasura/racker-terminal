/**
 * themes フォルダ (`%APPDATA%\com.yokubo.racker\themes`) を扱う Rust command のラッパー。
 *
 * ファイルの中身の検証は持たない（src/lib/theme/parseTheme.ts の担当）。
 * どれも失敗したら空 / null / false を返す。テーマは付加機能なので、
 * 読めなくても組み込みテーマだけで動き続ければよい。
 *
 * @module themeFiles
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * themes フォルダ直下の *.json か *.svg 1 件。Rust 側の `UserThemeFile` に対応する。
 * 種類のフィールドは無いので、拡張子（大文字小文字を問わない）で見分ける。
 */
export interface UserThemeFile {
  /** 拡張子込みのファイル名（例: `sunset-neon.json`、`sunset-neon.svg`） */
  fileName: string;
  /** ファイルの中身。読めなかったときは null */
  content: string | null;
  /** 読めなかった理由（大きすぎる・読み取りエラーなど）。読めたときは null */
  error: string | null;
}

/** themes フォルダのテーマファイルを一覧する。取得に失敗したら空配列。 */
export async function listUserThemes(): Promise<UserThemeFile[]> {
  try {
    return (await invoke<UserThemeFile[] | null>('list_user_themes')) ?? [];
  } catch (e) {
    console.warn('[themeFiles] list_user_themes failed:', e);
    return [];
  }
}

/**
 * themes フォルダを用意し（説明書の CLAUDE.md も書き出す）、絶対パスを返す。
 * 用意できなかったら null。
 */
export async function ensureThemesDir(): Promise<string | null> {
  try {
    return (await invoke<string | null>('ensure_themes_dir')) ?? null;
  } catch (e) {
    console.warn('[themeFiles] ensure_themes_dir failed:', e);
    return null;
  }
}

/** themes フォルダを Explorer で開く。開けたら true。 */
export async function openThemesDir(): Promise<boolean> {
  try {
    return (await invoke<boolean | null>('open_themes_dir')) === true;
  } catch (e) {
    console.warn('[themeFiles] open_themes_dir failed:', e);
    return false;
  }
}
