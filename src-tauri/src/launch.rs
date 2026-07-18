//! Explorer「Racker Terminal で開く」から渡されるフォルダパスの取り出し。
//!
//! Windows のインストーラ (NSIS フック) が
//!   `"Racker Terminal.exe" "%V"`
//! というコンテキストメニューを登録する。`%V` は右クリックしたフォルダ
//! （またはフォルダ背景の場合は表示中フォルダ）のパスに展開され、
//! アプリの起動引数として渡される。
//!
//! - 初回起動時: フロントエンドが `get_launch_path` command で argv を取得して開く。
//! - 起動済みのとき: single-instance プラグインが 2 回目の argv を受け取り、
//!   `extract_dir_arg` で抽出したパスを `open-path` イベントで既存ウィンドウへ転送する。

use std::path::Path;

/// コンテキストメニュー経由の引数がフォルダパス候補かどうかを判定する純関数。
/// 空文字列とフラグ（`-` 始まり）を除外する。
fn is_path_candidate(arg: &str) -> bool {
    let t = arg.trim();
    !t.is_empty() && !t.starts_with('-')
}

/// argv からフォルダパス引数を抽出する。
/// - argv[0]（実行ファイル自身のパス）はスキップする
/// - フラグ / 空文字列は無視する
/// - 実在するディレクトリの最初の 1 件を返す（存在しないパスは無視）
pub fn extract_dir_arg(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .map(|s| s.trim())
        .filter(|s| is_path_candidate(s))
        .find(|s| Path::new(s).is_dir())
        .map(|s| s.to_string())
}

/// 起動時、自インスタンスの argv からフォルダパスを取り出して返す Tauri command。
/// Explorer から「Racker Terminal で開く」で起動された場合は対象フォルダを返す。
/// 通常起動（引数なし）や該当ディレクトリが無い場合は `None`。
#[tauri::command]
pub fn get_launch_path() -> Option<String> {
    let argv: Vec<String> = std::env::args().collect();
    extract_dir_arg(&argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_rejects_empty_and_flags() {
        assert!(!is_path_candidate(""));
        assert!(!is_path_candidate("   "));
        assert!(!is_path_candidate("--flag"));
        assert!(!is_path_candidate("-x"));
        assert!(is_path_candidate("C:\\Users"));
        assert!(is_path_candidate("/home/user"));
    }

    #[test]
    fn extract_returns_none_without_dir_arg() {
        let argv = vec!["racker.exe".to_string()];
        assert_eq!(extract_dir_arg(&argv), None);
    }

    #[test]
    fn extract_finds_existing_dir() {
        // temp_dir は常に存在するディレクトリなのでテストに使える
        let dir = std::env::temp_dir();
        let dir_str = dir.to_string_lossy().to_string();
        let argv = vec!["racker.exe".to_string(), dir_str.clone()];
        assert_eq!(extract_dir_arg(&argv), Some(dir_str));
    }

    #[test]
    fn extract_skips_flags_before_dir() {
        let dir = std::env::temp_dir();
        let dir_str = dir.to_string_lossy().to_string();
        let argv = vec![
            "racker.exe".to_string(),
            "--some-flag".to_string(),
            dir_str.clone(),
        ];
        assert_eq!(extract_dir_arg(&argv), Some(dir_str));
    }

    #[test]
    fn extract_ignores_nonexistent_path() {
        let argv = vec![
            "racker.exe".to_string(),
            "Z:\\definitely\\not\\here\\xyzzy".to_string(),
        ];
        assert_eq!(extract_dir_arg(&argv), None);
    }
}
