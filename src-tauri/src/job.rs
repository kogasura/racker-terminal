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

#[cfg(windows)]
mod imp {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    /// 生成した Job のハンドルを保持しておくための置き場。
    ///
    /// **ハンドルを閉じてはいけない。** 閉じた時点で
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` が発動し、自分もろとも終了する。
    /// プロセスが死ぬときに OS が閉じるのが、まさに狙った動作。
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

    /// 「閉じたら中のプロセスを皆殺しにする」Job を作る。
    ///
    /// 作成と設定だけを行い、プロセスの割り当てはしない
    /// (テストから安全に呼べるようにするため。割り当ててしまうと、
    /// テストランナー自身がこの Job に入ってしまう)。
    ///
    /// 失敗したら `None`。Job が使えない環境でもアプリは動くべきなので、
    /// 呼び出し側はエラーとして扱わないこと。
    pub fn create_kill_on_close_job() -> Option<HANDLE> {
        // SAFETY: いずれも引数の妥当性だけが要件の Win32 呼び出し。
        // ハンドルは失敗時 null が返るのでその場で判定している。
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).ok()?;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                size,
            ) == 0
            {
                return None;
            }
            Some(job)
        }
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
}

/// PTY から生えるプロセスを、アプリの終了と道連れにする。
///
/// 起動時に 1 度だけ呼ぶこと。失敗しても動作に影響はない
/// (後始末が間に合わなかったときにプロセスが残りうる、という従来の挙動に戻るだけ)。
pub fn confine_descendants() -> bool {
    imp::confine_current_process()
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::create_kill_on_close_job;

    #[test]
    fn creates_a_job_object() {
        // 作成と設定が通ること。自プロセスの割り当ては**しない**
        // (テストランナーを Job に入れると、ハンドルを閉じた時点で道連れになる)。
        let job = create_kill_on_close_job().expect("Job Object を作れること");

        assert!(!job.is_null());

        // 中身が空の Job なので、閉じても巻き添えは出ない。
        // SAFETY: 自分で作ったハンドルを 1 度だけ閉じる。
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
    }
}
