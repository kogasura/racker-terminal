// 本番コードでの unwrap / expect を禁じる。
//
// このアプリはユーザーの作業中ずっと居座る常駐アプリで、パニックはその場で
// 全タブを道連れにする。Result を握り潰して落ちるより、エラーとして扱って
// 動き続けるほうが常に良い。
//
// テストでは unwrap / expect は普通に使うので、cfg(test) では外している
// (テスト側で握り潰すと、失敗の原因が分からなくなるだけで益がない)。
// これにより `cargo clippy --all-targets` でも本番コードだけが検査される。
#![cfg_attr(not(test), warn(clippy::unwrap_used, clippy::expect_used))]

mod claude_sessions;
mod command_audit;
mod git_pr;
mod launch;
mod pty;
mod scrollback;
mod wsl;

use pty::PtyManager;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ここだけは expect を許す。アプリの起動そのものに失敗した場合、
// ウィンドウも PTY もまだ無く、ユーザーに知らせる手段も継続する状態も無い。
// 黙って終了するより、パニックさせてメッセージを残すほうが調査できる。
#[allow(clippy::expect_used, reason = "起動失敗は継続不能。落として原因を残す")]
pub fn run() {
    tauri::Builder::default()
        // single-instance は他プラグインより先に登録する（プラグイン仕様）。
        // Explorer「Racker Terminal で開く」で 2 回目以降に起動されたときは、
        // 新しいプロセスを立ち上げず既存ウィンドウへ argv のフォルダパスを転送する。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = launch::extract_dir_arg(&argv) {
                let _ = app.emit("open-path", path);
            }
            // 既存ウィンドウを前面に出してユーザーが操作できるようにする。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_set_read_paused,
            wsl::list_wsl_distros,
            launch::get_launch_path,
            claude_sessions::list_claude_sessions,
            git_pr::get_pr_status,
            scrollback::save_scrollback,
            scrollback::load_scrollback,
            scrollback::delete_scrollback,
            scrollback::prune_scrollback,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // 終了時、進行中の PTY 後始末が捌けるのを少しだけ待つ。
            //
            // 後始末は別スレッドで走らせている（メインスレッドを止めないため）。
            // 捌けたものは ConPTY のホストプロセスまで畳んでくれるので、その分だけ
            // 終了が綺麗になる。成功する後始末は実測 60〜250ms 程度で終わる。
            //
            // 上限を 500ms と短くしているのは、ConPTY の ClosePseudoConsole が
            // 返ってこないケースがあるため。待ち切れなかったぶんはプロセス終了時に
            // OS が回収するので、ここで粘る意味はない。
            if matches!(event, tauri::RunEvent::Exit) {
                pty::wait_for_reapers(std::time::Duration::from_millis(500));
            }
        });
}
