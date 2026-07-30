mod claude_sessions;
mod git_pr;
mod launch;
mod pty;
mod scrollback;
mod wsl;

use pty::PtyManager;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
