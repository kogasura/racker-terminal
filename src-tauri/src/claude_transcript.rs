//! Claude Code の会話ログ (transcript) から、いま使っているモデル・effort・
//! コンテキスト消費量を読み取る Tauri command。
//!
//! Claude Code はセッションごとに `~/.claude/projects/<slug>/<sessionId>.jsonl` を
//! 追記していく。各行のうち `type == "assistant"` の行には、その応答を生成した
//! モデル名・reasoning effort・トークン使用量が入っている。
//! **最後の assistant 行**を読めば「いまの状態」が分かる。
//!
//! ## 末尾だけを読む理由
//!
//! この JSONL は会話が伸びるほど大きくなり、実測で 50MB を超えるものがある。
//! 数秒ごとに全体を読むのは論外なので、**ファイル末尾から一定バイトだけ**を
//! 読んで後ろから走査する。見つからなければ読む範囲を広げ、上限で諦める。
//!
//! ## 注意
//!
//! ⚠️ このファイル形式は公式にドキュメント化された API ではなく内部実装である。
//! `claude_sessions.rs` と同じ方針で、**取れなければ `None`** を返し、
//! 呼び出し側は「表示しない」だけにする。エラーを UI まで持ち上げない。

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 最初に読む末尾のバイト数。
///
/// assistant 行 1 件は数 KB。ただし直後に巨大な tool_result (user 行) が
/// 積まれることがあるため、1 行ぶんでは足りない。128KB あれば通常は
/// 1 回の読み取りで最後の assistant 行に届く。
const INITIAL_TAIL_BYTES: u64 = 128 * 1024;

/// 読む範囲を広げるときの倍率と上限。
///
/// 巨大なファイル読み込み (画像添付・長大な tool_result) が末尾に連続すると
/// 128KB では届かない。段階的に広げるが、上限を置いて
/// 「毎回 50MB 読む」状態には決して陥らせない。
///
/// 上限を 2MB に抑えているのは、**見つからなかったときのコスト**が毎回かかるため。
/// 見つかる場合は 1 回目で返るので上限は効かないが、assistant 行が 1 つも無い
/// transcript (応答前に巨大な添付を貼った直後など) では毎回この上限まで読む。
/// 1 行は最大でも数百 KB なので、2MB あれば実際の取りこぼしは起きない。
const TAIL_GROWTH: u64 = 8;
const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// タブに表示するための transcript 由来のメタ情報。
///
/// すべて `Option`。形式が変わって読めなくなったフィールドは
/// 単に表示されなくなるだけで、他のフィールドの表示は生き残る。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMeta {
    /// `"claude-opus-5"` 等。表示名への変換はフロント側で行う。
    pub model: Option<String>,
    /// reasoning effort (`"low"` / `"medium"` / `"high"` / `"xhigh"` 等)。
    pub effort: Option<String>,
    /// いまのコンテキスト長 (トークン)。
    ///
    /// 直近の応答が受け取った入力の合計 = `input + cache_read + cache_creation`。
    /// output は次のターンで入力に載るので、ここには含めない。
    pub context_tokens: Option<u64>,
    /// その応答の timestamp (ISO8601)。鮮度の判断に使う。
    pub timestamp: Option<String>,
}

/// cwd を `~/.claude/projects/` 配下のディレクトリ名へ変換する。
///
/// Claude Code は英数字以外をすべて `-` に置き換えた文字列を使う:
/// - `C:\Users\me\dev\app`              → `C--Users-me-dev-app`
/// - `/home/me/dev/app`                 → `-home-me-dev-app`
/// - `\\wsl.localhost\Ubuntu-22.04\...` → `--wsl-localhost-Ubuntu-22-04-...`
pub fn slugify_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// transcript ファイルの場所を決める。
///
/// まず cwd から組み立てた slug で直接引き当てる (ディレクトリ走査なし)。
/// 見つからなければ projects 配下を 1 段だけ走査して同名の
/// `<sessionId>.jsonl` を探す。cwd の表記ゆれ (シンボリックリンク経由など) で
/// slug が一致しないことがあるためのフォールバック。
///
/// ⚠️ フォールバックの走査は呼び出し側で **ローカルディスクに限る**こと。
/// WSL 側 (`\\wsl.localhost\`) は 9P 越しで高く、毎回走査すると数秒かかる。
pub fn find_transcript(
    projects_dir: &Path,
    cwd: Option<&str>,
    session_id: &str,
    allow_scan: bool,
) -> Option<PathBuf> {
    let file_name = format!("{session_id}.jsonl");

    if let Some(cwd) = cwd {
        let direct = projects_dir.join(slugify_cwd(cwd)).join(&file_name);
        if direct.is_file() {
            return Some(direct);
        }
    }

    if !allow_scan {
        return None;
    }
    let entries = std::fs::read_dir(projects_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 1 行ぶんの JSON から assistant のメタ情報を取り出す。
///
/// 対象にしないもの:
/// - `type != "assistant"` の行 (user / attachment / mode など)
/// - `isSidechain == true` の行 — サブエージェント (Task) の応答。
///   これはメインの会話とは別のコンテキストなので、混ぜると値が飛ぶ
/// - `model == "<synthetic>"` の行 — API を経由しない合成メッセージで、
///   モデルも使用量も本物ではない
fn meta_from_line(line: &str) -> Option<TranscriptMeta> {
    // 巨大な tool_result を抱えた user 行 (数百 KB になる) を JSON へ起こすのは丸損。
    // `"assistant"` を含まない行は type が assistant になりようがないので、
    // 文字列検索で先に落とす。キー名の並びや空白の入り方に依存しないよう、
    // 値だけを見ている (形式が変わってもこの前提は崩れない)。
    if !line.contains("assistant") {
        return None;
    }

    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "assistant" {
        return None;
    }
    if v.get("isSidechain").and_then(serde_json::Value::as_bool) == Some(true) {
        return None;
    }

    let message = v.get("message")?;
    let model = message.get("model").and_then(|m| m.as_str());
    if model == Some("<synthetic>") {
        return None;
    }

    let usage = message.get("usage");
    let context_tokens = usage.map(|u| {
        let field = |name: &str| u.get(name).and_then(serde_json::Value::as_u64).unwrap_or(0);
        // output は次のターンの入力に載るので、いまのコンテキスト長には含めない
        field("input_tokens")
            + field("cache_read_input_tokens")
            + field("cache_creation_input_tokens")
    });

    Some(TranscriptMeta {
        model: model.map(str::to_string),
        effort: v.get("effort").and_then(|e| e.as_str()).map(str::to_string),
        context_tokens,
        timestamp: v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(str::to_string),
    })
}

/// テキスト断片を **後ろから** 走査して、最後の assistant 行のメタ情報を返す。
///
/// `partial_head` が true のとき、先頭行はファイルの途中から読み始めたことで
/// 切れている可能性があるため捨てる (壊れた JSON を無駄にパースしない)。
pub fn last_assistant_meta(chunk: &str, partial_head: bool) -> Option<TranscriptMeta> {
    let mut lines: Vec<&str> = chunk.lines().collect();
    if partial_head && !lines.is_empty() {
        lines.remove(0);
    }
    lines.iter().rev().find_map(|line| meta_from_line(line))
}

/// ファイル末尾から `bytes` バイトを読む。戻り値は (内容, 先頭行が欠けているか)。
fn read_tail(path: &Path, bytes: u64) -> Option<(String, bool)> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(bytes);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut buf = Vec::with_capacity(usize::try_from(len - start).unwrap_or(0));
    file.read_to_end(&mut buf).ok()?;

    // 途中から読み始めた場合、先頭が UTF-8 の文字の途中で切れている。
    // まず所有権を移すだけの変換を試し、失敗したときだけ複製する
    // (lossy は常にコピーを作るので、読み取ったバイト数ぶんメモリを二重に持つ)。
    // 壊れるのはどのみち捨てる先頭行だけなので、置換文字が入っても害はない。
    let text = String::from_utf8(buf)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Some((text, start > 0))
}

/// transcript から最後の assistant 行のメタ情報を読む。
///
/// 末尾 `INITIAL_TAIL_BYTES` から始め、見つからなければ範囲を広げる。
/// `MAX_TAIL_BYTES` まで広げても見つからなければ諦めて `None`。
pub fn read_transcript_meta(path: &Path) -> Option<TranscriptMeta> {
    let file_len = std::fs::metadata(path).ok()?.len();
    let mut window = INITIAL_TAIL_BYTES;

    loop {
        let (chunk, partial) = read_tail(path, window)?;
        if let Some(meta) = last_assistant_meta(&chunk, partial) {
            return Some(meta);
        }
        // ファイル全体を読み切ったなら、これ以上広げても同じ
        if window >= file_len || window >= MAX_TAIL_BYTES {
            return None;
        }
        // 上限で頭打ちにする。clamp しないと最後の 1 回だけ上限を大きく踏み越えて読む
        window = window.saturating_mul(TAIL_GROWTH).min(MAX_TAIL_BYTES);
    }
}

/// distro に対応する `.claude/projects` ディレクトリを返す。
///
/// `None` なら Windows 側のホーム、`Some(distro)` なら WSL 側を探す。
/// WSL のユーザー名は分からないため `home` 配下を走査して該当するものを拾う。
fn projects_dir(distro: Option<&str>) -> Option<PathBuf> {
    let Some(distro) = distro else {
        return dirs::home_dir().map(|h| h.join(".claude").join("projects"));
    };

    let home = PathBuf::from(format!(r"\\wsl.localhost\{distro}\home"));
    if let Ok(entries) = std::fs::read_dir(&home) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(".claude").join("projects");
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    let root = PathBuf::from(format!(r"\\wsl.localhost\{distro}\root\.claude\projects"));
    root.is_dir().then_some(root)
}

/// セッションの transcript からモデル・effort・コンテキスト量を読む Tauri command。
///
/// 読めない場合はすべて `None` を返す (Claude Code の形式変更・ファイル未生成・
/// セッション ID の取り違え)。呼び出し側は表示を消すだけにすること。
///
/// `(async)` は必須。WSL 側の transcript は `\\wsl.localhost\` 越しで、
/// 停止中の WSL では読み取りが数秒返らない。メインスレッドで動かすと
/// そのあいだウィンドウが固まる。
#[tauri::command(async)]
pub fn get_claude_transcript_meta(
    session_id: String,
    cwd: Option<String>,
    distro: Option<String>,
) -> Option<TranscriptMeta> {
    let dir = projects_dir(distro.as_deref())?;
    // WSL 側ではフォールバックの全走査をしない (9P 越しのディレクトリ走査は高い)
    let allow_scan = distro.is_none();
    let path = find_transcript(&dir, cwd.as_deref(), &session_id, allow_scan)?;
    read_transcript_meta(&path)
}

#[cfg(test)]
mod tests {
    // assert_eq! は展開すると if/else になるため、アサーションを並べただけの
    // テストでも認知的複雑度が嵩む。テストは分岐網羅のために意図的に分岐が
    // 多くなるので、TS 側で test を対象外にしているのと揃えて許容する。
    #![allow(clippy::cognitive_complexity)]

    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("racker-claude-transcript-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    /// 実物と同じ形の assistant 行を作る。
    fn assistant_line(model: &str, effort: &str, cache_read: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":false,"effort":"{effort}","timestamp":"2026-07-31T03:00:00.000Z","message":{{"model":"{model}","role":"assistant","usage":{{"input_tokens":2,"cache_creation_input_tokens":1000,"cache_read_input_tokens":{cache_read},"output_tokens":500}}}}}}"#
        )
    }

    #[test]
    fn slugifies_windows_path() {
        assert_eq!(
            slugify_cwd(r"C:\Users\me\dev\racker-terminal"),
            "C--Users-me-dev-racker-terminal"
        );
    }

    #[test]
    fn slugifies_linux_and_wsl_paths() {
        assert_eq!(slugify_cwd("/home/me/dev/app"), "-home-me-dev-app");
        assert_eq!(
            slugify_cwd(r"\\wsl.localhost\Ubuntu-22.04\home\me"),
            "--wsl-localhost-Ubuntu-22-04-home-me"
        );
    }

    #[test]
    fn reads_model_effort_and_context() {
        let meta = last_assistant_meta(&assistant_line("claude-opus-5", "high", 50_000), false)
            .expect("should parse");

        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(meta.effort.as_deref(), Some("high"));
        // input(2) + cache_creation(1000) + cache_read(50000)。output は含めない
        assert_eq!(meta.context_tokens, Some(51_002));
    }

    #[test]
    fn picks_the_last_assistant_line() {
        let chunk = format!(
            "{}\n{}\n{}\n",
            assistant_line("claude-sonnet-5", "low", 10),
            assistant_line("claude-opus-5", "high", 20),
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#
        );

        let meta = last_assistant_meta(&chunk, false).expect("should parse");

        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn skips_sidechain_lines() {
        // サブエージェントの応答は別コンテキスト。メインの値として拾ってはいけない
        let sidechain = assistant_line("claude-haiku-4-5", "low", 999)
            .replace(r#""isSidechain":false"#, r#""isSidechain":true"#);
        let chunk = format!(
            "{}\n{}\n",
            assistant_line("claude-opus-5", "high", 20),
            sidechain
        );

        let meta = last_assistant_meta(&chunk, false).expect("should parse");

        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn skips_synthetic_messages() {
        let synthetic = assistant_line("<synthetic>", "high", 0);
        let chunk = format!(
            "{}\n{}\n",
            assistant_line("claude-opus-5", "high", 20),
            synthetic
        );

        let meta = last_assistant_meta(&chunk, false).expect("should parse");

        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn skips_broken_lines() {
        // 書き込み途中の行が末尾に来ても、その手前まで遡って読めること
        let chunk = format!(
            "{}\n{{\"type\":\"assis",
            assistant_line("claude-opus-5", "high", 20)
        );

        assert!(last_assistant_meta(&chunk, false).is_some());
    }

    #[test]
    fn drops_partial_head_line() {
        // 途中から読み始めた 1 行目は捨てる。捨てた結果 assistant が無ければ None
        let chunk = assistant_line("claude-opus-5", "high", 20);

        assert!(last_assistant_meta(&chunk, true).is_none());
        assert!(last_assistant_meta(&chunk, false).is_some());
    }

    #[test]
    fn tolerates_missing_fields() {
        // 将来 effort や usage が消えても、取れるぶんだけ返すこと
        let chunk = r#"{"type":"assistant","message":{"model":"claude-opus-5"}}"#;

        let meta = last_assistant_meta(chunk, false).expect("should parse");

        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(meta.effort, None);
        assert_eq!(meta.context_tokens, None);
    }

    #[test]
    fn reads_tail_of_a_large_file() {
        // 末尾だけ読む経路が実ファイルで動くこと。
        // 目当ての行の前に INITIAL_TAIL_BYTES を超える詰め物を置く
        let dir = temp_dir("large");
        let path = dir.join("session.jsonl");
        let filler = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}}}}"#,
            "x".repeat(200 * 1024)
        );
        write_file(
            &path,
            &format!(
                "{}\n{}\n{}\n",
                filler,
                assistant_line("claude-opus-5", "high", 30_000),
                r#"{"type":"user","message":{"role":"user","content":"ok"}}"#
            ),
        );

        let meta = read_transcript_meta(&path).expect("should read");

        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(meta.context_tokens, Some(31_002));
    }

    #[test]
    fn widens_the_window_until_it_finds_one() {
        // assistant 行が初回の読み取り範囲より奥にある場合、範囲を広げて到達すること
        let dir = temp_dir("widen");
        let path = dir.join("session.jsonl");
        let filler = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}}}}"#,
            "y".repeat(300 * 1024)
        );
        write_file(
            &path,
            &format!(
                "{}\n{}\n",
                assistant_line("claude-opus-5", "high", 40_000),
                filler
            ),
        );

        let meta = read_transcript_meta(&path).expect("should read");

        assert_eq!(meta.context_tokens, Some(41_002));
    }

    #[test]
    fn missing_file_returns_none() {
        let dir = temp_dir("missing");

        assert!(read_transcript_meta(&dir.join("nope.jsonl")).is_none());
    }

    #[test]
    fn finds_transcript_by_slug() {
        let dir = temp_dir("find-slug");
        let path = dir.join("C--Users-me-dev-app").join("abc.jsonl");
        write_file(&path, "");

        let found = find_transcript(&dir, Some(r"C:\Users\me\dev\app"), "abc", false);

        assert_eq!(found.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn falls_back_to_scanning_when_slug_misses() {
        // cwd の表記ゆれで slug が合わないケース。走査が許可されていれば見つかる
        let dir = temp_dir("find-scan");
        let path = dir.join("some-other-slug").join("abc.jsonl");
        write_file(&path, "");

        assert_eq!(
            find_transcript(&dir, Some("/elsewhere"), "abc", true).as_deref(),
            Some(path.as_path())
        );
        assert!(find_transcript(&dir, Some("/elsewhere"), "abc", false).is_none());
    }

    #[test]
    fn find_transcript_returns_none_for_unknown_session() {
        let dir = temp_dir("find-none");
        write_file(&dir.join("slug").join("abc.jsonl"), "");

        assert!(find_transcript(&dir, None, "zzz", true).is_none());
    }
}
