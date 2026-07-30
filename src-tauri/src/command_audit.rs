//! Tauri command の定義そのものを検査するテスト。
//!
//! ## なぜソースを読むテストが要るのか
//!
//! Tauri v2 では `async` の付かない command は**メインスレッド**で実行される。
//! メインスレッドは Windows のメッセージループそのものなので、そこでブロックしうる
//! 処理を行うと、その間ウィンドウは描画も入力受付もできない。数秒続けば OS に
//! 「応答なし」と判定され、アプリごと強制終了される。
//!
//! v1.8.1 までは全 command が同期で、実際にこれが起きていた
//! (Windows イベントログ: AppHang XProcB1 / 相手プロセス OpenConsole.exe)。
//!
//! この事故は「`#[tauri::command]` と書いた」だけで起きる。型は合うしテストも通る。
//! コンパイラも clippy も何も言わない。**書き忘れを検出できるのは、定義の書き方を
//! 直接見にいくテストだけ**なので、ここでソースを走査している。
//!
//! ## 追加するときは
//!
//! 新しい command は原則 `#[tauri::command(async)]` にすること。
//! 「一瞬で終わるから同期でいい」と判断したものだけ `SYNC_ALLOWLIST` に、
//! **なぜブロックしないと言えるのか**を添えて登録する。

#![cfg(test)]

use std::path::Path;

/// 同期 (`#[tauri::command]`) のままでよいと判断した command。
///
/// 登録には「メインスレッドを止めない」と言い切れる根拠が要る。
/// ファイル I/O・プロセス起動・ネットワーク・ロック待ちのいずれかを含むなら、
/// それは同期のままにしてよい理由にならない。
const SYNC_ALLOWLIST: &[(&str, &str)] = &[
    // 現時点では全 command が (async)。ここは空でよい。
];

/// `src/` 配下の .rs を列挙する。
fn source_files() -> Vec<std::path::PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = vec![];
    let entries = std::fs::read_dir(&dir).expect("src ディレクトリを読めること");
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
    out.sort();
    assert!(!out.is_empty(), "src 配下に .rs が 1 つも見つからない");
    out
}

/// `#[tauri::command]` 属性の直後に来る関数名を拾う。
///
/// 属性と `pub fn` の間に `#[allow(...)]` 等が挟まることがあるので、
/// 属性を見つけたら次の `fn` 行まで読み進める。
fn bare_sync_commands(source: &str) -> Vec<String> {
    let lines: Vec<&str> = source.lines().collect();
    let mut found = vec![];

    for (i, line) in lines.iter().enumerate() {
        // `(async)` が付いていれば対象外。属性の書き方の揺れ (空白) も吸収する。
        let trimmed = line.trim();
        if trimmed.replace(' ', "") != "#[tauri::command]" {
            continue;
        }

        // 次に現れる `fn` から関数名を取り出す
        let name = lines[i + 1..]
            .iter()
            .find_map(|l| l.split("fn ").nth(1))
            .and_then(|rest| rest.split('(').next())
            .map(|n| n.trim().to_string())
            .unwrap_or_else(|| format!("<{}行目の直後に fn が見つからない>", i + 1));
        found.push(name);
    }
    found
}

#[test]
fn all_tauri_commands_are_async() {
    let mut offenders = vec![];

    for path in source_files() {
        let source = std::fs::read_to_string(&path).expect("ソースを読めること");
        let file = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
            .to_string();

        for name in bare_sync_commands(&source) {
            if SYNC_ALLOWLIST.iter().any(|(f, n)| *f == file && *n == name) {
                continue;
            }
            offenders.push(format!("{file}::{name}"));
        }
    }

    assert!(
        offenders.is_empty(),
        "同期のままの Tauri command がある: {offenders:?}\n\
         \n\
         async の付かない command は Tauri v2 ではメインスレッド (Windows の\n\
         メッセージループ) で実行される。ブロックする処理が入ると、その間\n\
         ウィンドウが固まり、数秒続けば OS に強制終了される。\n\
         \n\
         `#[tauri::command(async)]` にすること。同期で問題ないと判断した場合のみ、\n\
         根拠を添えて command_audit.rs の SYNC_ALLOWLIST に登録する。"
    );
}

#[test]
fn detects_a_bare_sync_command() {
    // 検出ロジック自体が働いていることの確認。
    // これが壊れると all_tauri_commands_are_async が「常に通る」テストになる。
    let source = "#[tauri::command]\npub fn dangerous_one(x: u8) -> u8 { x }\n";
    assert_eq!(
        bare_sync_commands(source),
        vec!["dangerous_one".to_string()]
    );
}

#[test]
fn ignores_async_commands() {
    let source = "#[tauri::command(async)]\npub fn safe_one(x: u8) -> u8 { x }\n";
    assert!(bare_sync_commands(source).is_empty());
}

#[test]
fn looks_past_attributes_between_command_and_fn() {
    // #[allow(...)] 等が挟まっても関数名を取り違えないこと
    let source =
        "#[tauri::command]\n#[allow(clippy::too_many_arguments)]\npub fn spaced_out() {}\n";
    assert_eq!(bare_sync_commands(source), vec!["spaced_out".to_string()]);
}

#[test]
fn scans_every_command_bearing_file() {
    // 走査対象が実際に command を含んでいること。
    // ファイル列挙が壊れて 0 件になっても上のテストは通ってしまうため、
    // 「ちゃんと本物のソースを見ている」ことを別途担保する。
    let total: usize = source_files()
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.matches("#[tauri::command").count())
        .sum();

    assert!(
        total >= 13,
        "走査できた command が {total} 件しかない。ファイル列挙が壊れている可能性がある"
    );
}
