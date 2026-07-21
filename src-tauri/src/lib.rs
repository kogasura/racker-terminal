mod launch;
mod pty;
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
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            wsl::list_wsl_distros,
            launch::get_launch_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
