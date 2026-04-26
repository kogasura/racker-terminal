use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use parking_lot::{Condvar, Mutex, RwLock};
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

// ─── FlushState（read / flush スレッド間共有） ────────────────────────────────

struct FlushState {
    /// read スレッドが書き込む生バイトバッファ
    raw_buf: Vec<u8>,
    /// UTF-8 境界の持ち越しバッファ（flush スレッドが管理）
    pending: Vec<u8>,
    /// 前回 flush 完了時刻（tiny read 即 flush ショートパス用）
    last_flush: Instant,
    /// read スレッドが EOF を受信したフラグ
    eof: bool,
    /// read スレッドがエラーを受信した場合のメッセージ
    error: Option<String>,
}

/// read / flush スレッド間で共有する状態 + Condvar の型エイリアス
type SharedFlushState = Arc<(Mutex<FlushState>, Condvar)>;

// ─── PtySession ──────────────────────────────────────────────────────────────

// SF-B1 参照: 0 clamp に使用するため定数は残しておく（Phase 2 でも流用）
#[allow(dead_code)]
const FLUSH_BYTES: usize = 64 * 1024;

/// PtySession 生成時の引数をまとめた構造体（clippy too_many_arguments 対策）
struct PtySessionArgs {
    id: String,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    stop_flag: Arc<AtomicBool>,
    reader_handle: JoinHandle<()>,
    flush_handle: JoinHandle<()>,
    flush_state: SharedFlushState,
}

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
    flush_handle: Mutex<Option<JoinHandle<()>>>,
    /// Drop 時に flush スレッドを即時起床させるための Condvar 共有参照
    /// （flush スレッドが wait_timeout で待機中でも stop_flag チェックに誘導できる）
    flush_state: SharedFlushState,
}

impl PtySession {
    fn new(args: PtySessionArgs) -> Self {
        Self {
            id: args.id,
            writer: Mutex::new(args.writer),
            master: Mutex::new(Some(args.master)),
            child: Mutex::new(Some(args.child)),
            stop_flag: args.stop_flag,
            reader_handle: Mutex::new(Some(args.reader_handle)),
            flush_handle: Mutex::new(Some(args.flush_handle)),
            flush_state: args.flush_state,
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

        // flush スレッドを即時起床させる（wait_timeout(16ms) で待機中のものを解放）
        let (_, cvar) = &*self.flush_state;
        cvar.notify_one();

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

        // flush スレッドを即時起床させる（wait_timeout(16ms) で待機中のものを解放）
        // これにより stop_flag チェックが即座に走り、flush スレッドが終了できる
        let (_, cvar) = &*self.flush_state;
        cvar.notify_one();

        // Fix 8 (SF-8): child.kill() 後に child.wait() を明示的に呼んで zombie 化を防ぐ
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        // Fix 3: master を drop して PTY を閉じ、reader の blocking read を EOF で解放する
        drop(self.master.lock().take());

        // reader / flush thread を join する。ただしアプリ終了をブロックしないよう
        // バックグラウンドスレッドに投げる
        if let Some(h) = self.reader_handle.lock().take() {
            std::thread::spawn(move || {
                let _ = h.join();
            });
        }
        if let Some(h) = self.flush_handle.lock().take() {
            std::thread::spawn(move || {
                let _ = h.join();
            });
        }
    }
}

// ─── UTF-8 境界処理ユーティリティ ────────────────────────────────────────────

/// pending + raw を UTF-8 境界で valid prefix と remainder に分離する。
/// 4 byte 以上で先頭 invalid の場合は lossy 変換で強制進行（無限ループ防止）。
///
/// 戻り値: (valid_bytes, remaining_pending)
fn split_at_utf8_boundary(mut combined: Vec<u8>) -> (Vec<u8>, Vec<u8>) {
    if combined.is_empty() {
        return (Vec::new(), Vec::new());
    }
    match std::str::from_utf8(&combined) {
        Ok(_) => (combined, Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if valid_up_to > 0 {
                let remain = combined.split_off(valid_up_to);
                (combined, remain)
            } else if combined.len() >= 4 {
                // 4 byte 以上で先頭 invalid → lossy で強制進行
                let text = String::from_utf8_lossy(&combined).into_owned();
                (text.into_bytes(), Vec::new())
            } else {
                // 続きのバイトを待つ
                (Vec::new(), combined)
            }
        }
    }
}

// ─── reader / flush 2 スレッド構成 ──────────────────────────────────────────
//
// Phase 2 (Unit D+E) で地雷 #4 を根本解決するための設計:
//
//   read スレッド  : PTY.read() blocking → raw_buf (Mutex<FlushState>) に追記 → Condvar notify
//   flush スレッド : Condvar.wait_timeout(16ms) で待機 → 起床したら raw_buf drain →
//                   UTF-8 検証 → channel.send
//
// tiny read 即 flush ショートパス:
//   read スレッドが 1 回で受け取ったバイト数が 256 byte 未満 かつ
//   前回 flush から 2ms 以上経過している場合は notify_one() を呼んで flush スレッドを即時起床。
//   これにより DSR-CPR 応答の初期 hang を解消する。
//
// burst 時は flush スレッドの 16ms wait_timeout が自然に drain → IPC 回数削減。
// parking_lot::Condvar を使用（既存コードで parking_lot::Mutex 使用済みのため統一）。

/// read / flush 2 スレッドの起動結果
struct ReaderThreads {
    read_handle: JoinHandle<()>,
    flush_handle: JoinHandle<()>,
    flush_state: SharedFlushState,
}

fn spawn_reader_threads(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<PtyEvent>,
    stop_flag: Arc<AtomicBool>,
) -> ReaderThreads {
    // read / flush スレッド間共有状態
    let flush_state = Arc::new((
        Mutex::new(FlushState {
            raw_buf: Vec::with_capacity(8192),
            pending: Vec::new(),
            last_flush: Instant::now(),
            eof: false,
            error: None,
        }),
        Condvar::new(),
    ));

    // ── read スレッド ──────────────────────────────────────────────────────
    // blocking read のみ担当。UTF-8 検証は行わず raw bytes を raw_buf に追記する。
    let read_state = Arc::clone(&flush_state);
    let read_stop = Arc::clone(&stop_flag);
    let read_handle = std::thread::spawn(move || {
        let mut read_buf = [0u8; 4096];
        let mut read_count: u32 = 0;
        eprintln!("[pty-read] reader loop entered");

        loop {
            if read_stop.load(Ordering::Relaxed) {
                eprintln!("[pty-read] stop_flag set, exit");
                break;
            }

            match reader.read(&mut read_buf) {
                Ok(0) => {
                    // EOF: flush スレッドに通知して終了
                    eprintln!("[pty-read] EOF received");
                    let (lock, cvar) = &*read_state;
                    let mut s = lock.lock();
                    s.eof = true;
                    cvar.notify_one();
                    break;
                }
                Ok(n) => {
                    read_count = read_count.saturating_add(1);
                    if read_count <= 5 {
                        eprintln!(
                            "[pty-read] read #{read_count} n={n} first 30 bytes: {:?}",
                            &read_buf[..n.min(30)]
                        );
                    }

                    let (lock, cvar) = &*read_state;
                    let mut s = lock.lock();
                    s.raw_buf.extend_from_slice(&read_buf[..n]);

                    // tiny read 即 flush ショートパス:
                    // n < 256 byte かつ前回 flush から 2ms 以上経過 → flush スレッドを即時起床
                    // （DSR-CPR 応答等の遅延を回避）
                    // burst 時は flush の 16ms タイマーに任せて notify syscall 回数を削減
                    let tiny = n < 256 && s.last_flush.elapsed() >= std::time::Duration::from_millis(2);
                    if read_count <= 5 {
                        eprintln!("[pty-read] tiny={tiny} n={n}");
                    }
                    drop(s);
                    if tiny {
                        cvar.notify_one();
                    }
                    // burst 時の notify は省略 — 16ms 以内に wait_timeout が起きる
                }
                Err(e) => {
                    eprintln!("[pty-read] read error: {e}");
                    let (lock, cvar) = &*read_state;
                    let mut s = lock.lock();
                    s.error = Some(e.to_string());
                    cvar.notify_one();
                    break;
                }
            }
        }
        eprintln!("[pty-read] reader thread exit");
    });

    // ── flush スレッド ─────────────────────────────────────────────────────
    // Condvar.wait_timeout(16ms) で待機し、起床したら raw_buf を drain して
    // UTF-8 検証 → channel.send を行う。
    // read スレッドがブロッキングで止まっていても独立して動作する。
    let flush_state_clone = Arc::clone(&flush_state);
    let flush_stop = Arc::clone(&stop_flag);
    let flush_handle = std::thread::spawn(move || {
        let timeout = std::time::Duration::from_millis(16);
        eprintln!("[pty-flush] flush loop entered");

        loop {
            if flush_stop.load(Ordering::Relaxed) {
                eprintln!("[pty-flush] stop_flag set, exit");
                break;
            }

            // wait_timeout(16ms) で待機。notify または timeout で起床。
            let (lock, cvar) = &*flush_state_clone;
            let mut s = lock.lock();
            let _ = cvar.wait_for(&mut s, timeout);

            // stop_flag を再確認（wake 後）
            if flush_stop.load(Ordering::Relaxed) {
                // drain: stop_flag=true でも、溜まっている raw + pending を可能な限り吐き出す
                let raw = std::mem::take(&mut s.raw_buf);
                let pending = std::mem::take(&mut s.pending);
                let pending_error = s.error.take();
                drop(s);

                // pending + raw を lossy で吐く（UTF-8 境界検証を省略して確実に吐き切る）
                let mut combined = pending;
                combined.extend_from_slice(&raw);
                if !combined.is_empty() {
                    let text = String::from_utf8_lossy(&combined).into_owned();
                    let _ = channel.send(PtyEvent::Data { text });
                }

                // 残留 error があれば送信
                if let Some(msg) = pending_error {
                    eprintln!("[pty-flush] stop_flag set, sending pending error: {msg}");
                    let _ = channel.send(PtyEvent::Error { message: msg });
                } else {
                    // shutdown 経由でも Exit を送って Frontend に終了を通知
                    eprintln!("[pty-flush] stop_flag set after wake, sending Exit");
                    let _ = channel.send(PtyEvent::Exit { code: None });
                }
                break;
            }

            // raw_buf / eof / error を取り出す
            let raw = std::mem::take(&mut s.raw_buf);
            let eof = s.eof;
            let error = s.error.take();

            if raw.is_empty() && !eof && error.is_none() {
                // 何もなければ次の wait へ
                continue;
            }

            // pending + raw を組み立てる
            let combined = {
                let mut c = std::mem::take(&mut s.pending);
                c.extend_from_slice(&raw);
                c
            };

            // UTF-8 境界で分離
            let (valid_bytes, remaining_pending) = split_at_utf8_boundary(combined);

            // pending を更新し last_flush を記録
            s.pending = remaining_pending;
            s.last_flush = Instant::now();
            drop(s);

            // Data イベント送信
            if !valid_bytes.is_empty() {
                let text = match String::from_utf8(valid_bytes) {
                    Ok(s) => s,
                    Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
                };
                eprintln!("[pty-flush] sending data len={}", text.len());
                if channel.send(PtyEvent::Data { text }).is_err() {
                    eprintln!("[pty-flush] channel send failed, exit");
                    break;
                }
            }

            // エラー送信
            if let Some(msg) = error {
                // error 送信前に、持ち越し pending を lossy で吐き出す（データロス防止）
                let (lock, _) = &*flush_state_clone;
                let mut s = lock.lock();
                let remain = std::mem::take(&mut s.pending);
                drop(s);
                if !remain.is_empty() {
                    let text = String::from_utf8_lossy(&remain).into_owned();
                    let _ = channel.send(PtyEvent::Data { text });
                }
                eprintln!("[pty-flush] sending error: {msg}");
                let _ = channel.send(PtyEvent::Error { message: msg });
                break;
            }

            // EOF: 残余 pending を lossy で吐いて Exit 送信して終了
            if eof {
                eprintln!("[pty-flush] EOF, sending Exit");
                let (lock, _) = &*flush_state_clone;
                let mut s = lock.lock();
                let remain = std::mem::take(&mut s.pending);
                drop(s);
                if !remain.is_empty() {
                    let text = String::from_utf8_lossy(&remain).into_owned();
                    let _ = channel.send(PtyEvent::Data { text });
                }
                let _ = channel.send(PtyEvent::Exit { code: None });
                break;
            }
        }
        eprintln!("[pty-flush] flush thread exit");
    });

    ReaderThreads {
        read_handle,
        flush_handle,
        flush_state,
    }
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

        // env をユーザー指定値で merge（shell の継承環境に上書きする形）
        if let Some(env_map) = env {
            for (key, value) in env_map {
                // 空キーは弾く（防御的コード）
                if !key.is_empty() {
                    cmd.env(key, value);
                }
            }
        }

        // TERM / COLORTERM は env 適用後に強制上書きして xterm 互換性を保護する
        // （ユーザーが env で上書きしても racker-terminal 側で正しい値に戻す）
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

        // read / flush 2 スレッド起動
        let threads = spawn_reader_threads(reader, channel, Arc::clone(&stop_flag));
        eprintln!("[pty] reader + flush threads started");

        // セッション生成
        let id = Uuid::new_v4().to_string();
        eprintln!("[pty] session id: {id}");
        let session = Arc::new(PtySession::new(PtySessionArgs {
            id: id.clone(),
            writer,
            master: pair.master,
            child,
            stop_flag,
            reader_handle: threads.read_handle,
            flush_handle: threads.flush_handle,
            flush_state: threads.flush_state,
        }));

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

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_all_valid() {
        let (v, r) = split_at_utf8_boundary(b"hello".to_vec());
        assert_eq!(v, b"hello");
        assert!(r.is_empty());
    }

    #[test]
    fn split_partial_multibyte_held_over() {
        // "あ" = 0xe3 0x81 0x82。最初の 2 byte のみ
        let (v, r) = split_at_utf8_boundary(vec![0xe3, 0x81]);
        assert!(v.is_empty());
        assert_eq!(r, vec![0xe3, 0x81]);
    }

    #[test]
    fn split_valid_then_partial() {
        // "abc" + "あ" の最初 2 byte
        let mut input = b"abc".to_vec();
        input.extend_from_slice(&[0xe3, 0x81]);
        let (v, r) = split_at_utf8_boundary(input);
        assert_eq!(v, b"abc");
        assert_eq!(r, vec![0xe3, 0x81]);
    }

    #[test]
    fn split_four_bytes_invalid_goes_lossy() {
        let (v, r) = split_at_utf8_boundary(vec![0xff, 0xff, 0xff, 0xff]);
        assert!(!v.is_empty()); // U+FFFD replacement character が入る
        assert!(r.is_empty());
    }

    #[test]
    fn split_empty() {
        let (v, r) = split_at_utf8_boundary(vec![]);
        assert!(v.is_empty());
        assert!(r.is_empty());
    }

    #[test]
    fn split_japanese_full() {
        // "こんにちは" を完全に含む
        let input = "こんにちは".as_bytes().to_vec();
        let (v, r) = split_at_utf8_boundary(input.clone());
        assert_eq!(v, input);
        assert!(r.is_empty());
    }
}
