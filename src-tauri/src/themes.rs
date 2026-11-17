//! ユーザーのテーマファイル（`<app_data>/themes/*.json`）を読む Tauri command。
//!
//! テーマは宣言的な JSON だけで、任意のコードは実行しない。ここでは
//! **ファイルを文字列として渡すだけ**で、JSON の中身の検証とベースのテーマとの
//! マージはフロント（`src/lib/theme/parseTheme.ts`）が行う。検証を 1 か所に
//! 寄せておくと、エラー文を設定画面にそのまま出せる。
//!
//! テーマフォルダには、形式の説明（`docs/themes.md`）を `CLAUDE.md` として
//! 書き出しておく。設定画面の「Claude でテーマを作る」はこのフォルダを cwd に
//! claude を開くので、claude は説明を自動で読んでからテーマを書ける。

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// 1 ファイルの上限 (バイト)。
///
/// テーマは数十個の色を並べるだけなので数 KiB で収まる。誤って巨大な
/// ファイルを置かれても、まるごとフロントへ送らないための上限。
const MAX_FILE_BYTES: u64 = 64 * 1024;

/// 読むファイル数の上限。超えたぶんはファイル名順で後ろから捨てる。
const MAX_FILES: usize = 100;

/// テーマフォルダに書き出す説明書のファイル名。
const GUIDE_FILE_NAME: &str = "CLAUDE.md";

/// 説明書の本文。リポジトリの `docs/themes.md` をそのまま埋め込む。
const GUIDE_BODY: &str = include_str!("../../docs/themes.md");

/// 説明書の先頭に付ける注意書き。毎回上書きするので、手で直しても消える。
const GUIDE_HEADER: &str =
    "<!-- このファイルは racker が読み込みのたびに上書きします。編集しないでください。 -->\n\n";

/// テーマフォルダの 1 ファイルぶんの読み取り結果。
///
/// `content` と `error` はどちらか一方だけが入る。読めなかったファイルも
/// 黙って捨てずに返すのは、「置いたのに選択肢に出ない」理由を設定画面に
/// 出すため。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserThemeFile {
    /// 拡張子込みのファイル名（例: `sunset-neon.json`）。ID はフロントが stem から作る。
    pub file_name: String,
    pub content: Option<String>,
    pub error: Option<String>,
}

/// テーマとして読む対象か（`.json` の通常ファイルか）。
fn is_theme_file(path: &Path) -> bool {
    let is_json = path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
    is_json && path.is_file()
}

/// 1 ファイルを上限付きで読む。失敗したら日本語の理由を返す。
///
/// 大きさは `metadata` ではなく実際に読んだ量で判定する。調べてから読むまでの
/// 間にファイルが伸びても、上限を超えて読み込まないため。
fn read_limited(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    let mut buf = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("ファイルを読めません: {e}"))?;
    if buf.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "ファイルが大きすぎます（上限は {} KiB）",
            MAX_FILE_BYTES / 1024
        ));
    }
    let text = String::from_utf8(buf)
        .map_err(|_| "UTF-8 のテキストとして読めません。UTF-8 で保存してください".to_string())?;
    // メモ帳などが付ける BOM は JSON.parse が受け付けないので外しておく
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

fn read_theme_file(path: &Path) -> UserThemeFile {
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match read_limited(path) {
        Ok(content) => UserThemeFile {
            file_name,
            content: Some(content),
            error: None,
        },
        Err(error) => UserThemeFile {
            file_name,
            content: None,
            error: Some(error),
        },
    }
}

/// テーマフォルダ直下の `*.json` を読む純関数。再帰はしない。
///
/// ファイル名順に並べ、先頭から `MAX_FILES` 件までを返す。
/// フォルダが無い・読めないときは空 vec（テーマを作っていない環境は普通にある）。
pub fn read_theme_files(dir: &Path) -> Vec<UserThemeFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_theme_file(path))
        .collect();
    // 同じフォルダ直下なので、パス順 = ファイル名順
    paths.sort();
    paths
        .iter()
        .take(MAX_FILES)
        .map(|path| read_theme_file(path))
        .collect()
}

/// 説明書（`CLAUDE.md`）をフォルダに書き出す。既にあっても上書きする。
///
/// racker を更新すると説明も変わりうるので、毎回最新の内容に揃える。
pub fn write_guide(dir: &Path) -> std::io::Result<()> {
    fs::write(
        dir.join(GUIDE_FILE_NAME),
        format!("{GUIDE_HEADER}{GUIDE_BODY}"),
    )
}

/// テーマフォルダ (`<app_data>/themes`) を用意して返す。
///
/// 説明書の書き出しに失敗してもフォルダは返す。説明書は claude 向けの
/// 付加物で、テーマの読み込みまで止める理由にはならない。
fn themes_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("themes");
    fs::create_dir_all(&dir).ok()?;
    if let Err(e) = write_guide(&dir) {
        eprintln!("[themes] {GUIDE_FILE_NAME} を書き出せませんでした: {e}");
    }
    Some(dir)
}

/// ユーザーのテーマファイルを読む。フォルダを用意できなければ空 vec。
///
/// `(async)` はファイル I/O の間ウィンドウを固めないため。
#[tauri::command(async)]
pub fn list_user_themes(app: AppHandle) -> Vec<UserThemeFile> {
    themes_dir(&app)
        .map(|dir| read_theme_files(&dir))
        .unwrap_or_default()
}

/// テーマフォルダを用意して、その絶対パスを返す。用意できなければ None。
///
/// 「Claude でテーマを作る」がこのパスを cwd に claude タブを開く。
#[tauri::command(async)]
pub fn ensure_themes_dir(app: AppHandle) -> Option<String> {
    themes_dir(&app).map(|dir| dir.to_string_lossy().into_owned())
}

/// テーマフォルダを用意して Explorer で開く。開けたら true。
///
/// フォルダ作成・説明書の書き出し・Explorer の起動を伴うので、他と同じく
/// `(async)` にする（command_audit.rs の決まり）。
#[tauri::command(async)]
pub fn open_themes_dir(app: AppHandle) -> bool {
    let Some(dir) = themes_dir(&app) else {
        return false;
    };
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .is_ok()
}

#[cfg(test)]
mod tests {
    // assert_eq! は展開すると分岐になり、認知的複雑度が嵩むため許容する
    // （claude_sessions.rs と同じ扱い）。
    #![allow(clippy::cognitive_complexity)]

    use super::*;

    /// テスト用の一時ディレクトリを作る (std だけで完結させる)。
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("racker-themes-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file_names(files: &[UserThemeFile]) -> Vec<&str> {
        files.iter().map(|f| f.file_name.as_str()).collect()
    }

    #[test]
    fn reads_json_files_as_text_without_validation() {
        let dir = temp_dir("read");
        fs::write(dir.join("ok.json"), r#"{"name":"OK"}"#).unwrap();
        // 中身の検証はフロントの担当。壊れた JSON もそのまま渡す
        fs::write(dir.join("broken.json"), "{ not json").unwrap();

        let files = read_theme_files(&dir);

        assert_eq!(
            files,
            vec![
                UserThemeFile {
                    file_name: "broken.json".into(),
                    content: Some("{ not json".into()),
                    error: None,
                },
                UserThemeFile {
                    file_name: "ok.json".into(),
                    content: Some(r#"{"name":"OK"}"#.into()),
                    error: None,
                },
            ]
        );
    }

    #[test]
    fn ignores_non_json_files_and_subdirectories() {
        let dir = temp_dir("nonjson");
        fs::write(dir.join("a.json"), "{}").unwrap();
        fs::write(dir.join("CLAUDE.md"), "guide").unwrap();
        fs::write(dir.join("notes.txt"), "memo").unwrap();
        fs::write(dir.join("json"), "{}").unwrap();
        // 拡張子が .json のフォルダと、その中のファイルも読まない（再帰しない）
        fs::create_dir_all(dir.join("dir.json")).unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("nested.json"), "{}").unwrap();

        assert_eq!(file_names(&read_theme_files(&dir)), vec!["a.json"]);
    }

    #[test]
    fn oversized_file_has_error_and_no_content() {
        let dir = temp_dir("oversized");
        let limit = usize::try_from(MAX_FILE_BYTES).unwrap();
        fs::write(dir.join("big.json"), "a".repeat(limit + 1)).unwrap();
        // ちょうど上限は読める
        fs::write(dir.join("edge.json"), "a".repeat(limit)).unwrap();

        let files = read_theme_files(&dir);

        assert_eq!(file_names(&files), vec!["big.json", "edge.json"]);
        assert_eq!(files[0].content, None);
        assert!(files[0].error.as_deref().unwrap().contains("大きすぎます"));
        assert_eq!(files[1].content.as_deref().map(str::len), Some(limit));
        assert_eq!(files[1].error, None);
    }

    #[test]
    fn non_utf8_file_has_error() {
        let dir = temp_dir("nonutf8");
        fs::write(dir.join("bad.json"), [0xff, 0xfe, 0x00]).unwrap();

        let files = read_theme_files(&dir);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].content, None);
        assert!(files[0].error.as_deref().unwrap().contains("UTF-8"));
    }

    #[test]
    fn strips_utf8_bom() {
        let dir = temp_dir("bom");
        fs::write(dir.join("bom.json"), "\u{feff}{\"name\":\"B\"}").unwrap();

        let files = read_theme_files(&dir);

        assert_eq!(files[0].content.as_deref(), Some("{\"name\":\"B\"}"));
    }

    #[test]
    fn missing_directory_returns_empty() {
        let dir = std::env::temp_dir().join("racker-themes-does-not-exist");
        let _ = fs::remove_dir_all(&dir);

        assert!(read_theme_files(&dir).is_empty());
    }

    #[test]
    fn returns_at_most_100_files() {
        let dir = temp_dir("limit");
        for i in 0..=MAX_FILES {
            fs::write(dir.join(format!("t{i:03}.json")), "{}").unwrap();
        }

        let files = read_theme_files(&dir);

        assert_eq!(files.len(), MAX_FILES);
        assert_eq!(files.first().unwrap().file_name, "t000.json");
        // 101 個目（t100.json）は返さない
        assert_eq!(files.last().unwrap().file_name, "t099.json");
    }

    #[test]
    fn sorted_by_file_name() {
        let dir = temp_dir("sorted");
        for name in ["nord-ish.json", "a-theme.json", "zen.json", "m.json"] {
            fs::write(dir.join(name), "{}").unwrap();
        }

        assert_eq!(
            file_names(&read_theme_files(&dir)),
            vec!["a-theme.json", "m.json", "nord-ish.json", "zen.json"]
        );
    }

    #[test]
    fn writes_guide_and_overwrites_existing_one() {
        let dir = temp_dir("guide");
        let path = dir.join("CLAUDE.md");
        fs::write(&path, "古い説明").unwrap();

        write_guide(&dir).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with(GUIDE_HEADER));
        assert!(text.ends_with(GUIDE_BODY));
        assert!(!text.contains("古い説明"));
    }
}
