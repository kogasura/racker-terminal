//! Claude Code のセッション情報を読み取る Tauri command。
//!
//! Claude Code は起動中のセッションごとに `~/.claude/sessions/<pid>.json` を書き出し、
//! セッション ID・作業ディレクトリ・実行状態をリアルタイムで更新している。
//! racker はこれを読むことで、
//!
//! 1. ユーザーが自分で `claude` と打って起動したタブの **セッション ID を特定**し、
//!    再起動後に `--resume` の対象にできる
//! 2. エージェントの状態を、画面出力の文字列パターンではなく
//!    **Claude 自身が申告した status** から判定できる
//!
//! ⚠️ このファイル形式は公式にドキュメント化された API ではなく内部実装である。
//! 形式が変わっても racker が壊れないよう、以下を徹底する:
//! - すべてのフィールドを `Option` にして、欠けていても読み飛ばす
//! - 壊れた JSON は握り潰し、他のセッションの読み取りを止めない
//! - 読めなかった場合は空 vec を返し、呼び出し側は従来の画面判定にフォールバックする

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Claude Code が `~/.claude/sessions/<pid>.json` に書き出すセッション情報。
///
/// `status` の値は Claude Code の実装上 `"busy"` / `"shell"` / `"idle"` / `"waiting"` の
/// 4 種類。ただし将来増えても壊れないよう、ここでは検証せず文字列のまま渡す
/// (解釈はフロント側の `claudeSessions.ts` が行う)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub pid: Option<u32>,
    pub session_id: Option<String>,
    /// 作業ディレクトリ。Windows 側は `C:\...`、WSL 側は `/home/...` 形式。
    pub cwd: Option<String>,
    /// `"busy"` / `"shell"` / `"idle"` / `"waiting"`
    pub status: Option<String>,
    /// `status == "waiting"` のときの理由 (`"input needed"` 等)。tooltip に出す。
    pub waiting_for: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    /// セッション名。racker が `-n` を付けて起動したタブではその名前が入る。
    pub name: Option<String>,
    /// Claude Code のバージョン。形式変更を検知したいときの手がかりとして返す。
    pub version: Option<String>,

    /// どこで見つけたセッションか。Windows 側は `None`、WSL 側は distro 名。
    ///
    /// **このフィールドだけは racker が付与する** (Claude は書かない)。
    /// cwd を Windows パスとして解釈するか Linux パスとして解釈するかの判別に使う。
    #[serde(default)]
    pub distro: Option<String>,
}

/// セッションディレクトリ 1 つぶんを読む。
///
/// ファイル名は `<pid>.json`。拡張子が `.json` でないものは無視する。
/// 壊れた JSON・読めないファイルは黙って飛ばす: 1 つの破損で
/// 他のセッションまで見失うほうが害が大きい。
pub fn read_sessions_dir(dir: &Path, distro: Option<&str>) -> Vec<ClaudeSession> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![]; // ディレクトリが無い = Claude を使っていない環境。エラーにしない
    };

    let mut out = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue; // 書き込み途中でロックされている等
        };
        let Ok(mut session) = serde_json::from_str::<ClaudeSession>(&text) else {
            continue; // 書き込み途中で JSON が壊れて見えることがある
        };
        session.distro = distro.map(|d| d.to_string());
        out.push(session);
    }
    out
}

/// WSL distro 内の `.claude/sessions` ディレクトリ候補を列挙する。
///
/// WSL のユーザー名は分からないため `\\wsl.localhost\<distro>\home` 配下を
/// 走査して、`.claude/sessions` を持つユーザーだけを拾う。root 直下も見る。
fn wsl_session_dirs(distro: &str) -> Vec<PathBuf> {
    let mut dirs = vec![];

    let home = PathBuf::from(format!(r"\\wsl.localhost\{distro}\home"));
    if let Ok(entries) = fs::read_dir(&home) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(".claude").join("sessions");
            if candidate.is_dir() {
                dirs.push(candidate);
            }
        }
    }

    let root = PathBuf::from(format!(r"\\wsl.localhost\{distro}\root\.claude\sessions"));
    if root.is_dir() {
        dirs.push(root);
    }

    dirs
}

/// 起動中の Claude Code セッション一覧を返す Tauri command。
///
/// `distros` には **実際に WSL タブが開いている distro だけ** を渡すこと。
/// `\\wsl.localhost\` へのアクセスは停止中の WSL を起動させてしまうため、
/// 使っていない distro まで走査すると、ポーリングのたびに WSL を起こすことになる。
///
/// 読み取りに失敗した環境は黙って飛ばし、取れたぶんだけを返す。
#[tauri::command]
pub fn list_claude_sessions(distros: Vec<String>) -> Vec<ClaudeSession> {
    let mut out = vec![];

    // Windows 側 (%USERPROFILE%\.claude\sessions)
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".claude").join("sessions");
        out.extend(read_sessions_dir(&dir, None));
    }

    // WSL 側 (\\wsl.localhost\<distro>\home\<user>\.claude\sessions)
    for distro in distros {
        for dir in wsl_session_dirs(&distro) {
            out.extend(read_sessions_dir(&dir, Some(&distro)));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// テスト用の一時ディレクトリを作る (std だけで完結させる)。
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("racker-claude-sessions-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, content: &str) {
        let mut f = fs::File::create(dir.join(name)).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    const FULL: &str = r#"{
        "pid": 61716,
        "sessionId": "5b4197e0-8a0a-4098-9eff-b08d08019585",
        "cwd": "C:\\Users\\me\\dev\\racker-terminal",
        "startedAt": 1785220794995,
        "version": "2.1.220",
        "kind": "interactive",
        "name": "racker-terminal-c1",
        "updatedAt": 1785220796758,
        "status": "waiting",
        "waitingFor": "input needed",
        "statusUpdatedAt": 1785220796758
    }"#;

    #[test]
    fn reads_full_session_file() {
        let dir = temp_dir("full");
        write_file(&dir, "61716.json", FULL);

        let sessions = read_sessions_dir(&dir, None);

        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.pid, Some(61716));
        assert_eq!(
            s.session_id.as_deref(),
            Some("5b4197e0-8a0a-4098-9eff-b08d08019585")
        );
        assert_eq!(s.cwd.as_deref(), Some(r"C:\Users\me\dev\racker-terminal"));
        assert_eq!(s.status.as_deref(), Some("waiting"));
        assert_eq!(s.waiting_for.as_deref(), Some("input needed"));
        assert_eq!(s.name.as_deref(), Some("racker-terminal-c1"));
        assert_eq!(s.version.as_deref(), Some("2.1.220"));
        assert_eq!(s.distro, None);
    }

    #[test]
    fn tags_distro_for_wsl_sessions() {
        let dir = temp_dir("distro");
        write_file(&dir, "42.json", FULL);

        let sessions = read_sessions_dir(&dir, Some("Ubuntu-22.04"));

        assert_eq!(sessions[0].distro.as_deref(), Some("Ubuntu-22.04"));
    }

    #[test]
    fn skips_broken_json_but_keeps_others() {
        let dir = temp_dir("broken");
        write_file(&dir, "1.json", "{ this is not json");
        write_file(&dir, "2.json", FULL);

        let sessions = read_sessions_dir(&dir, None);

        // 壊れた 1 件のせいで健全な 1 件まで失わないこと
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].pid, Some(61716));
    }

    #[test]
    fn ignores_non_json_files() {
        let dir = temp_dir("nonjson");
        write_file(&dir, "readme.txt", "hello");
        write_file(&dir, "3.json", FULL);

        assert_eq!(read_sessions_dir(&dir, None).len(), 1);
    }

    #[test]
    fn tolerates_missing_fields() {
        // 将来フィールドが削られても、取れるぶんだけ読めること
        let dir = temp_dir("partial");
        write_file(&dir, "9.json", r#"{"pid": 9, "cwd": "/home/me/dev"}"#);

        let sessions = read_sessions_dir(&dir, None);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].pid, Some(9));
        assert_eq!(sessions[0].session_id, None);
        assert_eq!(sessions[0].status, None);
    }

    #[test]
    fn tolerates_unknown_fields() {
        // 将来フィールドが増えてもパースが落ちないこと
        let dir = temp_dir("unknown");
        write_file(&dir, "9.json", r#"{"pid": 9, "brandNewField": {"a": 1}}"#);

        assert_eq!(read_sessions_dir(&dir, None).len(), 1);
    }

    #[test]
    fn missing_directory_returns_empty() {
        let dir = std::env::temp_dir().join("racker-claude-sessions-does-not-exist");
        let _ = fs::remove_dir_all(&dir);

        assert!(read_sessions_dir(&dir, None).is_empty());
    }
}
