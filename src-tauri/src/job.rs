//! PTY から生えたプロセスを、アプリの終了と道連れにするための Job Object。
//!
//! ## 何を解決するか
//!
//! ターミナルのタブ 1 枚につき、ConPTY のホストプロセス (OpenConsole.exe) と
//! シェルが 1 つずつ起動する。これらは racker の子孫だが、**親が死んでも
//! OS は片付けてくれない**。実測では、後始末をせずに終了したあと
//! OpenConsole とシェルがそのまま残り続けた (13 秒後も生存)。
//!
//! 通常の終了では `PtySession::reap` が後始末をするが、
//!
//! - ConPTY の `ClosePseudoConsole` が返らず後始末が終わらない
//! - フリーズしてタスクマネージャから強制終了された
//! - クラッシュした
//!
//! といった場合には後始末が最後まで走らない。実際、これで OpenConsole が
//! 数十個単位で積み上がっていた。
//!
//! ## どう解決するか
//!
//! 自プロセスを `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` を立てた Job Object に入れる。
//! 子プロセスは Job を自動的に受け継ぐので、PTY 経由で起動したシェルも
//! ConPTY のホストも同じ Job に入る。**プロセスが死ぬと Job ハンドルが閉じ、
//! OS が Job 内のプロセスをまとめて終了させる。** 強制終了やクラッシュでも効く
//! (ハンドルを閉じるのは OS なので、こちらのコードが動く必要がない)。
//!
//! 実測 (examples での検証): Job なしで PTY を 3 本開いたまま終了すると
//! OpenConsole とシェルが 3 組残ったが、Job ありでは 1 つも残らなかった。
//!
//! ## 副作用
//!
//! **racker を閉じると、タブで動かしていたプロセスは確実に終了する。**
//! これまでは後始末が間に合わなければ生き残ることがあったが、その挙動はなくなる。
//! ターミナルとしては期待される動作であり、残ったプロセスを手で探して
//! 止める手間もなくなる。バックグラウンドで生かし続けたいものは、
//! タブの中ではなくサービスやタスクスケジューラへ置くこと。
//!
//! **アプリから起動するプロセスも、そのままでは道連れの対象になる。** 実際、
//! 自動更新のインストーラがこれで起動した瞬間に殺され、v1.9.2 → v1.9.3 の更新が
//! 無言で失敗し続けた (updater プラグインはインストーラを起動した直後に
//! `std::process::exit(0)` するため、Job ハンドルが閉じて中身ごと終了させられる)。
//! アプリより長生きさせたいプロセスを起動する前には `allow_process_breakaway` を
//! 呼ぶこと。

#[cfg(windows)]
mod imp {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    /// 生成した Job のハンドルを保持しておくための置き場。
    ///
    /// **ハンドルを閉じてはいけない。** 閉じた時点で
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` が発動し、自分もろとも終了する。
    /// プロセスが死ぬときに OS が閉じるのが、まさに狙った動作。
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

    /// Job の制限フラグを差し替える。プロセスを入れたあとでも呼べる。
    ///
    /// 成功したら `true`。
    pub fn set_limit_flags(job: HANDLE, flags: u32) -> bool {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = flags;
        let Ok(size) = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()) else {
            return false;
        };
        // SAFETY: job は呼び出し側が持つ有効なハンドル。info は上で初期化済みで、
        // 渡すサイズもその構造体そのもの。
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                size,
            ) != 0
        }
    }

    /// 「閉じたら中のプロセスを皆殺しにする」Job を作る。
    ///
    /// 作成と設定だけを行い、プロセスの割り当てはしない
    /// (テストから安全に呼べるようにするため。割り当ててしまうと、
    /// テストランナー自身がこの Job に入ってしまう)。
    ///
    /// 失敗したら `None`。Job が使えない環境でもアプリは動くべきなので、
    /// 呼び出し側はエラーとして扱わないこと。
    pub fn create_kill_on_close_job() -> Option<HANDLE> {
        // SAFETY: 引数の妥当性だけが要件の Win32 呼び出し。
        // ハンドルは失敗時 null が返るのでその場で判定している。
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }

        if !set_limit_flags(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) {
            // 中身が空の Job なので、閉じても巻き添えは出ない。
            // SAFETY: 自分で作ったハンドルを 1 度だけ閉じる。
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return None;
        }
        Some(job)
    }

    /// 以降に起動する子プロセスを Job に入れないようにする
    /// (`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` を足す)。
    ///
    /// **更新インストーラのためだけの措置。** updater プラグインは Windows では
    /// インストーラを `ShellExecuteW` で起動した直後に `std::process::exit(0)` する。
    /// インストーラは racker の子なので何もしなければこの Job に自動編入され、
    /// 直後の終了で `KILL_ON_JOB_CLOSE` が発動して**起動した瞬間に道連れで殺される**
    /// (実際にこれで v1.9.2 → v1.9.3 の自動更新が無言で失敗し続けた)。
    ///
    /// 既に Job に入っているプロセス (PTY のシェルと ConPTY のホスト) はそのまま残り、
    /// 終了時に道連れになる。更新のためにアプリを閉じる場面なので、それでよい。
    ///
    /// Job を用意できていなければ `false`。
    pub fn allow_breakaway() -> bool {
        let Some(job) = JOB.get() else {
            return false;
        };
        set_limit_flags(
            *job as HANDLE,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
        )
    }

    /// `allow_breakaway` を取り消し、子プロセスの自動編入を元に戻す。
    ///
    /// インストーラの起動に失敗してアプリが生き残ったときに呼ぶ。緩めたままだと、
    /// そのあと開いたタブのシェルが Job に入らず孤児になりうる。
    pub fn confine_again() -> bool {
        let Some(job) = JOB.get() else {
            return false;
        };
        set_limit_flags(*job as HANDLE, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    }

    /// Job に入っているプロセスの数を返す (自プロセスを含む)。
    ///
    /// **リソースリークの検査に使う。** PTY を開いて閉じたあと、この数が元に戻れば
    /// シェルも ConPTY のホストも片付いたことになる。Job の中だけを数えるので、
    /// 同じマシンで他のターミナルが動いていても影響を受けない。
    ///
    /// Job に入れていない場合 (`confine_current_process` を呼んでいない・失敗した)
    /// は `None`。
    #[cfg(test)]
    pub fn assigned_process_count() -> Option<usize> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
        };

        let job = *JOB.get()? as HANDLE;

        // 可変長構造体。プロセス ID の一覧までは要らないが、API はまとめて返そうと
        // するのでバッファを持たせる。足りなければ戻り値は 0 になるものの、
        // 先頭の NumberOfAssignedProcesses は書き込まれるのでそれを読む。
        let mut buf = vec![0u8; 8 * 1024];
        let mut returned = 0u32;
        // SAFETY: buf は下の read_unaligned が読む範囲より十分大きく、
        // 構造体の先頭 2 フィールドは API が必ず埋める。
        unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr().cast(),
                u32::try_from(buf.len()).ok()?,
                &raw mut returned,
            );
            let list = buf
                .as_ptr()
                .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
                .read_unaligned();
            usize::try_from(list.NumberOfAssignedProcesses).ok()
        }
    }

    /// 自プロセスが握っているカーネルハンドルの数を返す。
    ///
    /// **リソースリークの検査に使う。** PTY の開閉でパイプやプロセスのハンドルを
    /// 取りこぼしていれば、ここが単調に増えていく。
    #[cfg(test)]
    pub fn handle_count() -> Option<usize> {
        use windows_sys::Win32::System::Threading::GetProcessHandleCount;

        let mut count = 0u32;
        // SAFETY: 自プロセスの疑似ハンドルと、書き込み先の有効な参照を渡している。
        let ok = unsafe { GetProcessHandleCount(GetCurrentProcess(), &raw mut count) };
        (ok != 0).then_some(count as usize)
    }

    /// 自プロセスを Job に入れる。以降に起動する子孫はすべてこの Job を受け継ぐ。
    ///
    /// 何度呼んでも最初の 1 回だけ効く。成功したら `true`。
    pub fn confine_current_process() -> bool {
        if JOB.get().is_some() {
            return true; // 既に入っている
        }
        let Some(job) = create_kill_on_close_job() else {
            return false;
        };

        // SAFETY: job は直前に作った有効なハンドル。
        let assigned = unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } != 0;
        if !assigned {
            // 既存の Job に入っていてネストできない環境 (Windows 7 以前) 等。
            // ここで閉じても中身は自分だけなので、道連れは起きない。
            // SAFETY: 自分で作ったハンドルを 1 度だけ閉じる。
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return false;
        }

        // プロセスが終わるまでハンドルを持ち続ける (閉じると道連れが発動する)
        let _ = JOB.set(job as usize);
        true
    }
}

#[cfg(not(windows))]
mod imp {
    /// Windows 以外では何もしない。
    ///
    /// ConPTY のホストプロセスは Windows 固有の存在で、Unix 系では
    /// pty の fd を閉じれば OS が後始末する (孤児が積み上がる問題がない)。
    pub fn confine_current_process() -> bool {
        false
    }

    /// Windows 以外では Job Object が無いので、緩める対象もない。
    pub fn allow_breakaway() -> bool {
        false
    }

    /// Windows 以外では Job Object が無いので、締め直す対象もない。
    pub fn confine_again() -> bool {
        false
    }

    /// Windows 以外では数えられない (Job Object が存在しない)。
    #[cfg(test)]
    pub fn assigned_process_count() -> Option<usize> {
        None
    }

    /// Windows 以外では数えられない (ハンドル数は Windows 固有の概念)。
    #[cfg(test)]
    pub fn handle_count() -> Option<usize> {
        None
    }
}

/// PTY から生えるプロセスを、アプリの終了と道連れにする。
///
/// 起動時に 1 度だけ呼ぶこと。失敗しても動作に影響はない
/// (後始末が間に合わなかったときにプロセスが残りうる、という従来の挙動に戻るだけ)。
pub fn confine_descendants() -> bool {
    imp::confine_current_process()
}

/// 更新インストーラを Job の道連れから逃がす。
///
/// 更新の適用直前に 1 度だけ呼ぶ。以降に起動する子プロセスは Job に入らなくなるので、
/// アプリが `exit(0)` してもインストーラは生き残る。詳細は `imp::allow_breakaway`。
///
/// フロントエンドの `installAndRelaunch()` から `install()` の直前に呼ばれる。
#[tauri::command(async)]
pub fn allow_process_breakaway() -> bool {
    imp::allow_breakaway()
}

/// `allow_process_breakaway` を取り消す。
///
/// インストーラの起動に失敗してアプリが生き残ったときに呼ぶ。
#[tauri::command(async)]
pub fn restore_process_confinement() -> bool {
    imp::confine_again()
}

/// Job に入っているプロセス数 (自プロセスを含む)。数えられなければ `None`。
///
/// リソースリークの検査用。`confine_descendants` を呼んでいることが前提。
///
/// 本体からは使わないのでテストビルドにだけ置く (製品コードに計測用の口を残さない)。
#[cfg(test)]
pub fn assigned_process_count() -> Option<usize> {
    imp::assigned_process_count()
}

/// 自プロセスが握っているカーネルハンドルの数。数えられなければ `None`。
///
/// リソースリークの検査用。
///
/// 本体からは使わないのでテストビルドにだけ置く (製品コードに計測用の口を残さない)。
#[cfg(test)]
pub fn handle_count() -> Option<usize> {
    imp::handle_count()
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::{create_kill_on_close_job, set_limit_flags};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, QueryInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };

    /// Job に実際に設定されている制限フラグを読み出す。
    fn limit_flags(job: HANDLE) -> u32 {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let size = u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .expect("構造体サイズが u32 に収まること");
        // SAFETY: job は有効なハンドル。info は書き込み先として十分な大きさを持つ。
        let ok = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of_mut!(info).cast(),
                size,
                std::ptr::null_mut(),
            )
        };
        assert!(ok != 0, "QueryInformationJobObject が成功すること");
        info.BasicLimitInformation.LimitFlags
    }

    #[test]
    fn creates_a_job_object() {
        // 作成と設定が通ること。自プロセスの割り当ては**しない**
        // (テストランナーを Job に入れると、ハンドルを閉じた時点で道連れになる)。
        let job = create_kill_on_close_job().expect("Job Object を作れること");

        assert!(!job.is_null());
        assert_eq!(
            limit_flags(job) & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            "作った直後は道連れ設定が入っていること"
        );

        // 中身が空の Job なので、閉じても巻き添えは出ない。
        // SAFETY: 自分で作ったハンドルを 1 度だけ閉じる。
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
    }

    #[test]
    fn breakaway_flag_can_be_toggled_after_creation() {
        // 更新インストーラを道連れから逃がす経路の要。Job を作ったあとでも
        // SILENT_BREAKAWAY_OK を足したり外したりできることを確かめる。
        let job = create_kill_on_close_job().expect("Job Object を作れること");

        assert_eq!(
            limit_flags(job) & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
            0,
            "初期状態では子プロセスは Job に入る"
        );

        assert!(set_limit_flags(
            job,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
        ));
        let flags = limit_flags(job);
        assert_ne!(
            flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
            0,
            "緩めたあとは子プロセスが Job に入らない"
        );
        assert_ne!(
            flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            0,
            "緩めても道連れ設定自体は残る (既存の PTY プロセスは終了時に片付く)"
        );

        assert!(set_limit_flags(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE));
        assert_eq!(
            limit_flags(job) & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
            0,
            "締め直せること"
        );

        // SAFETY: 自分で作ったハンドルを 1 度だけ閉じる。中身は空。
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
    }
}
