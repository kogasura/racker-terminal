//! エクスプローラーの「クイックアクセス」に並ぶフォルダを取得する Tauri command。
//!
//! サイドバーの Quick Access セクションに出すために使う。クイックアクセスの中身
//! (ピン留め + よく使うフォルダ) はファイルではなくシェル名前空間にあり、
//! `Shell.Application` COM の `Namespace(...).Items()` で列挙できる。
//!
//! COM を Rust から直接叩かず PowerShell を 1 回起動しているのは、この用途の
//! ためだけに `windows` クレートの COM 機能を依存に足さないため。起動は 1 秒弱
//! かかるが、呼ぶのは起動時と手動の再読み込みだけで、`(async)` なので画面は止まらない。

use serde::Serialize;

use crate::proc::hidden_command;

/// クイックアクセスの 1 行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuickAccessFolder {
    /// エクスプローラーに出ている表示名。
    pub name: String,
    /// フォルダの Windows パス (WSL のフォルダは `\\wsl.localhost\<distro>\...`)。
    pub path: String,
}

/// クイックアクセスのフォルダを `表示名<TAB>パス` の行で出力するスクリプト。
///
/// - 名前空間の GUID はクイックアクセス (Windows 11 の「ホーム」) のもの。
/// - 「最近使用したファイル」も同じ名前空間に混ざるため `IsFolder` で落とす。
/// - `IsFileSystem` でパスを持たない仮想フォルダを落とす。
/// - 既定の出力はコードページ依存なので UTF-8 に固定する (日本語のフォルダ名)。
const LIST_SCRIPT: &str = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$ns = (New-Object -ComObject Shell.Application).Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}'); \
if ($ns) { foreach ($i in $ns.Items()) { if ($i.IsFolder -and $i.IsFileSystem) { \"$($i.Name)`t$($i.Path)\" } } }";

/// シェルが「フォルダ」として扱う圧縮ファイルか。作業ディレクトリにはできない。
fn is_archive(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".zip") || lower.ends_with(".cab")
}

/// スクリプトの出力をパースする純関数。
///
/// 形の崩れた行・圧縮ファイル・同じパスの重複は捨てる。並び順はエクスプローラーの
/// 表示順のまま。存在確認はしない (ネットワークドライブや停止中の WSL を起こさないため)。
pub fn parse_quick_access_output(stdout: &str) -> Vec<QuickAccessFolder> {
    let mut out: Vec<QuickAccessFolder> = vec![];
    for line in stdout.lines() {
        let Some((name, path)) = line.trim_end_matches('\r').split_once('\t') else {
            continue;
        };
        let (name, path) = (name.trim(), path.trim());
        if name.is_empty() || path.is_empty() || is_archive(path) {
            continue;
        }
        if out.iter().any(|f| f.path.eq_ignore_ascii_case(path)) {
            continue;
        }
        out.push(QuickAccessFolder {
            name: name.to_string(),
            path: path.to_string(),
        });
    }
    out
}

/// クイックアクセスのフォルダ一覧を返す Tauri command。
///
/// 取得できなければ **空 vec を返す** (エラーにしない)。サイドバーの補助的な一覧で、
/// 取れないときはセクションごと出さなければ済むため。
#[tauri::command(async)]
pub fn list_quick_access() -> Vec<QuickAccessFolder> {
    let Ok(output) = hidden_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT])
        .output()
    else {
        return vec![];
    };
    if !output.status.success() {
        return vec![];
    }
    parse_quick_access_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, path: &str) -> QuickAccessFolder {
        QuickAccessFolder {
            name: name.to_string(),
            path: path.to_string(),
        }
    }

    /// スクリプトが出す 1 行 (`表示名<TAB>パス<CRLF>`)。
    /// パスは raw 文字列で渡す (バックスラッシュの数え間違いを避けるため)。
    fn line(name: &str, path: &str) -> String {
        format!("{name}\t{path}\r\n")
    }

    #[test]
    fn parse_typical_output() {
        let wsl = r"\\wsl.localhost\Ubuntu-22.04\home\me\jdf-dev";
        let out = [
            line("Desktop", r"C:\Users\me\Desktop"),
            line("jdf-dev", wsl),
            line("整理済み", r"C:\work\整理済み"),
        ]
        .concat();
        assert_eq!(
            parse_quick_access_output(&out),
            vec![
                folder("Desktop", r"C:\Users\me\Desktop"),
                folder("jdf-dev", wsl),
                folder("整理済み", r"C:\work\整理済み"),
            ]
        );
    }

    #[test]
    fn parse_skips_malformed_and_empty_lines() {
        let out = [
            "\r\n".to_string(),
            "タブ無しの行\r\n".to_string(),
            line("", r"C:\no-name"),
            line("no-path", ""),
            line("ok", r"C:\ok"),
        ]
        .concat();
        assert_eq!(
            parse_quick_access_output(&out),
            vec![folder("ok", r"C:\ok")]
        );
        assert_eq!(parse_quick_access_output(""), vec![]);
    }

    #[test]
    fn parse_skips_archives() {
        // シェルは zip を「フォルダ」として返すが、作業ディレクトリにはできない
        let out = [line("data", r"C:\dl\data.ZIP"), line("src", r"C:\dl\src")].concat();
        assert_eq!(
            parse_quick_access_output(&out),
            vec![folder("src", r"C:\dl\src")]
        );
    }

    #[test]
    fn parse_dedupes_same_path() {
        // ピン留めと「よく使うフォルダ」の両方に同じものが出ることがある
        let out = [line("dev", r"C:\dev"), line("dev", r"c:\DEV")].concat();
        assert_eq!(
            parse_quick_access_output(&out),
            vec![folder("dev", r"C:\dev")]
        );
    }
}
