//! 外部コマンドを**コンソール窓を出さずに**起動するためのヘルパー。
//!
//! ## なぜ必要か
//!
//! racker は GUI アプリ (windows サブシステム) で、自分のコンソールを持たない。
//! そこから `git` や `gh` のようなコンソールアプリを起動すると、Windows は
//! **新しいコンソールを割り当てる**。これが黒い窓として一瞬表示され、すぐ消える。
//!
//! 1 回なら見逃せるが、PR 状態の取得は 30 秒ごとに作業ディレクトリの数だけ
//! `git` と `gh` を起動する。リポジトリを 3 つ開いていれば 30 秒ごとに 6 回、
//! 画面のどこかで黒い窓が明滅し続けることになる。
//!
//! `CREATE_NO_WINDOW` を渡すとコンソールが割り当てられず、窓も出ない。
//! 出力のパイプ取得には影響しないので、`output()` はこれまでどおり使える。
//!
//! ## 注意
//!
//! **ターミナルとして起動するシェルにはこれを使わない。** そちらは ConPTY
//! (portable_pty) 経由で、そもそも独立したコンソール窓を作らない。ここで
//! 扱うのは「裏で情報を取りに行くだけのコマンド」に限る。

use std::process::Command;

/// コンソール窓を割り当てないプロセス生成フラグ (Windows)。
///
/// 値は Win32 の `CREATE_NO_WINDOW`。windows-sys 等を足すほどの用途ではないので
/// 定数を直接置いている。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// コンソール窓を出さずに外部コマンドを起動する `Command` を作る。
///
/// Windows 以外では素の `Command::new` と同じ (この設定自体が Windows 固有)。
pub fn hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_command_for_the_requested_program() {
        let cmd = hidden_command("git");
        assert_eq!(cmd.get_program(), "git");
    }

    #[test]
    fn passes_no_arguments_by_itself() {
        // 呼び出し側が付けた引数だけが渡ること（ヘルパーが勝手に足さない）
        let cmd = hidden_command("gh");
        assert_eq!(cmd.get_args().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn the_flag_value_is_create_no_window() {
        // 値を取り違えると窓が出続ける / 別の挙動になる。
        // Win32 の CREATE_NO_WINDOW = 0x08000000 であることを固定する。
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    /// **窓を消した代わりに出力まで取れなくなっていないこと。**
    ///
    /// CREATE_NO_WINDOW はコンソールの割り当てを止めるだけで、パイプ経由の
    /// stdout 取得には影響しない。ただしフラグを取り違えると
    /// (例: DETACHED_PROCESS = 0x8) 出力が取れなくなる。
    /// git / gh の結果は PR バッジの表示そのものなので、ここで実際に動かして確かめる。
    #[test]
    fn still_captures_stdout() {
        let output = if cfg!(windows) {
            hidden_command("cmd")
                .args(["/c", "echo", "racker_probe"])
                .output()
        } else {
            hidden_command("echo").arg("racker_probe").output()
        }
        .expect("コマンドを起動できること");

        assert!(output.status.success(), "コマンドが失敗した: {output:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("racker_probe"),
            "stdout を取得できていない。実際の出力: {stdout:?}"
        );
    }

    /// 終了コードが伝わること（`gh` は PR が無いと非ゼロで終わり、
    /// 呼び出し側はそれを「PR 無し」の判定に使っている）。
    #[test]
    fn still_reports_a_failing_exit_status() {
        let output = if cfg!(windows) {
            hidden_command("cmd").args(["/c", "exit 3"]).output()
        } else {
            hidden_command("sh").args(["-c", "exit 3"]).output()
        }
        .expect("コマンドを起動できること");

        assert!(!output.status.success());
        assert_eq!(output.status.code(), Some(3));
    }
}
