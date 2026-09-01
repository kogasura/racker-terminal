//! ターミナル出力中の `file://` リンク (OSC 8 ハイパーリンク) を開く。
//!
//! ## 背景
//!
//! Claude Code は端末がハイパーリンク対応 (`FORCE_HYPERLINK=1`、pty.rs 参照) だと、
//! 画像やファイル参照を `file://` の OSC 8 リンクとして出力する。フロントエンドの
//! linkHandler (src/lib/linkHandler.ts) が Ctrl+クリックを受けて、この command に
//! URI を丸ごと渡してくる。
//!
//! ## セキュリティ境界はここ
//!
//! ターミナル出力は untrusted なので、任意の `file://` リンクを描かれうる。
//! フロントエンドの検証は防御の一層にすぎず、**開いてよいかの最終判断はこの
//! モジュールで行う**。方針:
//!
//! - **閲覧系の拡張子だけを既定アプリで開く** (allowlist 方式)。
//!   Windows の関連付けは `.js` → WSH、`.py` → Python ランチャのように
//!   「開く = 実行」になる拡張子があるため、blocklist では守り切れない。
//! - allowlist 外 (実行ファイル・スクリプト・ソースコード・拡張子なし) は
//!   実行の恐れがない **Explorer での場所表示** (reveal) に留める。
//! - スキームは `file:` のみ。パスに解決できない URI は拒否する。
//!
//! ## WSL タブのパス解決
//!
//! WSL 内の Claude Code は Linux パスの file URL (`file:///tmp/...`) を出す。
//! これ単体では Windows のパスに解決できないので、リンクをクリックしたタブが
//! WSL タブなら distro 名を受け取り、`\\wsl.localhost\<distro>\tmp\...` に
//! 組み立て直す。`/mnt/<drive>/...` は distro 抜きでドライブレターに変換できる
//! ため、そちらを優先する (9P 越しより速く、distro 不明でも開ける)。

use std::path::PathBuf;
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// 既定アプリで開いてよい拡張子 (ASCII 小文字で比較)。
///
/// 基準は「既定の関連付けがビューアであり、開いても実行にならないこと」。
/// ソースコード (.js .py .ts など) は Windows の関連付け次第で
/// インタープリタ実行になりうるため、意図的に含めない。
const OPEN_EXTENSIONS: &[&str] = &[
    // 画像
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "tiff", "tif",
    // 文書・データ (ビューア/エディタ/ブラウザで開く)
    "pdf", "txt", "md", "log", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "html", "htm",
    // メディア
    "mp4", "webm", "mp3", "wav",
];

/// URI から決めた開き方。
#[derive(Debug, PartialEq, Eq)]
pub enum FileLinkAction {
    /// 既定アプリで開く (allowlist の拡張子のみ)
    Open(PathBuf),
    /// Explorer で場所を表示する (それ以外すべて)
    Reveal(PathBuf),
}

impl FileLinkAction {
    fn path(&self) -> &PathBuf {
        match self {
            Self::Open(p) | Self::Reveal(p) => p,
        }
    }
}

/// WSL 由来の `file:///mnt/<drive>/...` をドライブレター形式の URL に書き換える。
///
/// WSL タブ内の Claude Code は Linux パスの file URL を出す。ドライブレターの無い
/// 絶対パスは Windows では解決できないが、`/mnt/c/...` 形式だけは `C:/...` に
/// 機械的に変換できる。セグメントは percent-encoding されたまま挿げ替えて
/// 再パースするので、日本語ファイル名などのデコードは `to_file_path` に任せる。
fn rewrite_wsl_mnt_url(url: &Url) -> Option<Url> {
    // host 付き (file://wsl.localhost/... 等) は UNC として解決できるので対象外
    if url.host().is_some() {
        return None;
    }
    let rest = url.path().strip_prefix("/mnt/")?;
    let (drive, tail) = rest.split_once('/')?;
    if drive.len() != 1 || !drive.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Url::parse(&format!("file:///{drive}:/{tail}")).ok()
}

/// distro 名として `\\wsl.localhost\<distro>\` に埋めてよい文字だけかを判定する。
///
/// 名前はタブの起動引数 (`-d <distro>`) 由来なので、URL 組み立ての前に絞る。
/// `/` や `%` を含む名前を通すと、組み立てた URL のパス構造が変わってしまう。
fn is_safe_distro_name(distro: &str) -> bool {
    !distro.is_empty()
        && distro
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// WSL タブが出した Linux 絶対パスの file URL を `\\wsl.localhost\<distro>\...` に
/// 対応する URL へ書き換える。
///
/// `/mnt/<drive>/...` は呼び出し前に `rewrite_wsl_mnt_url` で処理済みなので、
/// ここに来るのは distro 内の実パス (`/tmp/...`, `/home/...`) だけ。パスは
/// percent-encoding されたまま繋ぎ、デコードは `to_file_path` に任せる。
fn rewrite_wsl_linux_url(url: &Url, distro: &str) -> Option<Url> {
    // host 付き (file://wsl.localhost/... 等) は既に UNC として解決できる
    if url.host().is_some() {
        return None;
    }
    if !is_safe_distro_name(distro) {
        return None;
    }
    let path = url.path();
    if !path.starts_with('/') {
        return None;
    }
    Url::parse(&format!("file://wsl.localhost/{distro}{path}")).ok()
}

/// `file://` URI を検証し、パスと開き方を決める純関数。
///
/// `wsl_distro` は、リンクをクリックしたタブが WSL タブのときだけ `Some(distro)`。
/// Linux 絶対パス (`/tmp/...`) を `\\wsl.localhost\<distro>\...` に解決するのに使う。
///
/// 拒否するもの: file 以外のスキーム、Windows パスに解決できない URI
/// (distro が分からないまま渡された `file:///home/...` など)。
/// `file://wsl.localhost/<distro>/...` は UNC (`\\wsl.localhost\...`) に解決される。
pub fn classify_file_link(uri: &str, wsl_distro: Option<&str>) -> Result<FileLinkAction, String> {
    let url = Url::parse(uri).map_err(|e| format!("URI を解釈できません: {e}"))?;

    if url.scheme() != "file" {
        return Err(format!(
            "file: 以外のスキームは開けません: {}",
            url.scheme()
        ));
    }

    // /mnt/<drive>/... は distro を経由せずドライブレターへ (9P 越しより速い)
    let url = rewrite_wsl_mnt_url(&url).unwrap_or(url);

    // それでも解決できない Linux 絶対パスは、WSL タブなら distro 経由の UNC にする
    let url = match (url.to_file_path(), wsl_distro) {
        (Err(()), Some(distro)) => rewrite_wsl_linux_url(&url, distro).unwrap_or(url),
        _ => url,
    };

    let path = url.to_file_path().map_err(|()| {
        "Windows のパスとして解決できません (WSL タブ以外の Linux パスは開けません)".to_string()
    })?;

    let openable = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| OPEN_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));

    Ok(if openable {
        FileLinkAction::Open(path)
    } else {
        FileLinkAction::Reveal(path)
    })
}

/// ターミナル出力の `file://` リンクを開く Tauri command。
///
/// `wsl_distro` はリンクをクリックしたタブの素性:
/// - `None`: WSL タブではない (Windows 側のシェル)
/// - `Some("Ubuntu-24.04")`: その distro の WSL タブ
/// - `Some("")`: WSL タブだが `-d` 未指定 → 既定 distro を引いて解決する
///
/// 戻り値はフロントエンドのログ用: `"opened"` (既定アプリ) / `"revealed"` (Explorer)。
///
/// `(async)` 必須: 存在確認と ShellExecute があり、UNC パス (`\\wsl.localhost\...`)
/// では応答待ちでブロックしうる。既定 distro の解決で `wsl.exe` も起動する。
#[tauri::command(async)]
pub fn open_file_link(
    app: tauri::AppHandle,
    uri: String,
    wsl_distro: Option<String>,
) -> Result<String, String> {
    // 既定 distro の解決は wsl.exe の起動を伴うので、`-d` 未指定のときだけ行う
    let distro = match wsl_distro.as_deref().map(str::trim) {
        None => None,
        Some(d) if !d.is_empty() => Some(d.to_string()),
        Some(_) => crate::wsl::default_wsl_distro(),
    };

    let action = classify_file_link(&uri, distro.as_deref())?;
    let path = action.path();

    if !path.exists() {
        return Err(format!("ファイルが見つかりません: {}", path.display()));
    }

    match &action {
        // ディレクトリを指すリンクは拡張子なし → Reveal 側に落ちるので、
        // Open に来るのは実在する通常ファイルのみ (シンボリックリンク先を含む)。
        FileLinkAction::Open(p) if p.is_file() => {
            app.opener()
                .open_path(p.to_string_lossy(), None::<&str>)
                .map_err(|e| format!("開けませんでした: {e}"))?;
            Ok("opened".to_string())
        }
        // 拡張子は allowlist だが実体がファイルでない (ディレクトリ等) → 場所表示に格下げ
        FileLinkAction::Open(p) | FileLinkAction::Reveal(p) => {
            app.opener()
                .reveal_item_in_dir(p)
                .map_err(|e| format!("Explorer で表示できませんでした: {e}"))?;
            Ok("revealed".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WSL タブ以外 (Windows 側シェル) からのクリック
    fn classify(uri: &str) -> FileLinkAction {
        classify_file_link(uri, None).expect("有効な file URI は分類できること")
    }

    /// distro が分かっている WSL タブからのクリック
    fn classify_in_wsl(uri: &str, distro: &str) -> FileLinkAction {
        classify_file_link(uri, Some(distro)).expect("有効な file URI は分類できること")
    }

    #[test]
    fn image_and_document_extensions_open() {
        // Claude Code の [img] リンクの実体は画像ファイルへの file URL
        assert_eq!(
            classify("file:///C:/work/shot.png"),
            FileLinkAction::Open(PathBuf::from(r"C:\work\shot.png"))
        );
        assert_eq!(
            classify("file:///C:/docs/report.pdf"),
            FileLinkAction::Open(PathBuf::from(r"C:\docs\report.pdf"))
        );
        // 大文字拡張子も同じ扱い (Windows のファイル名は大小無区別)
        assert_eq!(
            classify("file:///C:/work/SHOT.PNG"),
            FileLinkAction::Open(PathBuf::from(r"C:\work\SHOT.PNG"))
        );
    }

    #[test]
    fn executable_and_source_extensions_reveal_only() {
        // 「開く = 実行」になりうる拡張子は既定アプリで開かない
        for uri in [
            "file:///C:/tmp/setup.exe",
            "file:///C:/tmp/run.bat",
            "file:///C:/tmp/script.ps1",
            "file:///C:/tmp/app.js", // WSH で実行されうる
            "file:///C:/tmp/tool.py",
        ] {
            assert!(
                matches!(classify(uri), FileLinkAction::Reveal(_)),
                "{uri} は Reveal になること"
            );
        }
    }

    #[test]
    fn no_extension_reveals() {
        // ディレクトリや拡張子なしファイルは場所表示に留める
        assert!(matches!(
            classify("file:///C:/work/project"),
            FileLinkAction::Reveal(_)
        ));
    }

    #[test]
    fn wsl_mnt_path_is_converted_to_drive_letter() {
        assert_eq!(
            classify("file:///mnt/c/Users/yuuki/shot.png"),
            FileLinkAction::Open(PathBuf::from(r"C:\Users\yuuki\shot.png"))
        );
    }

    #[test]
    fn wsl_localhost_host_becomes_unc() {
        // url crate は host 付き file URL を UNC に解決する
        assert_eq!(
            classify("file://wsl.localhost/Ubuntu/home/user/shot.png"),
            FileLinkAction::Open(PathBuf::from(r"\\wsl.localhost\Ubuntu\home\user\shot.png"))
        );
    }

    #[test]
    fn percent_encoded_names_are_decoded() {
        // 日本語ファイル名 (成果物.png を percent-encoding したもの)
        assert_eq!(
            classify("file:///C:/work/%E6%88%90%E6%9E%9C%E7%89%A9.png"),
            FileLinkAction::Open(PathBuf::from(r"C:\work\成果物.png"))
        );
    }

    #[test]
    fn linux_path_without_distro_is_rejected() {
        // WSL タブでなければ /home/... は解決先が無い
        assert!(classify_file_link("file:///home/user/shot.png", None).is_err());
    }

    #[test]
    fn linux_path_resolves_via_distro_in_wsl_tab() {
        // Claude Code が WSL 内の一時ディレクトリに書いた画像 (今回の主目的)
        assert_eq!(
            classify_in_wsl("file:///tmp/claude-1000/slide.001.png", "Ubuntu-24.04"),
            FileLinkAction::Open(PathBuf::from(
                r"\\wsl.localhost\Ubuntu-24.04\tmp\claude-1000\slide.001.png"
            ))
        );
        assert_eq!(
            classify_in_wsl("file:///home/user/report.pdf", "Ubuntu-22.04"),
            FileLinkAction::Open(PathBuf::from(
                r"\\wsl.localhost\Ubuntu-22.04\home\user\report.pdf"
            ))
        );
        // allowlist の判定は distro 経由でも変わらない
        assert!(matches!(
            classify_in_wsl("file:///home/user/setup.sh", "Ubuntu-24.04"),
            FileLinkAction::Reveal(_)
        ));
    }

    #[test]
    fn mnt_path_takes_precedence_over_distro() {
        // /mnt/c は Windows 側の実体。9P 越しより速いドライブレター変換を優先する
        assert_eq!(
            classify_in_wsl("file:///mnt/c/work/shot.png", "Ubuntu-24.04"),
            FileLinkAction::Open(PathBuf::from(r"C:\work\shot.png"))
        );
    }

    #[test]
    fn unsafe_distro_names_are_rejected() {
        // UNC の組み立てでパス構造を壊しうる名前は通さない (解決不能 → 拒否)
        for distro in ["../evil", "Ubuntu/../..", "a%2fb", r"a\b", ""] {
            assert!(
                classify_file_link("file:///tmp/shot.png", Some(distro)).is_err(),
                "distro={distro:?} は拒否されること"
            );
        }
    }

    #[test]
    fn non_file_schemes_are_rejected() {
        for uri in [
            "https://example.com/a.png",
            "javascript:alert(1)",
            "vbscript:x",
            "ftp://host/a.png",
        ] {
            assert!(
                classify_file_link(uri, None).is_err(),
                "{uri} は拒否されること"
            );
            // WSL タブでもスキームの判定は変わらない
            assert!(
                classify_file_link(uri, Some("Ubuntu-24.04")).is_err(),
                "{uri} は WSL タブでも拒否されること"
            );
        }
    }

    #[test]
    fn malformed_uri_is_rejected() {
        assert!(classify_file_link("not a uri", None).is_err());
        assert!(classify_file_link("", None).is_err());
    }

    #[test]
    fn mnt_rewrite_requires_single_drive_letter() {
        // /mnt/ 直下が 1 文字のドライブでなければ変換しない → 解決不能で拒否
        assert!(classify_file_link("file:///mnt/wsl/data.png", None).is_err());
        // WSL タブなら distro 経由で /mnt/wsl/... 自体を開ける
        assert_eq!(
            classify_in_wsl("file:///mnt/wsl/data.png", "Ubuntu-24.04"),
            FileLinkAction::Open(PathBuf::from(
                r"\\wsl.localhost\Ubuntu-24.04\mnt\wsl\data.png"
            ))
        );
    }
}
