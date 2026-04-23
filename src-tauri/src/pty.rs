use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use parking_lot::{Mutex, RwLock};
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::ipc::Channel;
use thiserror::Error;
use uuid::Uuid;

// ─── IPC イベント ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { text: String },
    Exit { code: Option<i32> },
    Error { message: String },
}

// ─── エラー型 ────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("Shell not found: {0}")]
    ShellNotFound(String),

    #[error("Session not found: {id}")]
    SessionNotFound { id: String },

    #[error("PTY open failed: {0}")]
    PtyOpen(String),

    #[error("Spawn failed: {0}")]
    Spawn(String),

    #[error("Write failed: {0}")]
    Write(String),

    #[error("Resize failed: {0}")]
    Resize(String),
}

// ─── PtySession ──────────────────────────────────────────────────────────────

// Phase 1 では即 flush のため使用しないが、Phase 2 で独立タイマースレッド導入時に再利用する
#[allow(dead_code)]
const FLUSH_BYTES: usize = 64 * 1024;

pub struct PtySession {
    #[allow(dead_code)]
    pub id: String,
    writer: Mutex<Box<dyn Write + Send>>,
    // Fix 3: Option に変更して Drop 時に take → drop で PTY を閉じ、
    //        reader thread の blocking read を EOF で解放できるようにする
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    stop_flag: Arc<AtomicBool>,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
}

impl PtySession {
    fn new(
        id: String,
        writer: Box<dyn Write + Send>,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        stop_flag: Arc<AtomicBool>,
        reader_handle: JoinHandle<()>,
    ) -> Self {
        Self {
            id,
            writer: Mutex::new(writer),
            master: Mutex::new(Some(master)),
            child: Mutex::new(Some(child)),
            stop_flag,
            reader_handle: Mutex::new(Some(reader_handle)),
        }
    }

    pub fn write_data(&self, data: &str) -> Result<(), PtyError> {
        let mut writer = self.writer.lock();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| PtyError::Write(e.to_string()))?;
        writer
            .flush()
            .map_err(|e| PtyError::Write(e.to_string()))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        // SF-B1: 0 が来た場合は 1 に clamp（ResizeObserver がマウント直後の 0x0 レイアウトで
        //        発火するケースで ConPTY が ResizePseudoConsole エラーを返すのを防ぐ）
        let cols = cols.max(1);
        let rows = rows.max(1);

        // Fix 3: master は Option 経由でアクセス
        let master_lock = self.master.lock();
        if let Some(master) = master_lock.as_ref() {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| PtyError::Resize(e.to_string()))?;
        }
        Ok(())
    }

    pub fn kill(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        // Fix 8 (SF-8): child.kill() 後に child.wait() を明示的に呼んで zombie 化を防ぐ
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // stop_flag をセット
        self.stop_flag.store(true, Ordering::Relaxed);

        // Fix 8 (SF-8): child.kill() 後に child.wait() を明示的に呼んで zombie 化を防ぐ
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        // Fix 3: master を drop して PTY を閉じ、reader の blocking read を EOF で解放する
        drop(self.master.lock().take());

        // reader thread を join する。ただしアプリ終了をブロックしないよう
        // バックグラウンドスレッドに投げる
        if let Some(h) = self.reader_handle.lock().take() {
            std::thread::spawn(move || {
                let _ = h.join();
            });
        }
    }
}

// ─── reader スレッド起動 ─────────────────────────────────────────────────────

fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<PtyEvent>,
    stop_flag: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        // 読み込みバッファ（1 read あたり最大 4096 bytes）
        let mut read_buf = [0u8; 4096];

        // 未送信の積算バッファ（UTF-8 整合済みの byte が溜まる）
        let mut flush_buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES * 2);

        // UTF-8 境界で切れた不完全なバイト列の持ち越しバッファ
        let mut pending: Vec<u8> = Vec::new();

        // 注意: reader.read() はブロッキング呼び出しのため、16ms タイマーによる flush は
        // read が頻繁に戻る（出力が活発な）場面でのみ有効に機能する。
        // アイドル時は次の read が来るまでタイマーが進まない点に注意。
        // Fix 3 で master を drop することで EOF が届き、このループも自然に終了する。
        let mut read_count: u32 = 0;
        eprintln!("[pty] reader loop entered");
        loop {
            // 停止フラグ確認
            if stop_flag.load(Ordering::Relaxed) {
                eprintln!("[pty] reader stop_flag set, exit");
                break;
            }

            // PTY から読み込む
            let n = match reader.read(&mut read_buf) {
                // Fix 2: EOF パスで flush_buf / pending を局所変数で結合し、
                //        flush_buf の「有効 UTF-8 のみ」という invariant を保持する
                Ok(0) => {
                    if !flush_buf.is_empty() || !pending.is_empty() {
                        let mut final_bytes = std::mem::take(&mut flush_buf);
                        final_bytes.extend_from_slice(&pending);
                        let text = String::from_utf8_lossy(&final_bytes).into_owned();
                        let _ = channel.send(PtyEvent::Data { text });
                    }
                    let _ = channel.send(PtyEvent::Exit { code: None });
                    break;
                }
                Ok(n) => {
                    read_count = read_count.saturating_add(1);
                    if read_count <= 5 {
                        eprintln!(
                            "[pty] read #{read_count} n={n} first 30 bytes: {:?}",
                            &read_buf[..n.min(30)]
                        );
                    }
                    n
                }
                Err(e) => {
                    eprintln!("[pty] read error: {e}");
                    let _ = channel.send(PtyEvent::Error {
                        message: e.to_string(),
                    });
                    break;
                }
            };

            let chunk = &read_buf[..n];

            // pending + 今回のチャンクを結合して UTF-8 検証
            pending.extend_from_slice(chunk);

            // SF-6: 冗長な loop { match ... break; } を単純 match に整理
            match std::str::from_utf8(&pending) {
                Ok(_) => {
                    // 全バイト有効 — flush_buf に移動
                    flush_buf.append(&mut pending);
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        // 有効な先頭部分を flush_buf に移動し、残りを pending に残す
                        flush_buf.extend_from_slice(&pending[..valid_up_to]);
                        pending.drain(..valid_up_to);
                    } else if pending.len() >= 4 {
                        // 4 バイト以上で先頭から invalid → 無限ループ防止のため lossy 変換
                        let text = String::from_utf8_lossy(&pending).into_owned();
                        flush_buf.extend_from_slice(text.as_bytes());
                        pending.clear();
                    }
                    // else: 続きのバイトを待つ（pending はそのまま）
                }
            }

            // Phase 1 では即 flush（read() のブロッキングで 16ms タイマーが機能しない問題への対処）。
            // SF-7 で指摘された通り、read 間隔がまばらな場合タイマー flush に到達できず、
            // DSR-CPR 応答等の小量クエリが Frontend に届かず PTY が hang する。
            // Phase 2 で独立タイマースレッドを導入してバースト最適化と両立させる。
            let should_flush = !flush_buf.is_empty();

            if should_flush && !flush_buf.is_empty() {
                // Fix 1: unsafe { String::from_utf8_unchecked(...) } を除去。
                //        std::mem::take で所有権を移動し（clone 不要）、
                //        String::from_utf8 で安全に変換する。
                //        失敗した場合は lossy 変換にフォールバック。
                let buf = std::mem::take(&mut flush_buf);
                flush_buf = Vec::with_capacity(FLUSH_BYTES * 2);
                let text = match String::from_utf8(buf) {
                    Ok(s) => s,
                    Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
                };
                // Fix 4: send 失敗時の意図をコメントで明示
                // Frontend がアンロード済み。PtySession のクリーンアップは
                // 呼び出し側（アプリ終了 or pty_kill コマンド）に委ねる。
                // Phase 2 以降で PtyManager に dead session 掃除機構を追加予定。
                let send_result = channel.send(PtyEvent::Data { text });
                if read_count <= 5 {
                    eprintln!("[pty] sent data chunk (read_count={read_count}), result ok={}", send_result.is_ok());
                }
                if send_result.is_err() {
                    break;
                }
            }
        }
    })
}

// ─── PtyManager ──────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PtyManager {
    sessions: RwLock<HashMap<String, Arc<PtySession>>>,
}

impl PtyManager {
    pub fn spawn(
        &self,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        env: Option<HashMap<String, String>>,
        channel: Channel<PtyEvent>,
    ) -> Result<String, PtyError> {
        let _ = env; // Unit F (お気に入り) で本格利用予定
        // SF-B1: 0 clamp（フロント初期マウント時の 0x0 レイアウトを防御）
        let cols = cols.max(1);
        let rows = rows.max(1);

        eprintln!("[pty] spawn begin: cols={cols} rows={rows}");

        // シェル解決
        let shell_path = if let Some(s) = shell {
            std::path::PathBuf::from(s)
        } else {
            which::which("nu").map_err(|_| {
                PtyError::ShellNotFound(
                    "nushell (nu) が見つかりません。PATH を確認してください。".to_string(),
                )
            })?
        };
        eprintln!("[pty] shell resolved: {:?}", shell_path);

        // cwd 解決
        let cwd_path = if let Some(c) = cwd {
            std::path::PathBuf::from(c)
        } else {
            dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
        };

        // PTY サイズ
        let pty_size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        // PTY ペア生成
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(pty_size)
            .map_err(|e| PtyError::PtyOpen(e.to_string()))?;
        eprintln!("[pty] openpty ok");

        // コマンドビルド
        let mut cmd = CommandBuilder::new(&shell_path);
        cmd.cwd(&cwd_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // プロセス起動
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        eprintln!("[pty] spawn_command ok");

        // slave は spawn 後に drop して close
        drop(pair.slave);

        // writer / reader を取得
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::PtyOpen(e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::PtyOpen(e.to_string()))?;

        // 停止フラグ
        let stop_flag = Arc::new(AtomicBool::new(false));

        // reader スレッド起動
        let reader_handle =
            spawn_reader_thread(reader, channel, Arc::clone(&stop_flag));
        eprintln!("[pty] reader thread started");

        // セッション生成
        let id = Uuid::new_v4().to_string();
        eprintln!("[pty] session id: {id}");
        let session = Arc::new(PtySession::new(
            id.clone(),
            writer,
            pair.master,
            child,
            stop_flag,
            reader_handle,
        ));

        self.sessions.write().insert(id.clone(), session);

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), PtyError> {
        let sessions = self.sessions.read();
        let session = sessions
            .get(id)
            .ok_or_else(|| PtyError::SessionNotFound { id: id.to_string() })?;
        session.write_data(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = self.sessions.read();
        let session = sessions
            .get(id)
            .ok_or_else(|| PtyError::SessionNotFound { id: id.to_string() })?;
        session.resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> Result<(), PtyError> {
        // sessions から remove して Arc を取得（他に参照がなければ Drop が走る）
        let session = {
            let mut sessions = self.sessions.write();
            sessions.remove(id).ok_or_else(|| PtyError::SessionNotFound {
                id: id.to_string(),
            })?
        };
        session.kill();
        Ok(())
    }
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<PtyManager>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<std::collections::HashMap<String, String>>,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    state
        .spawn(shell, cwd, cols, rows, env, on_event)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyManager>, id: String) -> Result<(), String> {
    state.kill(&id).map_err(|e| e.to_string())
}
