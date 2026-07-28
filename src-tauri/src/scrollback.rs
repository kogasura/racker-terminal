//! タブごとの画面内容を保存・復元する Tauri command。
//!
//! PTY のスクロールバックはプロセスと一蓮托生で、アプリを再起動すると失われる。
//! 「再起動したらタブは戻るが中身は空」という状態を避けるため、xterm 側で
//! シリアライズした画面内容をファイルに保存しておき、復元時に書き戻す。
//!
//! **localStorage ではなくファイルに置く理由:** localStorage は 5〜10MB 程度の
//! 制限があり、タブ数ぶんの画面内容を入れると容易に溢れる。溢れると
//! タブ構成やお気に入りといった本来の永続化まで巻き添えで失敗する。

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 1 タブあたりの保存上限 (バイト)。
///
/// 復元は「直前の作業が見える」ことが目的なので、履歴全部を持つ必要はない。
/// 上限を超えたぶんは **古い側を捨てる**（新しい出力のほうが価値が高い）。
const MAX_BYTES: usize = 256 * 1024;

/// タブ ID がファイル名として安全かを検証する純関数。
///
/// タブ ID をそのままファイル名に使うため、`..` や区切り文字が混ざると
/// 保存先ディレクトリの外へ書き込めてしまう。ID は nanoid 生成
/// (`A-Za-z0-9_-`) なので、その文字種だけを許可すれば十分。
pub fn is_safe_tab_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 保存上限に収まるよう、**末尾**から `MAX_BYTES` ぶんを残して切り詰める純関数。
///
/// UTF-8 の途中で切ると壊れた文字列になるため、文字境界まで戻して切る。
/// 端末のエスケープシーケンスも途中で切れるが、xterm は不完全なシーケンスを
/// 読み飛ばすので表示が壊れることはない。
pub fn truncate_from_end(content: &str, max_bytes: usize) -> &str {
    if content.len() <= max_bytes {
        return content;
    }
    let start = content.len() - max_bytes;
    // start が文字境界に乗るまで前へ進める
    let mut idx = start;
    while idx < content.len() && !content.is_char_boundary(idx) {
        idx += 1;
    }
    &content[idx..]
}

/// 保存先ディレクトリ (`<app_data>/scrollback`) を用意して返す。
fn scrollback_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("scrollback");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn scrollback_path(app: &AppHandle, tab_id: &str) -> Option<PathBuf> {
    if !is_safe_tab_id(tab_id) {
        return None;
    }
    Some(scrollback_dir(app)?.join(format!("{tab_id}.txt")))
}

/// タブの画面内容を保存する。成功したら true。
///
/// 失敗しても false を返すだけでエラーにしない。scrollback の保存は
/// 付加機能であり、失敗がターミナルの動作に影響してはいけない。
#[tauri::command]
pub fn save_scrollback(app: AppHandle, tab_id: String, content: String) -> bool {
    let Some(path) = scrollback_path(&app, &tab_id) else {
        return false;
    };
    fs::write(path, truncate_from_end(&content, MAX_BYTES)).is_ok()
}

/// 保存された画面内容を読み出す。無い / 読めない場合は None。
#[tauri::command]
pub fn load_scrollback(app: AppHandle, tab_id: String) -> Option<String> {
    let path = scrollback_path(&app, &tab_id)?;
    fs::read_to_string(path).ok()
}

/// タブを閉じたときに保存内容を捨てる。
#[tauri::command]
pub fn delete_scrollback(app: AppHandle, tab_id: String) -> bool {
    let Some(path) = scrollback_path(&app, &tab_id) else {
        return false;
    };
    fs::remove_file(path).is_ok()
}

/// 現存しないタブの保存ファイルを掃除して、削除した件数を返す。
///
/// クラッシュ等で `delete_scrollback` を呼べなかったぶんが残り続けるため、
/// 起動時に一度まとめて片付ける。
#[tauri::command]
pub fn prune_scrollback(app: AppHandle, keep_tab_ids: Vec<String>) -> u32 {
    let Some(dir) = scrollback_dir(&app) else {
        return 0;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return 0;
    };

    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("txt") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if keep_tab_ids.iter().any(|id| id == stem) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_nanoid_style_ids() {
        assert!(is_safe_tab_id("V1StGXR8_Z5jdHi6B-myT"));
        assert!(is_safe_tab_id("abc123"));
    }

    #[test]
    fn rejects_path_traversal() {
        // ファイル名に使うため、区切り文字や .. を含む ID は弾く
        assert!(!is_safe_tab_id(".."));
        assert!(!is_safe_tab_id("../../etc/passwd"));
        assert!(!is_safe_tab_id("a/b"));
        assert!(!is_safe_tab_id("a\\b"));
        assert!(!is_safe_tab_id("a.txt"));
    }

    #[test]
    fn rejects_empty_and_overlong_ids() {
        assert!(!is_safe_tab_id(""));
        assert!(!is_safe_tab_id(&"a".repeat(65)));
    }

    #[test]
    fn keeps_content_under_limit_untouched() {
        assert_eq!(truncate_from_end("hello", 100), "hello");
    }

    #[test]
    fn truncates_keeping_the_newest_part() {
        // 古い側を捨てて新しい側を残す
        assert_eq!(truncate_from_end("abcdefghij", 4), "ghij");
    }

    #[test]
    fn truncation_does_not_split_utf8() {
        // 「あいうえお」は 1 文字 3 バイト。境界をまたぐ位置で切っても壊れない
        let s = "あいうえお";
        let out = truncate_from_end(s, 7);
        assert!(out.chars().count() > 0);
        assert!(s.ends_with(out));
        // 文字列として有効であること（&str なので不正 UTF-8 なら構築時点で壊れる）
        assert_eq!(out, "えお");
    }
}
