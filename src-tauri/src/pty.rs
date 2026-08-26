use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use parking_lot::{Condvar, Mutex, RwLock};
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::ipc::Channel;
use thiserror::Error;
use uuid::Uuid;

// ─── デバッグログマクロ ───────────────────────────────────────────────────────
// release ビルドで eprintln! がログに漏れないよう #[cfg(debug_assertions)] で囲む。
// Phase 3 で telemetry 収集が必要になったら tracing クレートへの移行を検討する。
macro_rules! dbg_log {
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        { eprintln!($($arg)*); }
        #[cfg(not(debug_assertions))]
        { let _ = format_args!($($arg)*); }
    }}
}

// ─── 定数 ────────────────────────────────────────────────────────────────────

/// tiny read 即 flush ショートパスの閾値。
/// 1 回の read で受け取ったバイト数がこの値未満のとき、flush スレッドを即時起床させる。
const TINY_READ_THRESHOLD: usize = 256;

/// tiny read 判定で使用する前回 flush からの最小間隔。
const TINY_READ_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(2);

/// raw_buf の上限バイト数（4MB）。
/// `yes` / `find /` 等の暴走出力で OOM になるのを防ぐための back-pressure 上限。
const RAW_BUF_LIMIT_BYTES: usize = 4 * 1024 * 1024;

/// フロー制御（#4）で read スレッドを pause できる最大連続時間。
/// フロント側の resume(ack) が失われても、この時間を超えたら read を強制再開して
/// ターミナルが恒久ハングするのを防ぐ安全弁。
const MAX_READ_PAUSE: std::time::Duration = std::time::Duration::from_secs(10);

// ─── flush スレッドの待ち時間 ────────────────────────────────────────────────
//
// flush スレッドは Condvar のタイムアウトで定期的に起きる。この間隔がそのまま
// **アイドル時の消費電力**になる。出力が流れていない間も起き続けると、
// タブ 1 つにつき毎秒 62.5 回 CPU を起こすことになり、8 タブで毎秒 500 回。
// ノート PC では CPU が深い休止状態に入れず、何もしていないのにバッテリーを食う。
//
// そこで「出力が流れている間」と「止まっている間」で待ち時間を変える。
// 出力再開の検知はタイマーではなく read スレッドからの notify で行うので、
// アイドル側を伸ばしても表示は遅れない (append_read_bytes 参照)。

/// 出力が流れている間の待ち時間。バーストを 1 回の IPC にまとめるための窓。
const FLUSH_ACTIVE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);

/// 最後に出力を見てからこの時間が過ぎたら、アイドルとみなして待ちを伸ばす。
/// 短すぎるとバーストの合間で頻繁にモードが切り替わる。
const FLUSH_IDLE_AFTER: std::time::Duration = std::time::Duration::from_millis(500);

/// アイドル時の待ち時間。
///
/// 出力が来たら notify で即座に起こされるので、この値は表示の遅延にはならない。
/// 無期限にしないのは、notify を取りこぼした場合でも必ず復帰させるため
/// (stop_flag のチェックもこの周期で回る)。
const FLUSH_IDLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// child watcher が子プロセスの終了を確認する間隔。
///
/// これもアイドル時に効いてくる (タブ 1 つにつき毎秒 10 回 → 500ms なら 2 回)。
/// 伸ばすと「シェルが終了してからタブに反映されるまで」が延びるが、
/// これは人が知覚できる速さの話ではないので 500ms で十分。
const CHILD_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

// ─── reaper の在庫カウンタ ───────────────────────────────────────────────────
//
// 後始末 (PtySession::reap) は別スレッドで走るため、プロセスがその完了前に終了すると
// ConPTY のホストプロセス (OpenConsole.exe) が**孤児として残る**。
// 実際、これまでフリーズ→強制終了を繰り返した結果、親の死んだ OpenConsole.exe が
// 数十個単位で積み上がっていた。
//
// そこで在庫数を数えておき、終了時に「上限つきで」捌けるのを待てるようにする。
// 上限を設けるのは、待ち自体が無制限になるとフリーズを別の場所に作り直すことになるため。

/// 実行中の reaper スレッド数。
static REAPS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// `ClosePseudoConsole` の完了を待つ猶予。
///
/// 正常なセッションはここに収まる (実測で長くても数百 ms)。超えたということは
/// 返ってこない側に入ったということなので、待たずに子プロセスの終了へ進む。
/// 短くしすぎると正常時にも子を先に殺してしまい、v1.8.1 で直した
/// 「先に kill すると ClosePseudoConsole が永久に返らない」を踏み直す。
const CLOSE_PTY_GRACE: std::time::Duration = std::time::Duration::from_millis(1000);

/// ConPTY が起動直後に出すカーソル位置問い合わせ (DSR-CPR) への応答。
///
/// 「カーソルは 1 行 1 桁にある」という内容。実際の位置は問題にならない。
/// 閉じる直前に送るだけなので、シェルの表示を乱すこともない。
const DSR_CPR_REPLY: &[u8] = b"\x1b[1;1R";

/// 入力パイプを閉じる。**閉じる前に DSR-CPR へ応答しておく。**
///
/// ConPTY は起動直後にカーソル位置問い合わせ (`ESC[6n`) を出し、**応答が返るまで
/// 先へ進まない**。通常は端末 (xterm) が応答するが、応答が返る前にタブを閉じると
/// 誰も応答しないまま入力パイプが閉じ、`ClosePseudoConsole` が返らなくなる。
/// 後始末が返らなければホストプロセス (OpenConsole.exe) はアプリの終了まで残るため、
/// **タブを開いてすぐ閉じる操作を繰り返すと、その数だけ積み上がっていく**。
///
/// そこで閉じる直前に代わりに応答して、ConPTY を進ませてから閉じる。
/// 既に応答済みのセッションにとっては余分な入力だが、直後にパイプごと閉じるので
/// 実害はない。
fn answer_pending_dsr_then_close(writer: Option<Box<dyn Write + Send>>) {
    let Some(mut writer) = writer else {
        return;
    };
    let _ = writer.write_all(DSR_CPR_REPLY);
    let _ = writer.flush();
    drop(writer);
}

/// `master` を drop (= `ClosePseudoConsole`) する。猶予内に返れば `true`。
///
/// drop 自体を更に別スレッドへ逃がしている。返らない場合にそのスレッドは
/// 残り続けるが、プロセスの終了時に OS が回収する。ここで待ち続けて
/// 後続の後始末 (子プロセスの終了) を止めるほうが害が大きい。
fn close_master_with_grace(master: &SharedMaster) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let master = Arc::clone(master);
    std::thread::spawn(move || {
        drop(master.lock().take());
        let _ = tx.send(());
    });
    rx.recv_timeout(CLOSE_PTY_GRACE).is_ok()
}

/// 進行中の後始末が捌けるのを待つ。`timeout` を過ぎたら諦めて戻る (戻り値 `false`)。
///
/// **待ち切れないことは普通に起こる。** ConPTY の `ClosePseudoConsole` は、
/// 起動直後のセッションを閉じたときなど、条件によっては返ってこない。
/// そのため呼び出し側は短い上限を渡し、`false` でも先へ進むこと。
/// 戻らなかった後始末はプロセス終了時に OS が回収する。
pub fn wait_for_reapers(timeout: std::time::Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while REAPS_IN_FLIGHT.load(Ordering::SeqCst) > 0 {
        if Instant::now() >= deadline {
            dbg_log!("[pty-reap] wait_for_reapers timed out");
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    true
}

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
    /// child watcher が検出した子プロセスの実 exit code
    /// （PtyEvent::Exit に乗せる）
    exit_code: Option<i32>,
}

/// read / flush スレッド間で共有する状態 + Condvar の型エイリアス
type SharedFlushState = Arc<(Mutex<FlushState>, Condvar)>;

/// read スレッドの pause 制御を共有する型（#4 フロー制御 / back-pressure）。
/// bool = pause 中か。Condvar で resume / stop 時に read スレッドを即時起床させる。
type ReadPause = Arc<(Mutex<bool>, Condvar)>;

// ─── PtySession ──────────────────────────────────────────────────────────────

// SF-B1 参照: 0 clamp に使用するため定数は残しておく（Phase 2 でも流用）
#[allow(dead_code)]
const FLUSH_BYTES: usize = 64 * 1024;

/// child / master 共有用の型エイリアス（watcher スレッドと PtySession で共有）
type SharedChild = Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>;
type SharedMaster = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

/// PtySession 生成時の引数をまとめた構造体（clippy too_many_arguments 対策）
struct PtySessionArgs {
    id: String,
    writer: Box<dyn Write + Send>,
    master: SharedMaster,
    child: SharedChild,
    stop_flag: Arc<AtomicBool>,
    reader_handle: JoinHandle<()>,
    flush_handle: JoinHandle<()>,
    watch_handle: JoinHandle<()>,
    flush_state: SharedFlushState,
    read_pause: ReadPause,
}

pub struct PtySession {
    pub id: String,
    /// PTY の入力パイプ。**後始末で master より先に閉じる必要がある**ため Option。
    /// ConPTY は入力側が開いたままだと ClosePseudoConsole が返らない (reap 参照)。
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    // Fix 3: Option に変更して Drop 時に take → drop で PTY を閉じ、
    //        reader thread の blocking read を EOF で解放できるようにする
    // exit-hang fix: watcher スレッドと共有するため Arc に変更
    master: SharedMaster,
    child: SharedChild,
    stop_flag: Arc<AtomicBool>,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
    flush_handle: Mutex<Option<JoinHandle<()>>>,
    watch_handle: Mutex<Option<JoinHandle<()>>>,
    /// Drop 時に flush スレッドを即時起床させるための Condvar 共有参照
    /// （flush スレッドが wait_timeout で待機中でも stop_flag チェックに誘導できる）
    flush_state: SharedFlushState,
    /// #4 フロー制御: read スレッドの pause/resume 制御。kill/Drop 時に notify して
    /// pause 中の read スレッドを起こし stop_flag チェックへ誘導する。
    read_pause: ReadPause,
    /// 後始末を reaper スレッドへ委譲済みか。
    /// kill() → Arc drop → Drop の順で 2 回呼ばれるため、1 回だけ投げるようにする。
    reaped: AtomicBool,
}

impl PtySession {
    fn new(args: PtySessionArgs) -> Self {
        Self {
            id: args.id,
            writer: Mutex::new(Some(args.writer)),
            master: args.master,
            child: args.child,
            stop_flag: args.stop_flag,
            reader_handle: Mutex::new(Some(args.reader_handle)),
            flush_handle: Mutex::new(Some(args.flush_handle)),
            watch_handle: Mutex::new(Some(args.watch_handle)),
            flush_state: args.flush_state,
            read_pause: args.read_pause,
            reaped: AtomicBool::new(false),
        }
    }

    /// #4 フロー制御: read スレッドの pause/resume を切り替える。
    /// resume(false) 時に Condvar を notify して pause 待機中の read スレッドを即時起床させる。
    pub fn set_read_paused(&self, paused: bool) {
        let (plock, pcvar) = &*self.read_pause;
        *plock.lock() = paused;
        pcvar.notify_one();
    }

    pub fn write_data(&self, data: &str) -> Result<(), PtyError> {
        let mut guard = self.writer.lock();
        // 後始末が始まっていると writer は take 済み。閉じかけのセッションへの
        // 書き込みはエラーにする（フロント側は close 済みタブとして扱う）。
        let writer = guard
            .as_mut()
            .ok_or_else(|| PtyError::Write("session is closing".to_string()))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| PtyError::Write(e.to_string()))?;
        writer.flush().map_err(|e| PtyError::Write(e.to_string()))?;
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

    /// 各スレッドへ停止を伝える。**ブロックしない処理だけ**をここに置く。
    fn signal_stop(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);

        // flush スレッドを即時起床させる（wait_timeout(16ms) で待機中のものを解放）
        let (_, cvar) = &*self.flush_state;
        cvar.notify_one();

        // #4: pause 中の read スレッドを起床させて stop_flag チェックへ誘導する
        self.read_pause.1.notify_one();
    }

    /// ブロックしうる後始末を専用スレッドへ委譲する。
    ///
    /// ここで行う 3 つの処理は、いずれも **Windows (ConPTY) では返らないことがある**:
    ///
    /// 1. `child.wait()` — ConPTY 配下の子プロセスがハングしていると kill 後も返らない
    /// 2. `master` の drop — `ClosePseudoConsole` が出力パイプの排出を待つ
    /// 3. reader/flush/watch の `join()` — 上記 2 が返らない限り reader も抜けられない
    ///
    /// これを呼び出し元スレッドで行うと、Tauri command はメインスレッド
    /// (= Windows のメッセージループ) で実行されるため、UI ごと固まって
    /// 「応答なし」→ 強制終了になる (WER: AppHang XProcB1 / OpenConsole.exe)。
    /// 後始末が返るかどうかに関わらず UI を巻き込まないよう、必ず別スレッドへ逃がす。
    ///
    /// スレッドは session ごとに一時的に 1 本だけ。正常時は数 ms で終了して回収される。
    fn reap(&self) {
        // kill() → Arc drop → Drop の順で 2 回来るので、投げるのは 1 回だけにする
        if self.reaped.swap(true, Ordering::SeqCst) {
            return;
        }

        let id = self.id.clone();
        let child = Arc::clone(&self.child);
        let master = Arc::clone(&self.master);
        // 入力パイプ。master より先に閉じる必要があるので、ここで取り上げておく。
        let writer = self.writer.lock().take();
        let handles = [
            self.reader_handle.lock().take(),
            self.flush_handle.lock().take(),
            self.watch_handle.lock().take(),
        ];

        // spawn する前に増やす。spawn 後だと、終了処理が wait_for_reapers に入った時点で
        // まだ 0 に見えてしまい、待たずに素通りする隙間ができる。
        REAPS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);

        std::thread::spawn(move || {
            let t = Instant::now();

            // ── 順序が重要。ここを入れ替えると後始末が返らなくなる ──────────────
            //
            // ① 入力パイプを閉じる
            // ② PTY を閉じる (ClosePseudoConsole)
            // ③ 子プロセスを終了させる
            //
            // v1.8.1 までは ③ → ② の順だった。先に子を kill してしまうと
            // ClosePseudoConsole が**永久に返らない**。これが「Windows では Drop の
            // join が返らない」と言われていたものの正体で、ConPTY のホストプロセス
            // (OpenConsole.exe) が孤児として残る原因でもあった。
            answer_pending_dsr_then_close(writer);

            // ② は返らないことがある。ここで詰まると ③ に到達できず、シェルが
            // 生き残る。**シェルが生きている限り ConPTY のホストも終了できない**ので、
            // プロセスが死んだときに OpenConsole.exe がそのまま残ることになる。
            // そこで ② を更に別スレッドへ逃がし、猶予を過ぎたら ③ を先に撃つ。
            // 「順序が重要」なのは正常時の話で、既に返ってこないと分かった後は
            // シェルを止めて ConPTY を解放するほうが良い。
            let closed = close_master_with_grace(&master);
            if !closed {
                dbg_log!(
                    "[pty-reap] session {id}: ClosePseudoConsole が {CLOSE_PTY_GRACE:?} で返らず、子プロセスを先に終了させる"
                );
            }

            // ③ Fix 8 (SF-8): child.kill() 後に child.wait() を明示的に呼んで zombie 化を防ぐ
            if let Some(mut child) = child.lock().take() {
                let _ = child.kill();
                let _ = child.wait();
            }

            // (2.10) detached thread リーク対策として join 自体は維持する。
            // 呼び出し元ではなくこのスレッドで待つので、返らなくても UI には影響しない。
            //
            // ただし ② が返らなかった場合は join もまず返らない (reader は
            // 出力パイプが閉じるまで抜けられない)。そこで join を諦めて
            // カウンタを解放する。ここで待ち続けると、終了時の wait_for_reapers が
            // 必ず上限まで粘ることになり、**待つ意味がなくなる**。
            if closed {
                for handle in handles.into_iter().flatten() {
                    let _ = handle.join();
                }
            }
            dbg_log!("[pty-reap] session {id} reaped in {:?}", t.elapsed());
            REAPS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        });
    }

    /// セッションを終了する。
    /// 停止フラグを立てて後始末を別スレッドへ渡すだけなので、**即座に返る**。
    pub fn kill(&self) {
        self.signal_stop();
        self.reap();
    }
}

impl Drop for PtySession {
    // Drop は停止フラグを立てて後始末を reaper スレッドへ渡すだけなので、常に即座に返る。
    // ブロックしうる処理 (child.wait / master drop / join) を Drop に置いてはいけない:
    // Arc<PtySession> の最後の参照が切れる場所は Tauri command のスレッド、すなわち
    // メインスレッドであり、そこで固まると UI ごと応答不能になる。詳細は reap() を参照。
    //
    // race 条件:
    // - watch スレッドが child.lock() を保持して try_wait を呼ぶ間、reaper の child.kill+wait は
    //   競合する。watch は try_wait 後すぐ lock を手放すため、reaper は概ね watch loop の
    //   次イテレーション (or break) を待ってから kill+wait に入る。実害はない (watch は
    //   child=None を観測して break する経路がある)。
    fn drop(&mut self) {
        self.signal_stop();
        self.reap();
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
    read_pause: ReadPause,
}

/// シェルを解決する。未指定なら nushell (nu) を PATH から探す。
fn resolve_shell(shell: Option<String>) -> Result<std::path::PathBuf, PtyError> {
    if let Some(s) = shell {
        return Ok(std::path::PathBuf::from(s));
    }
    which::which("nu").map_err(|_| {
        PtyError::ShellNotFound(
            "nushell (nu) が見つかりません。PATH を確認してください。".to_string(),
        )
    })
}

/// 作業ディレクトリを解決する。未指定ならホーム、取れなければカレント。
fn resolve_cwd(cwd: Option<String>) -> std::path::PathBuf {
    match cwd {
        Some(c) => std::path::PathBuf::from(c),
        None => dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")),
    }
}

/// shell 起動引数と env をコマンドへ適用する。
fn apply_args_and_env(
    cmd: &mut CommandBuilder,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
) {
    // shell 起動引数を追加（空文字列要素はスキップ）
    for a in args.unwrap_or_default() {
        if !a.is_empty() {
            cmd.arg(a);
        }
    }

    // env をユーザー指定値で merge（shell の継承環境に上書きする形）
    for (key, value) in env.unwrap_or_default() {
        // 空キーは弾く（防御的コード）
        if !key.is_empty() {
            cmd.env(key, value);
        }
    }
}

/// #4 フロー制御: フロント側が high watermark に達したら pause 要求が来る。
/// paused の間は read を止めて PTY の OS バッファを埋め、子プロセスに背圧をかける。
/// MAX_READ_PAUSE を超えたら安全弁として強制再開する（resume 消失時のハング防止）。
fn wait_while_paused(read_pause: &ReadPause, stop_flag: &AtomicBool) {
    let (plock, pcvar) = &**read_pause;
    let mut paused = plock.lock();
    if !*paused {
        return;
    }
    let start = Instant::now();
    while *paused && !stop_flag.load(Ordering::Relaxed) && start.elapsed() < MAX_READ_PAUSE {
        pcvar.wait_for(&mut paused, std::time::Duration::from_millis(200));
    }
}

/// 読み取った bytes を raw_buf へ追記し、必要なら flush スレッドを起床させる。
fn append_read_bytes(state: &SharedFlushState, bytes: &[u8], read_count: u32) {
    let (lock, cvar) = &**state;
    let mut s = lock.lock();

    // 追記前に空だったか。空 → 非空 の変化は「出力が再開した」ことを意味する。
    // アイドル中の flush スレッドは最大 1 秒眠っているので、ここで起こさないと
    // 最初の 1 文字の表示が最大 1 秒遅れる。
    let was_empty = s.raw_buf.is_empty();

    s.raw_buf.extend_from_slice(bytes);

    // back-pressure: raw_buf が RAW_BUF_LIMIT_BYTES を超えたら古い半分を破棄する。
    // `yes` / `find /` 等の暴走出力による OOM を防ぐ。
    // drain 直後は pending と raw_buf が非連続になり、UTF-8 検証で
    // 数バイト分が U+FFFD になる場合がある（許容）。
    if s.raw_buf.len() > RAW_BUF_LIMIT_BYTES {
        let drain_len = s.raw_buf.len() / 2;
        s.raw_buf.drain(0..drain_len);
        s.raw_buf.extend_from_slice(b"\r\n[output truncated]\r\n");
        dbg_log!("[pty-read] back-pressure triggered: drained {drain_len} bytes");
    }

    // tiny read 即 flush ショートパス:
    // n < TINY_READ_THRESHOLD かつ前回 flush から TINY_READ_MIN_INTERVAL_MS 以上経過
    // → flush スレッドを即時起床（DSR-CPR 応答等の遅延を回避）
    // burst 時は flush の 16ms タイマーに任せて notify syscall 回数を削減
    let tiny =
        bytes.len() < TINY_READ_THRESHOLD && s.last_flush.elapsed() >= TINY_READ_MIN_INTERVAL;
    if read_count <= 5 {
        dbg_log!("[pty-read] tiny={tiny} n={}", bytes.len());
    }
    drop(s);
    // was_empty: アイドルで眠っている flush スレッドを起こす（上記参照）。
    // tiny: 従来どおり、小さな読み取りは待たずに吐く（DSR-CPR 応答等）。
    if tiny || was_empty {
        cvar.notify_one();
    }
    // burst 時の notify は省略 — 16ms 以内に wait_timeout が起きる
}

/// blocking read のみ担当。UTF-8 検証は行わず raw bytes を raw_buf に追記する。
fn spawn_read_thread(
    mut reader: Box<dyn Read + Send>,
    read_state: SharedFlushState,
    read_stop: Arc<AtomicBool>,
    read_pause: ReadPause,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut read_buf = [0u8; 4096];
        let mut read_count: u32 = 0;
        dbg_log!("[pty-read] reader loop entered");

        // ⚠️ このループは stop_flag では抜けない。**EOF かエラーでのみ抜ける。**
        //
        // ConPTY の `ClosePseudoConsole` は「出力パイプが読み切られる」まで返らない。
        // 停止要求が来た時点で読むのをやめると、後始末の master drop がそこで永久に
        // 待たされ、セッションの後始末が完了しなくなる（ConPTY ホストの OpenConsole.exe が
        // 孤児として残る）。そのため停止時も EOF が来るまで読み続けて、パイプを排出する。
        //
        // 停止時に EOF が来る仕組み: 後始末 (PtySession::reap) が master を drop するため、
        // 読み切った時点で read() が Ok(0) を返してこのループが終わる。
        // stop_flag は「pause を打ち切って読み続けさせる」ためだけに使う。
        loop {
            wait_while_paused(&read_pause, &read_stop);

            match reader.read(&mut read_buf) {
                Ok(0) => {
                    // EOF: flush スレッドに通知して終了
                    dbg_log!("[pty-read] EOF received");
                    let (lock, cvar) = &*read_state;
                    let mut s = lock.lock();
                    s.eof = true;
                    cvar.notify_one();
                    break;
                }
                Ok(n) => {
                    read_count = read_count.saturating_add(1);
                    if read_count <= 5 {
                        dbg_log!(
                            "[pty-read] read #{read_count} n={n} first 30 bytes: {:?}",
                            &read_buf[..n.min(30)]
                        );
                    }
                    append_read_bytes(&read_state, &read_buf[..n], read_count);
                }
                Err(e) => {
                    dbg_log!("[pty-read] read error: {e}");
                    let (lock, cvar) = &*read_state;
                    let mut s = lock.lock();
                    s.error = Some(e.to_string());
                    cvar.notify_one();
                    break;
                }
            }
        }
        dbg_log!("[pty-read] reader thread exit");
    })
}

/// flush スレッドが次に起きるまでの待ち時間を決める純関数。
///
/// `since_last_data` は最後に出力を処理してからの経過時間。
/// 出力が流れている間は短く（バーストをまとめる）、止まっていれば長く
/// （CPU を起こさない）。
fn flush_wait_interval(since_last_data: std::time::Duration) -> std::time::Duration {
    if since_last_data >= FLUSH_IDLE_AFTER {
        FLUSH_IDLE_INTERVAL
    } else {
        FLUSH_ACTIVE_INTERVAL
    }
}

/// 持ち越し pending を lossy で吐き出す（データロス防止）。
fn drain_pending(state: &SharedFlushState, channel: &Channel<PtyEvent>) {
    let (lock, _) = &**state;
    let mut s = lock.lock();
    let remain = std::mem::take(&mut s.pending);
    drop(s);
    if !remain.is_empty() {
        let text = String::from_utf8_lossy(&remain).into_owned();
        let _ = channel.send(PtyEvent::Data { text });
    }
}

/// stop_flag=true で起床したときの後始末。
/// pending + raw を lossy で吐き（UTF-8 境界検証を省略して確実に吐き切る）、
/// 残留 error があればそれを、無ければ Exit を送る。
fn send_shutdown_events(
    channel: &Channel<PtyEvent>,
    pending: Vec<u8>,
    raw: Vec<u8>,
    pending_error: Option<String>,
    exit_code: Option<i32>,
) {
    let mut combined = pending;
    combined.extend_from_slice(&raw);
    if !combined.is_empty() {
        let text = String::from_utf8_lossy(&combined).into_owned();
        let _ = channel.send(PtyEvent::Data { text });
    }

    if let Some(msg) = pending_error {
        dbg_log!("[pty-flush] stop_flag set, sending pending error: {msg}");
        let _ = channel.send(PtyEvent::Error { message: msg });
    } else {
        // shutdown 経由でも Exit を送って Frontend に終了を通知
        // child watcher が検出した実 exit code を優先（kill 経由の場合は None）
        dbg_log!("[pty-flush] stop_flag set after wake, sending Exit code={exit_code:?}");
        let _ = channel.send(PtyEvent::Exit { code: exit_code });
    }
}

/// 停止時の共通処理。溜まっている raw + pending を吐き、Error か Exit を送る。
///
/// flush ループには停止を検出する箇所が「待機前」と「起床後」の 2 つあり、
/// **どちらから抜けても** ここを通す必要がある。待機前のチェックで素通りして
/// break すると、child watcher が exit を検出した直後にちょうどループ先頭へ来た
/// ときだけ Exit イベントが失われ、フロント側でタブが終了扱いにならない。
fn drain_and_shutdown(state: &SharedFlushState, channel: &Channel<PtyEvent>) {
    let (lock, _) = &**state;
    let mut s = lock.lock();
    let raw = std::mem::take(&mut s.raw_buf);
    let pending = std::mem::take(&mut s.pending);
    let pending_error = s.error.take();
    let exit_code = s.exit_code.take();
    drop(s);

    send_shutdown_events(channel, pending, raw, pending_error, exit_code);
}

/// Data イベントを送る。送信に失敗したら false（＝ flush ループを抜ける）。
fn send_data_event(channel: &Channel<PtyEvent>, valid_bytes: Vec<u8>) -> bool {
    if valid_bytes.is_empty() {
        return true;
    }
    let text = match String::from_utf8(valid_bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    dbg_log!("[pty-flush] sending data len={}", text.len());
    if channel.send(PtyEvent::Data { text }).is_err() {
        dbg_log!("[pty-flush] channel send failed, exit");
        return false;
    }
    true
}

/// Condvar.wait_timeout(16ms) で待機し、起床したら raw_buf を drain して
/// UTF-8 検証 → channel.send を行う。
/// read スレッドがブロッキングで止まっていても独立して動作する。
fn spawn_flush_thread(
    flush_state: SharedFlushState,
    channel: Channel<PtyEvent>,
    flush_stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        dbg_log!("[pty-flush] flush loop entered");
        // 最後に出力を処理した時刻。これを基準に待ち時間を切り替える。
        let mut last_data = Instant::now();

        loop {
            if flush_stop.load(Ordering::Relaxed) {
                dbg_log!("[pty-flush] stop_flag set, exit");
                drain_and_shutdown(&flush_state, &channel);
                break;
            }

            // 出力が流れている間は 16ms でバーストをまとめ、止まっている間は
            // 待ちを伸ばして CPU を起こさない。再開は read スレッドの notify で
            // 拾うので、伸ばしても表示は遅れない。
            let timeout = flush_wait_interval(last_data.elapsed());

            let (lock, cvar) = &*flush_state;
            let mut s = lock.lock();
            let _ = cvar.wait_for(&mut s, timeout);

            // stop_flag を再確認（wake 後）
            if flush_stop.load(Ordering::Relaxed) {
                // drain: stop_flag=true でも、溜まっている raw + pending を可能な限り吐き出す
                drop(s);
                drain_and_shutdown(&flush_state, &channel);
                break;
            }

            // raw_buf / eof / error を取り出す
            let raw = std::mem::take(&mut s.raw_buf);
            let eof = s.eof;
            let error = s.error.take();

            if raw.is_empty() && !eof && error.is_none() {
                // 何もなければ次の wait へ。
                // last_data は更新しないので、無出力が続けばアイドル側の待ちに移る。
                continue;
            }

            // 出力を見た。しばらくは 16ms 周期（アクティブ）で回す。
            last_data = Instant::now();

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

            if !send_data_event(&channel, valid_bytes) {
                break;
            }

            // エラー送信
            if let Some(msg) = error {
                // error 送信前に、持ち越し pending を lossy で吐き出す（データロス防止）
                drain_pending(&flush_state, &channel);
                dbg_log!("[pty-flush] sending error: {msg}");
                let _ = channel.send(PtyEvent::Error { message: msg });
                break;
            }

            // EOF: 残余 pending を lossy で吐いて Exit 送信して終了
            if eof {
                dbg_log!("[pty-flush] EOF, sending Exit");
                drain_pending(&flush_state, &channel);
                let _ = channel.send(PtyEvent::Exit { code: None });
                break;
            }
        }
        dbg_log!("[pty-flush] flush thread exit");
    })
}

fn spawn_reader_threads(
    reader: Box<dyn Read + Send>,
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
            exit_code: None,
        }),
        Condvar::new(),
    ));

    // #4 フロー制御: read スレッドの pause 制御（false = 稼働中）
    let read_pause: ReadPause = Arc::new((Mutex::new(false), Condvar::new()));

    let read_handle = spawn_read_thread(
        reader,
        Arc::clone(&flush_state),
        Arc::clone(&stop_flag),
        Arc::clone(&read_pause),
    );
    let flush_handle = spawn_flush_thread(Arc::clone(&flush_state), channel, stop_flag);

    ReaderThreads {
        read_handle,
        flush_handle,
        flush_state,
        read_pause,
    }
}

// ─── child watcher スレッド ──────────────────────────────────────────────────
//
// 子プロセスが自然終了（user typed `exit` など）した際に、master の blocking read が
// EOF を返さない問題（portable_pty / ConPTY 仕様）への対処。
//
// 設計:
//   - 100ms 周期で child.try_wait() をポーリング
//   - Some(ExitStatus) が返ったら:
//     1. exit_code を flush_state に格納
//     2. stop_flag を true にセット
//     3. flush スレッドを cvar で起床
//     4. master を drop して reader の blocking read を EOF で解放
//   - kill 経由（child が他で take 済み）の場合は break して終了
//
// ポーリング間隔は exit 検出のレイテンシとアイドル CPU 負荷のトレードオフで 100ms。
//
// ── 異常終了の網羅性 (Unit P-D2 §2.2 参照) ──────────────────────────────────
//
// 以下の全シナリオで child.try_wait() が Ok(Some(ExitStatus)) を返し、
// 100ms 以内に検出されることを設計上保証する:
//
//   VS01: Ctrl-D (EOF 入力)
//         nushell が EOF を受信して自ら exit(0) → try_wait() で検出
//
//   VS02: [Environment]::Exit(0) (PowerShell)
//         通常の ExitProcess(0) → try_wait() で検出
//
//   VS03: taskkill /F /PID <子プロセスPID>
//         TerminateProcess() (SIGKILL 相当) → try_wait() で検出
//         exit code は通常 1 (taskkill の実装依存)
//
//   VS04: ssh セッション中のネットワーク切断
//         ssh client が SIGHUP/タイムアウトで終了 → try_wait() で検出
//         ssh がハングした場合は P-D1 の 10 秒 spawning タイムアウトがカバー
//
//   VS05: タスクマネージャからの強制終了
//         TerminateProcess() (VS03 と同等) → try_wait() で検出

fn spawn_child_watcher(
    child: SharedChild,
    master: SharedMaster,
    stop_flag: Arc<AtomicBool>,
    flush_state: SharedFlushState,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        dbg_log!("[pty-watch] watcher loop entered");
        let poll_interval = CHILD_POLL_INTERVAL;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                dbg_log!("[pty-watch] stop_flag set, exit");
                break;
            }

            // child を短時間ロックして try_wait
            let exit_code: Option<i32> = {
                let mut child_lock = child.lock();
                match child_lock.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(status)) => {
                            // Windows: exit_code() は u32。i32 に cast（負値ハンドルは滅多にない）
                            Some(status.exit_code() as i32)
                        }
                        Ok(None) => None, // まだ実行中
                        Err(e) => {
                            dbg_log!("[pty-watch] try_wait error: {e}");
                            None
                        }
                    },
                    None => {
                        // kill 経由で child が take 済み。watcher は撤退
                        dbg_log!("[pty-watch] child already taken, exit");
                        break;
                    }
                }
            };

            if let Some(code) = exit_code {
                dbg_log!("[pty-watch] child exited with code {code}");

                // flush_state に exit_code をセット + eof フラグ ON + notify
                let (lock, cvar) = &*flush_state;
                let mut s = lock.lock();
                s.exit_code = Some(code);
                s.eof = true;
                drop(s);

                // stop_flag をセット（read/flush 両スレッドの終了経路に乗せる）
                stop_flag.store(true, Ordering::Relaxed);
                cvar.notify_one();

                // master を drop して reader の blocking read を EOF で解放
                drop(master.lock().take());

                break;
            }

            std::thread::sleep(poll_interval);
        }
        dbg_log!("[pty-watch] watcher exit");
    })
}

// ─── PtyManager ──────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PtyManager {
    sessions: RwLock<HashMap<String, Arc<PtySession>>>,
}

impl PtyManager {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        shell: Option<String>,
        cwd: Option<String>,
        args: Option<Vec<String>>,
        cols: u16,
        rows: u16,
        env: Option<HashMap<String, String>>,
        channel: Channel<PtyEvent>,
    ) -> Result<String, PtyError> {
        // SF-B1: 0 clamp（フロント初期マウント時の 0x0 レイアウトを防御）
        let cols = cols.max(1);
        let rows = rows.max(1);

        dbg_log!("[pty] spawn begin: cols={cols} rows={rows}");

        let shell_path = resolve_shell(shell)?;
        dbg_log!("[pty] shell resolved: {:?}", shell_path);

        let cwd_path = resolve_cwd(cwd);

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
        dbg_log!("[pty] openpty ok");

        // コマンドビルド
        let mut cmd = CommandBuilder::new(&shell_path);
        cmd.cwd(&cwd_path);

        // ハイパーリンク (OSC 8) 対応をシェル内の CLI に知らせる。
        // racker は TERM_PROGRAM 等の既知の識別変数を名乗らないため、
        // supports-hyperlinks 系の判定を使う CLI (Claude Code など) はこれが無いと
        // リンクを出さずプレーンテキストに落とす。xterm.js 側の受け口は
        // linkHandler (src/lib/linkHandler.ts)。
        // ユーザー env 適用より前に置くので、env で FORCE_HYPERLINK=0 を渡せば無効化できる。
        cmd.env("FORCE_HYPERLINK", "1");

        apply_args_and_env(&mut cmd, args, env);

        // TERM / COLORTERM は env 適用後に強制上書きして xterm 互換性を保護する
        // （ユーザーが env で上書きしても racker-terminal 側で正しい値に戻す）
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // プロセス起動
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        dbg_log!("[pty] spawn_command ok");

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
        dbg_log!("[pty] reader + flush threads started");

        // master / child を Arc 化（watcher スレッドと共有するため）
        let master_shared: SharedMaster = Arc::new(Mutex::new(Some(pair.master)));
        let child_shared: SharedChild = Arc::new(Mutex::new(Some(child)));

        // child watcher スレッド起動（子プロセスの自然終了を検出して exit イベントを送る）
        let watch_handle = spawn_child_watcher(
            Arc::clone(&child_shared),
            Arc::clone(&master_shared),
            Arc::clone(&stop_flag),
            Arc::clone(&threads.flush_state),
        );
        dbg_log!("[pty] child watcher thread started");

        // セッション生成
        let id = Uuid::new_v4().to_string();
        dbg_log!("[pty] session id: {id}");
        let session = Arc::new(PtySession::new(PtySessionArgs {
            id: id.clone(),
            writer,
            master: master_shared,
            child: child_shared,
            stop_flag,
            reader_handle: threads.read_handle,
            flush_handle: threads.flush_handle,
            watch_handle,
            flush_state: threads.flush_state,
            read_pause: threads.read_pause,
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

    /// #4 フロー制御: 指定セッションの read スレッドを pause/resume する。
    pub fn set_read_paused(&self, id: &str, paused: bool) -> Result<(), PtyError> {
        let sessions = self.sessions.read();
        let session = sessions
            .get(id)
            .ok_or_else(|| PtyError::SessionNotFound { id: id.to_string() })?;
        session.set_read_paused(paused);
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), PtyError> {
        // sessions から remove して Arc を取得（他に参照がなければ Drop が走る）
        let session = {
            let mut sessions = self.sessions.write();
            sessions
                .remove(id)
                .ok_or_else(|| PtyError::SessionNotFound { id: id.to_string() })?
        };
        session.kill();
        Ok(())
    }
}

// ─── Tauri commands ──────────────────────────────────────────────────────────
//
// すべて `#[tauri::command(async)]` にしてある。**この (async) は必須**。
//
// Tauri v2 では async の付かない command は**メインスレッド**で実行される。
// メインスレッドは Windows のメッセージループそのものなので、そこで PTY の
// 生成・破棄・書き込みのようにブロックしうる処理を行うと、その間ウィンドウが
// 一切描画も入力受付もできなくなり、数秒続けば OS に「応答なし」と判定されて
// 強制終了される (WER: AppHang XProcB1 / OpenConsole.exe)。
//
// `(async)` を付けると同期関数のまま async_runtime のワーカースレッドで実行される。
// State<'_, PtyManager> もそのまま使えるので、シグネチャは変えなくてよい。

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    state: tauri::State<PtyManager>,
    shell: Option<String>,
    cwd: Option<String>,
    args: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    env: Option<std::collections::HashMap<String, String>>,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    state
        .spawn(shell, cwd, args, cols, rows, env, on_event)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_write(state: tauri::State<PtyManager>, id: String, data: String) -> Result<(), String> {
    state.write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_resize(
    state: tauri::State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_kill(state: tauri::State<PtyManager>, id: String) -> Result<(), String> {
    state.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_set_read_paused(
    state: tauri::State<PtyManager>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    state
        .set_read_paused(&id, paused)
        .map_err(|e| e.to_string())
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

    // ─── back-pressure ロジックの単体テスト ──────────────────────────────────
    //
    // back-pressure のロジックを純関数として切り出しテストする。
    // 実際の read スレッドは blocking I/O を伴うため直接テストは困難なため、
    // ロジック部分を別関数に委譲してテストする。

    /// back-pressure チェックを適用するヘルパー（テスト用）。
    /// raw_buf が RAW_BUF_LIMIT_BYTES を超えたら古い半分を破棄し、マーカーを挿入する。
    /// 実際の read スレッドと同じロジックを再現。
    fn apply_back_pressure(raw_buf: &mut Vec<u8>, limit: usize) {
        if raw_buf.len() > limit {
            let drain_len = raw_buf.len() / 2;
            raw_buf.drain(0..drain_len);
            raw_buf.extend_from_slice(b"\r\n[output truncated]\r\n");
        }
    }

    #[test]
    fn back_pressure_triggers_when_over_limit() {
        // 上限を小さく設定してテストする
        let limit = 1024;
        let mut buf = vec![b'A'; limit + 1]; // 上限 +1 で超過させる
        apply_back_pressure(&mut buf, limit);
        // 古い半分が破棄されていること
        assert!(buf.len() < limit + 1);
        // マーカーが含まれていること
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("[output truncated]"));
    }

    #[test]
    fn back_pressure_no_op_under_limit() {
        let limit = 1024;
        let mut buf = vec![b'A'; limit]; // ちょうど上限、超過なし
        let original_len = buf.len();
        apply_back_pressure(&mut buf, limit);
        // 変化なし
        assert_eq!(buf.len(), original_len);
    }

    #[test]
    fn back_pressure_drains_half_and_inserts_marker() {
        let limit = 100;
        // 5MB 相当を模擬するかわりに、limit の 2 倍で確実に half drain を検証する
        let mut buf = vec![b'X'; limit + 50]; // limit = 100, len = 150
        apply_back_pressure(&mut buf, limit);
        // drain_len = 150 / 2 = 75。残り 75 + マーカー長
        let marker = b"\r\n[output truncated]\r\n";
        assert!(buf.ends_with(marker));
        // 先頭 75 バイトは破棄されているため X が続くはず（75 バイト残 + マーカー）
        let x_count = buf.iter().filter(|&&b| b == b'X').count();
        assert_eq!(x_count, 75);
    }

    // ─── flush スレッドの待ち時間 ────────────────────────────────────────────
    //
    // ここはアイドル時の消費電力に直結する。出力が止まっている間まで 16ms で
    // 起き続けると、タブ 1 つにつき毎秒 62.5 回 CPU を起こすことになる。

    #[test]
    fn flush_waits_briefly_while_output_is_flowing() {
        // 直前まで出力があった → バーストをまとめるため短い窓で回る
        let t = flush_wait_interval(std::time::Duration::from_millis(0));
        assert_eq!(t, FLUSH_ACTIVE_INTERVAL);
    }

    #[test]
    fn flush_stays_active_just_before_the_idle_threshold() {
        let t = flush_wait_interval(FLUSH_IDLE_AFTER - std::time::Duration::from_millis(1));
        assert_eq!(t, FLUSH_ACTIVE_INTERVAL);
    }

    #[test]
    fn flush_backs_off_once_output_stops() {
        // 出力が止まったら待ちを伸ばす。ここが伸びないとアイドルで電力を食う。
        let t = flush_wait_interval(FLUSH_IDLE_AFTER);
        assert_eq!(t, FLUSH_IDLE_INTERVAL);
    }

    #[test]
    fn flush_stays_backed_off_while_idle_continues() {
        let t = flush_wait_interval(std::time::Duration::from_secs(60));
        assert_eq!(t, FLUSH_IDLE_INTERVAL);
    }

    #[test]
    fn idle_interval_is_much_longer_than_active() {
        // 「アイドルのほうが長い」という関係が崩れたら省電力の意味が無くなる。
        // 具体値ではなく関係を固定する。
        assert!(
            FLUSH_IDLE_INTERVAL >= FLUSH_ACTIVE_INTERVAL * 10,
            "アイドル時の待ちが短すぎる: idle={FLUSH_IDLE_INTERVAL:?} active={FLUSH_ACTIVE_INTERVAL:?}"
        );
    }

    #[test]
    fn idle_wakeups_per_second_stay_small() {
        // アイドル時の起床回数（1 タブあたり毎秒）。8 タブ開いても
        // 二桁に収まる範囲に留める。
        let wakeups_per_sec = 1.0 / FLUSH_IDLE_INTERVAL.as_secs_f64();
        assert!(
            wakeups_per_sec <= 2.0,
            "アイドル時に毎秒 {wakeups_per_sec} 回起きている"
        );
    }

    #[test]
    fn child_poll_is_not_a_busy_loop() {
        // 子プロセスの終了確認もアイドル時に効く。人が知覚できる速さで足りる。
        assert!(CHILD_POLL_INTERVAL >= std::time::Duration::from_millis(250));
        assert!(CHILD_POLL_INTERVAL <= std::time::Duration::from_secs(1));
    }

    #[test]
    fn back_pressure_constants_sanity() {
        // 定数が期待値であることを確認する（値の変更検知）
        assert_eq!(RAW_BUF_LIMIT_BYTES, 4 * 1024 * 1024);
        assert_eq!(TINY_READ_THRESHOLD, 256);
        assert_eq!(TINY_READ_MIN_INTERVAL, std::time::Duration::from_millis(2));
    }

    // ─── args パラメータのコンパイル確認テスト ──────────────────────────────────
    //
    // PtyManager::spawn の args 引数が正しく型付けされていることを確認する。
    // portable_pty の CommandBuilder は内部状態を直接検査しづらいため、
    // 「None / Some(vec![]) を渡してもコンパイルエラーにならない」レベルで確認する。
    // 実際のプロセス起動を伴うテストは E2E で確認する。

    /// args の型が Option<Vec<String>> であることのコンパイルテスト。
    /// PtyManager を使わず型シグネチャだけ確認する純粋な型テスト。
    #[test]
    fn args_none_is_valid_option() {
        let args: Option<Vec<String>> = None;
        // None を渡した場合は空引数と同等（args がなければ for ループが実行されないだけ）
        if let Some(ref v) = args {
            assert!(v.is_empty(), "None の場合はここには来ない");
        } else {
            // None のケース: 引数なしを意味する
            assert!(args.is_none());
        }
    }

    #[test]
    fn args_empty_vec_skips_all() {
        // Some(vec![]) を渡した場合、フィルタ後の実際の arg 追加は 0 件
        let args_vec: Vec<String> = vec![];
        let added: Vec<&String> = args_vec.iter().filter(|a| !a.is_empty()).collect();
        assert!(added.is_empty(), "空 vec の場合は arg 追加なし");
    }

    #[test]
    fn args_empty_strings_are_skipped() {
        // 空文字列要素はスキップされる
        let args_vec: Vec<String> = vec!["".to_string(), "".to_string()];
        let added: Vec<&String> = args_vec.iter().filter(|a| !a.is_empty()).collect();
        assert!(added.is_empty(), "空文字列のみの vec は arg 追加なし");
    }

    #[test]
    fn args_valid_entries_pass_through() {
        // 有効なエントリはフィルタを通過する
        let args_vec: Vec<String> = vec!["--cd".to_string(), "~".to_string()];
        let added: Vec<&String> = args_vec.iter().filter(|a| !a.is_empty()).collect();
        assert_eq!(added.len(), 2);
        assert_eq!(added[0].as_str(), "--cd");
        assert_eq!(added[1].as_str(), "~");
    }
}

// ─── PTY 統合テスト ──────────────────────────────────────────────────────────
//
// read / flush スレッドの協調動作を実 PTY で検証する。
// 純粋関数のテストでは spawn → 出力 → kill の一連の流れを担保できないため、
// Channel を直接生成して PtyManager をエンドツーエンドで動かす。
//
// これらは以前 #[ignore] にしてあった。Windows でテストプロセスがハングしたためだが、
// 原因は 2 つあり、どちらも解消したので既定で走らせている:
//
//   1. PtySession::Drop がスレッドの join を呼び出し元スレッドで行っていた。
//      ConPTY では join が返らないことがあり、テストプロセスごと止まっていた。
//      → 後始末は reaper スレッドへ委譲するようにした (PtySession::reap 参照)。
//      これは製品コードでも同じ問題を起こしていた: Tauri command はメインスレッドで
//      実行されるため、タブを閉じるたびに UI が固まるリスクを抱えていた。
//
//   2. ConPTY の DSR-CPR (`ESC[6n`) に誰も応答しないため、シェルが入力を処理せず
//      echo が返ってこなかった。テストがハングしているように見えていた本体。
//      → answer_dsr() で応答を返すようにした。
//
// この 2 つは実際に本番のフリーズを検出できる経路なので、CI で常時走らせる価値が高い。
#[cfg(test)]
mod pty_integration_tests {
    use super::*;
    use std::sync::mpsc;
    use tauri::ipc::InvokeResponseBody;

    /// テスト用シェル。どちらも `echo <文字列>` が使える。
    fn test_shell() -> String {
        if cfg!(windows) {
            "cmd.exe".to_string()
        } else {
            "/bin/sh".to_string()
        }
    }

    /// PtyEvent を受け取って JSON 文字列で流す Channel と、その受信側を作る。
    fn probe_channel() -> (Channel<PtyEvent>, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel::<String>();
        let tx = Mutex::new(tx);
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(s) = body {
                let _ = tx.lock().send(s);
            }
            Ok(())
        });
        (channel, rx)
    }

    /// deadline まで受信し続け、`needle` を含む出力が来たら true。
    ///
    /// 実出力を待つ箇所では 30 秒と長めに取っている。これは「30 秒かかってよい」
    /// という意味ではなく、**混雑したマシンでも誤検知しない**ための上限。
    /// 正常時は数十 ms で返るので、伸ばしても通常のテスト時間には影響しない。
    /// (実測: CPU を埋めた状態だと実プロセスの echo 往復が秒単位まで伸びる)
    fn wait_for(rx: &mpsc::Receiver<String>, needle: &str, secs: u64) -> (bool, String) {
        let deadline = Instant::now() + std::time::Duration::from_secs(secs);
        let mut seen = String::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(msg) => {
                    seen.push_str(&msg);
                    if seen.contains(needle) {
                        return (true, seen);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        (false, seen)
    }

    /// ConPTY は起動直後にカーソル位置問い合わせ (DSR-CPR = `ESC[6n`) を出し、
    /// **応答が返るまでシェルへの入力が処理されない**。実アプリでは xterm が
    /// 自動で応答するが、テストには端末がいないので自分で返してやる必要がある。
    /// これを送らないと、以降の write が一切エコーされない。
    fn answer_dsr(mgr: &PtyManager, id: &str) {
        let _ = mgr.write(id, "\x1b[1;1R");
    }

    /// テストプロセスから生えた PTY を、テストバイナリの終了と道連れにする。
    /// **PTY を起動するテストの先頭で呼ぶこと。**
    ///
    /// `settle()` で待っても、ClosePseudoConsole が返らないぶんは残る。実測では
    /// 1 回の `cargo test` で ConPTY のホストプロセスが 10 個前後積み上がっていた。
    /// アプリ本体と同じ Job Object に入れて、OS に片付けさせる (job.rs 参照)。
    ///
    /// 道連れになるのはこのテストバイナリの子孫だけで、`cargo` 自身は Job の外にいる。
    fn confine_test_process() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = crate::job::confine_descendants();
        });
    }

    /// PTY を起動するテストを直列化するためのロック。
    ///
    /// リーク検査 (`open_close_does_not_leak_*`) はプロセス数やハンドル数という
    /// **プロセス全体で共有された値**を見る。並行して PTY を開くテストがあると、
    /// その分が測定値に混ざって判定が壊れる。
    ///
    /// 実行時間への影響はほぼない (PTY テスト全体で数秒)。
    static PTY_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// PTY を使うテストの共通の入り口。ロックを取り、Job への割り当てを済ませる。
    ///
    /// 戻り値のガードを**テストの最後まで持ち続けること** (`let _guard = ...`)。
    /// `let _ = ...` と書くと即座に解放されて直列化されない。
    fn pty_test_guard() -> parking_lot::MutexGuard<'static, ()> {
        confine_test_process();
        PTY_TEST_LOCK.lock()
    }

    /// 後始末が捌けるのを待つ。**テストの最後に呼ぶこと。**
    ///
    /// 後始末は別スレッドで走るので、待たずにテストプロセスが終了すると
    /// シェルが停止しないまま取り残される。
    ///
    /// **完了は assert しない。** ConPTY の ClosePseudoConsole は、起動直後の
    /// セッションを閉じたときなど返ってこないことがあり、そこは racker 側では
    /// どうにもできない。ここでの待ちは「捌けるぶんは捌かせる」ための best-effort で、
    /// 取りこぼしは `confine_test_process` の Job Object が受け止める。
    fn settle() {
        let _ = wait_for_reapers(std::time::Duration::from_secs(3));
    }

    /// spawn → write → 出力受信 → kill が一通り動くこと。
    /// read スレッドと flush スレッドが実際に協調して Data イベントを届けられるかを見る。
    #[test]
    fn spawn_write_read_kill_roundtrip() {
        let (channel, rx) = probe_channel();
        let _guard = pty_test_guard();
        let mgr = PtyManager::default();

        let id = mgr
            .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
            .expect("spawn できること");

        answer_dsr(&mgr, &id);
        mgr.write(&id, "echo racker_probe_marker\r\n")
            .expect("write できること");

        let (found, seen) = wait_for(&rx, "racker_probe_marker", 30);
        assert!(
            found,
            "echo の出力が Data イベントで届かない。受信内容: {seen}"
        );

        mgr.kill(&id).expect("kill できること");
        settle();
    }

    /// **アイドルが続いた後でも、最初の出力がすぐ届くこと。**
    ///
    /// flush スレッドは出力が止まると待ちを 1 秒へ伸ばす（省電力のため）。
    /// このとき、出力再開をタイマー任せにすると最初の 1 文字が最大 1 秒遅れ、
    /// 「キーを打っても表示されない」状態になる。
    /// 再開は read スレッドからの notify で拾う設計なので、それが効いているかを見る。
    ///
    /// この経路が壊れると省電力と引き換えに体感がはっきり悪くなるため、
    /// 遅延を測って確かめる。
    /// （notify を外して実際に約 1.05 秒へ悪化することを確認済み）
    ///
    /// **絶対値ではなく「アクティブ時との差」で判定する。** 実プロセスの
    /// echo 往復はマシンの負荷でぶれるため、絶対値の閾値だと混雑時に誤検知する。
    /// 負荷は両方の測定に等しく乗るので、差を見れば load に左右されずに
    /// 「タイマー待ちに引きずられたか」だけを判別できる。
    #[test]
    fn output_is_prompt_even_after_going_idle() {
        let (channel, rx) = probe_channel();
        let _guard = pty_test_guard();
        let mgr = PtyManager::default();

        let id = mgr
            .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
            .expect("spawn できること");

        answer_dsr(&mgr, &id);
        // 起動直後の出力を捨てて、静かな状態にする
        let _ = wait_for(&rx, "___never___", 2);
        while rx.try_recv().is_ok() {}

        /// echo を 1 往復させて所要時間を返す
        fn echo_latency(
            mgr: &PtyManager,
            id: &str,
            rx: &mpsc::Receiver<String>,
            marker: &str,
        ) -> std::time::Duration {
            let started = Instant::now();
            mgr.write(id, &format!("echo {marker}\r\n"))
                .expect("write できること");
            let (found, seen) = wait_for(rx, marker, 30);
            assert!(found, "{marker} の出力が届かない。受信内容: {seen}");
            started.elapsed()
        }

        // 1) アクティブ状態（直前まで出力があった）での往復時間。これが基準。
        let active = echo_latency(&mgr, &id, &rx, "active_marker");
        while rx.try_recv().is_ok() {}

        // 2) flush スレッドがアイドル判定に入るまで待ってから、同じことをする
        std::thread::sleep(FLUSH_IDLE_AFTER + std::time::Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        let idle = echo_latency(&mgr, &id, &rx, "idle_wake_marker");

        // notify が効いていれば両者はほぼ同じ。効いていなければアイドル側だけ
        // タイマー待ち(FLUSH_IDLE_INTERVAL) のぶん遅れる。
        let allowed = active + FLUSH_IDLE_INTERVAL / 2;
        assert!(
            idle < allowed,
            "アイドル後の初回出力が遅い: idle={idle:?} / active={active:?} (許容 {allowed:?})。\
             read スレッドからの notify が効かず、flush のタイマー待ち\
             ({FLUSH_IDLE_INTERVAL:?}) に引きずられている疑いがある"
        );

        mgr.kill(&id).expect("kill できること");
        settle();
    }

    /// `kill()` が呼び出し元スレッドをブロックせずに返ること。
    ///
    /// **この 1 件は他のテストと性質が違う。番人として置いてある。**
    /// Tauri の command はメインスレッド (= Windows のメッセージループ) で実行される
    /// ため、ここが返らなくなるとタブを閉じるたびにウィンドウが固まり、数秒続けば
    /// OS に「応答なし」と判定されて強制終了される。実際 v1.8.0 まではそうなっていた
    /// (WER: AppHang XProcB1 / OpenConsole.exe)。
    ///
    /// 後始末そのもの (child.wait / master drop / join) は ConPTY 相手だと数秒かかる
    /// ことがあり、それ自体は避けられない。避けるべきは**呼び出し元で待つこと**なので、
    /// 所要時間だけを検証する。
    #[test]
    fn kill_does_not_block_the_caller() {
        let (channel, _rx) = probe_channel();
        let _guard = pty_test_guard();
        let mgr = PtyManager::default();

        let id = mgr
            .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
            .expect("spawn できること");

        let started = Instant::now();
        mgr.kill(&id).expect("kill できること");
        let elapsed = started.elapsed();

        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "kill() が {elapsed:?} ブロックした。後始末を reaper スレッドへ逃がさずに \
             呼び出し元で待つと、メインスレッドが止まり UI ごとフリーズする"
        );

        // 呼び出し元は待たないが、後始末そのものは最後まで走り切る必要がある。
        // ここで待たずに終わると ConPTY のホストが孤児として残る。
        settle();
    }

    /// タブの開閉を繰り返してもフロント側の呼び出しが詰まらないこと。
    ///
    /// 報告されていたフリーズは「しばらく使っていると」発生していた。タブの開閉は
    /// spawn → kill の繰り返しであり、1 回あたりの後始末がわずかでも呼び出し元を
    /// 待たせると、回数を重ねるうちにメインスレッドの占有時間が積み上がる。
    /// spawn/kill を連続で回して、合計時間が現実的な範囲に収まることを見る。
    #[test]
    fn repeated_open_close_does_not_pile_up() {
        const ROUNDS: usize = 10;
        // **kill の所要時間だけを積算する。**
        // ループ全体を測ると spawn（実プロセスの起動）が混ざり、マシンの負荷で
        // 大きくぶれる。ここで見たいのは「後始末が呼び出し元を待たせないか」だけ
        // なので、spawn の時間は測定対象から外す。
        let budget = std::time::Duration::from_millis(200) * ROUNDS as u32;

        let _guard = pty_test_guard();
        let mgr = PtyManager::default();
        let mut total_kill = std::time::Duration::ZERO;

        for _ in 0..ROUNDS {
            let (channel, _rx) = probe_channel();
            let id = mgr
                .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
                .expect("spawn できること");

            let started = Instant::now();
            mgr.kill(&id).expect("kill できること");
            total_kill += started.elapsed();
        }

        assert!(
            total_kill < budget,
            "kill を {ROUNDS} 回で合計 {total_kill:?} かかった (上限 {budget:?})。\
             後始末が呼び出し元をブロックしている疑いがある"
        );

        settle();
    }

    /// 子プロセスが自然終了したときに Exit イベントが届くこと。
    /// flush スレッドの EOF / shutdown 経路を通す。
    #[test]
    fn exit_event_is_delivered_on_shell_exit() {
        let (channel, rx) = probe_channel();
        let _guard = pty_test_guard();
        let mgr = PtyManager::default();

        let id = mgr
            .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
            .expect("spawn できること");

        answer_dsr(&mgr, &id);
        mgr.write(&id, "exit\r\n").expect("write できること");

        let (found, seen) = wait_for(&rx, "\"type\":\"exit\"", 30);
        drop(mgr); // シェルは自然終了しているが、セッションの後始末は Drop 経由で走る
        settle();
        assert!(
            found,
            "シェル終了後に Exit イベントが届かない。受信内容: {seen}"
        );
    }

    /// マルチバイト出力が UTF-8 境界で壊れないこと。
    /// flush スレッドの split_at_utf8_boundary / pending 持ち越しを通す。
    #[test]
    fn multibyte_output_is_not_corrupted() {
        let (channel, rx) = probe_channel();
        let _guard = pty_test_guard();
        let mgr = PtyManager::default();

        let id = mgr
            .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
            .expect("spawn できること");

        answer_dsr(&mgr, &id);
        mgr.write(&id, "echo 日本語テスト文字列\r\n")
            .expect("write できること");

        let (found, seen) = wait_for(&rx, "日本語テスト文字列", 30);
        assert!(found, "マルチバイト出力が復元できない。受信内容: {seen}");
        assert!(
            !seen.contains('\u{FFFD}'),
            "置換文字 U+FFFD が混入している（UTF-8 境界処理の破綻）: {seen}"
        );

        mgr.kill(&id).expect("kill できること");
        settle();
    }

    /// pause / resume を往復してもデータが失われず、read スレッドが復帰すること。
    /// #4 フロー制御（wait_while_paused）の経路を通す。
    #[test]
    fn read_pause_and_resume_does_not_lose_output() {
        let (channel, rx) = probe_channel();
        let _guard = pty_test_guard();
        let mgr = PtyManager::default();

        let id = mgr
            .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
            .expect("spawn できること");

        answer_dsr(&mgr, &id);
        mgr.set_read_paused(&id, true).expect("pause できること");
        mgr.write(&id, "echo after_pause_marker\r\n")
            .expect("write できること");
        std::thread::sleep(std::time::Duration::from_millis(300));
        mgr.set_read_paused(&id, false).expect("resume できること");

        let (found, seen) = wait_for(&rx, "after_pause_marker", 30);
        assert!(found, "resume 後に出力が届かない。受信内容: {seen}");

        mgr.kill(&id).expect("kill できること");
        settle();
    }

    // ─── リソースリークの検査 ───────────────────────────────────────────────
    //
    // ここが壊れると「動くけれど閉じたものが片付かない」状態になり、使っている
    // あいだ静かにマシンを圧迫する。実際 ConPTY のホストプロセスが 92 個まで
    // 積み上がったことがあり、テストが無かったので気付けなかった。
    //
    // 閾値は**明らかな異常だけを捕まえる**幅にしてある。CI のランナーは負荷が高く、
    // OS のハンドル解放にも遅れがあるため、厳しくすると偽陽性で信用を失う。
    // リークが起きていれば開閉の回数に比例して増えるので、緩くても取り逃さない。

    /// リーク検査で PTY を開閉する回数。
    ///
    /// リークがあれば「回数 × 1 セッション分」が積み上がるので、多いほど
    /// ノイズとの差が開く。10 回で 3 秒程度に収まる。
    const LEAK_ROUNDS: usize = 10;

    /// PTY を開いて閉じる、を `LEAK_ROUNDS` 回繰り返す。
    ///
    /// ⚠️ **既知の制約**: シェルが動き出す前 (DSR-CPR に応答する前) に閉じると、
    /// ConPTY の `ClosePseudoConsole` が返らず、そのセッションのホストプロセスは
    /// アプリが終了するまで残る (実測で 10 回中 7 回)。ConPTY 側の挙動なので
    /// racker からは回避できず、終了時に Job Object が回収する形で受けている。
    /// ここでは実アプリと同じ「応答してから閉じる」経路を測る。
    fn churn_ptys(mgr: &PtyManager) {
        churn_ptys_inner(mgr, true);
    }

    /// `settled` が false のときは、シェルが動き出すのを待たずに閉じる。
    ///
    /// ConPTY は起動直後にカーソル位置問い合わせ (DSR-CPR) を出し、応答が返るまで
    /// 動き出さない。その状態で閉じるのが、後始末が返らなくなる一番きつい経路。
    /// 実アプリでもタブを開いた直後に閉じれば同じ状況になる。
    fn churn_ptys_inner(mgr: &PtyManager, settled: bool) {
        for _ in 0..LEAK_ROUNDS {
            let (channel, rx) = probe_channel();
            let id = mgr
                .spawn(Some(test_shell()), None, None, 80, 24, None, channel)
                .expect("spawn できること");

            if settled {
                answer_dsr(mgr, &id);
                let _ = wait_for(&rx, ">", 10);
            }

            mgr.kill(&id).expect("kill できること");
        }
        settle();
    }

    #[test]
    #[cfg_attr(not(windows), ignore = "Job Object は Windows 固有")]
    fn open_close_does_not_leak_processes() {
        let _guard = pty_test_guard();
        let Some(before) = crate::job::assigned_process_count() else {
            // Job に入れられない環境では検査できない。テストを失敗にはしない
            // (アプリ側も Job 無しで動作する設計のため)。
            eprintln!("[leak] Job Object が使えないためプロセス数の検査をスキップ");
            return;
        };

        let mgr = PtyManager::default();
        churn_ptys(&mgr);

        let after = crate::job::assigned_process_count().expect("2 回目も数えられること");
        // 正常時は開閉したぶんがすべて消えて元の数に戻る。閉じきれなかった
        // シェルや ConPTY のホストがいれば、その数だけ残る。
        assert!(
            after <= before + LEAK_PROCESS_SLACK,
            "PTY を {LEAK_ROUNDS} 回開閉したあと Job 内のプロセスが {before} → {after} に増えた。             シェルまたは ConPTY のホストが片付いていない疑いがある"
        );
    }

    /// プロセス数の許容増加。
    ///
    /// 正常時は 0。後始末が走りきる前に settle() を抜けた 1 件ぶんを見込んで
    /// 少しだけ余裕を持たせる。リークすれば `LEAK_ROUNDS` (=10) 増えるので、
    /// この幅でも取り逃さない。
    const LEAK_PROCESS_SLACK: usize = 3;

    /// ハンドル数の許容増加。
    ///
    /// 実測では開閉を繰り返しても数個しか動かない。ランナーの負荷や OS の
    /// 遅延解放を吸収できるだけの幅を取っている。ハンドルを取りこぼしていれば
    /// 1 セッションあたり数個ずつ増えるため、10 回で数十増えて確実に超える。
    const LEAK_HANDLE_SLACK: usize = 50;

    /// タブを開いた直後に閉じても、シェルと ConPTY のホストが残らないこと。
    ///
    /// ConPTY は起動直後の DSR-CPR に応答が返るまで動き出さず、その状態で
    /// 閉じると `ClosePseudoConsole` が返らない。**後始末が返らないと
    /// ホストプロセスはアプリ終了まで残る**ので、開いてすぐ閉じる操作を
    /// 繰り返すとその数だけ積み上がっていく。
    #[test]
    #[cfg_attr(not(windows), ignore = "Job Object は Windows 固有")]
    fn closing_immediately_after_spawn_does_not_leak() {
        let _guard = pty_test_guard();
        let Some(before) = crate::job::assigned_process_count() else {
            eprintln!("[leak] Job Object が使えないためプロセス数の検査をスキップ");
            return;
        };

        let mgr = PtyManager::default();
        churn_ptys_inner(&mgr, false);

        let after = crate::job::assigned_process_count().expect("2 回目も数えられること");
        assert!(
            after <= before + LEAK_PROCESS_SLACK,
            "起動直後に閉じる操作を {LEAK_ROUNDS} 回繰り返したあと、             Job 内のプロセスが {before} → {after} に増えた。             ClosePseudoConsole が返らずホストプロセスが残っている疑いがある"
        );
    }

    #[test]
    #[cfg_attr(not(windows), ignore = "ハンドル数は Windows 固有")]
    fn open_close_does_not_leak_handles() {
        let _guard = pty_test_guard();
        let Some(before) = crate::job::handle_count() else {
            eprintln!("[leak] ハンドル数を取得できないため検査をスキップ");
            return;
        };

        let mgr = PtyManager::default();
        churn_ptys(&mgr);

        let after = crate::job::handle_count().expect("2 回目も数えられること");
        assert!(
            after <= before + LEAK_HANDLE_SLACK,
            "PTY を {LEAK_ROUNDS} 回開閉したあとハンドルが {before} → {after} に増えた。             パイプ・プロセス・PTY のハンドルを取りこぼしている疑いがある"
        );
    }
}
