//! タブの作業ディレクトリから git ブランチと GitHub PR の状態を取得する Tauri command。
//!
//! Claude Code on the web はセッションに紐づく PR の作成・マージ状況を追跡している
//! (セッションメタデータに `prUrl` / `prNumber` / `prRepository` を持つ)。
//! racker はローカルアプリなので、同じことを **作業ディレクトリのブランチから引く** 形で行う。
//!
//! 設計方針:
//! - `git` も `gh` も無い環境が普通にあるので、**失敗はすべて `None`** にして
//!   「PR 情報が無い」として扱う。エラーを UI まで持ち上げない
//! - PR が存在しないブランチでも `gh` は非ゼロで終了するため、これも `None` 扱い
//! - WSL タブ (Linux パスの cwd) は対象外。Windows の git からは辿れないため、
//!   呼び出し側で Windows パスのタブだけを対象にする

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// `gh pr view --json ...` の出力。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrView {
    number: Option<u64>,
    /// `"OPEN"` / `"MERGED"` / `"CLOSED"`
    state: Option<String>,
    url: Option<String>,
    is_draft: Option<bool>,
}

/// タブに表示するための PR 情報。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    /// 現在のブランチ名。PR が無くてもブランチだけは返す
    pub branch: String,
    pub number: Option<u64>,
    /// `"OPEN"` / `"MERGED"` / `"CLOSED"`
    pub state: Option<String>,
    pub url: Option<String>,
    pub is_draft: Option<bool>,
}

/// `git rev-parse --abbrev-ref HEAD` の出力からブランチ名を取り出す純関数。
///
/// - 前後の空白と改行を落とす
/// - **detached HEAD** のときは `"HEAD"` が返るので、ブランチ無しとして `None` にする
///   (PR を引く手がかりにならないため)
pub fn parse_branch_output(stdout: &str) -> Option<String> {
    let s = stdout.trim();
    if s.is_empty() || s == "HEAD" {
        return None;
    }
    Some(s.to_string())
}

/// 作業ディレクトリの現在のブランチ名を返す。git リポジトリでなければ `None`。
fn current_branch(cwd: &Path) -> Option<String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None; // git が無い / リポジトリでない
    }
    parse_branch_output(&String::from_utf8_lossy(&output.stdout))
}

/// 指定ブランチの PR を `gh` で引く。PR が無い場合も `None`。
fn pr_for_branch(cwd: &Path, branch: &str) -> Option<GhPrView> {
    let output = Command::new("gh")
        .current_dir(cwd)
        .args(["pr", "view", branch, "--json", "number,state,url,isDraft"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None; // gh が無い / 未認証 / PR が存在しない
    }
    serde_json::from_slice::<GhPrView>(&output.stdout).ok()
}

/// 作業ディレクトリのブランチと PR 状態を返す Tauri command。
///
/// git リポジトリでない場合は `None`。リポジトリだが PR が無い場合は
/// ブランチ名だけが入った `PrInfo` を返す（「PR 未作成」と「リポジトリ外」を
/// 呼び出し側が区別できるようにするため）。
///
/// `(async)` は必須。これが無いとメインスレッドで実行され、`gh` のネットワーク
/// 往復（数百 ms〜数秒）の間ウィンドウが固まる。30 秒ごとに cwd の数だけ呼ばれる。
#[tauri::command(async)]
pub fn get_pr_status(cwd: String) -> Option<PrInfo> {
    let path = Path::new(&cwd);
    if !path.is_dir() {
        return None;
    }

    let branch = current_branch(path)?;
    let pr = pr_for_branch(path, &branch);

    Some(PrInfo {
        branch,
        number: pr.as_ref().and_then(|p| p.number),
        state: pr.as_ref().and_then(|p| p.state.clone()),
        url: pr.as_ref().and_then(|p| p.url.clone()),
        is_draft: pr.as_ref().and_then(|p| p.is_draft),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_normal_branch_name() {
        assert_eq!(parse_branch_output("main\n"), Some("main".to_string()));
        assert_eq!(
            parse_branch_output("feat/tab-insights\r\n"),
            Some("feat/tab-insights".to_string())
        );
    }

    #[test]
    fn detached_head_is_none() {
        // detached HEAD では PR を引く手がかりにならない
        assert_eq!(parse_branch_output("HEAD\n"), None);
    }

    #[test]
    fn empty_output_is_none() {
        assert_eq!(parse_branch_output(""), None);
        assert_eq!(parse_branch_output("   \n"), None);
    }

    #[test]
    fn missing_directory_returns_none() {
        let result = get_pr_status("Z:\\definitely\\not\\a\\real\\path".to_string());
        assert!(result.is_none());
    }

    #[test]
    fn deserializes_gh_output() {
        let json = r#"{"number":63,"state":"MERGED","url":"https://github.com/o/r/pull/63","isDraft":false}"#;
        let pr: GhPrView = serde_json::from_str(json).unwrap();
        assert_eq!(pr.number, Some(63));
        assert_eq!(pr.state.as_deref(), Some("MERGED"));
        assert_eq!(pr.is_draft, Some(false));
    }

    #[test]
    fn tolerates_missing_gh_fields() {
        // gh の出力形式が変わってフィールドが欠けても落ちない
        let pr: GhPrView = serde_json::from_str(r#"{"number":1}"#).unwrap();
        assert_eq!(pr.number, Some(1));
        assert_eq!(pr.state, None);
    }
}
