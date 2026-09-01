//! WSL distro 検出用 Tauri command
//! Phase 4 P-K で追加。

use crate::proc::hidden_command;

/// `wsl.exe` の出力 (UTF-16LE、先頭に BOM が付くことがある) を文字列にする。
fn decode_utf16le(bytes: &[u8]) -> String {
    let bytes = if bytes.starts_with(&[0xFF, 0xFE]) {
        &bytes[2..]
    } else {
        bytes
    };
    let utf16: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    String::from_utf16_lossy(&utf16)
}

/// `wsl.exe --list --quiet` の出力をパースする純関数。
/// - UTF-16LE BOM をスキップ
/// - CRLF を改行として扱う
/// - 空行 / `docker-desktop*` を除外
/// - NUL 文字や trailing \r を trim
///
/// テスト容易性のため pub にする。
pub fn parse_wsl_list_output(bytes: &[u8]) -> Vec<String> {
    decode_utf16le(bytes)
        .lines()
        .map(|l| {
            l.trim_matches(|c: char| c.is_whitespace() || c == '\0')
                .to_string()
        })
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("docker-desktop"))
        .collect()
}

/// インストール済み WSL distro 一覧を返す Tauri command。
/// - `wsl.exe --list --quiet` を実行 (UTF-16LE 出力を `parse_wsl_list_output` でデコード)
/// - WSL 未インストール / 実行失敗時は **空 vec を返す** (エラーにしない)
/// - `docker-desktop` / `docker-desktop-data` は除外
///
/// `(async)` は必須。これが無いとメインスレッドで実行され、`wsl.exe` の起動
/// （WSL が停止中だと数秒かかる）の間ウィンドウが固まる。
#[tauri::command(async)]
pub fn list_wsl_distros() -> Vec<String> {
    let Ok(output) = hidden_command("wsl.exe")
        .args(["--list", "--quiet"])
        .output()
    else {
        return vec![]; // wsl.exe が無い / 実行失敗 → 空
    };
    if !output.status.success() {
        return vec![]; // 異常終了 → 空
    }
    parse_wsl_list_output(&output.stdout)
}

/// `wsl.exe --list --verbose` の出力から既定 distro (`*` 付きの行) を取り出す純関数。
///
/// 出力例 (UTF-16LE):
/// ```text
///   NAME              STATE           VERSION
/// * Ubuntu-24.04      Running         2
///   Ubuntu-22.04      Stopped         2
/// ```
///
/// `list_wsl_distros` と違い `docker-desktop` を除外しない。既定 distro が
/// docker-desktop の環境も実在し、そこで `wsl.exe` を引数なしで起動すれば
/// 実際に動くのはその distro なので、除外するとパス解決が誤る。
pub fn parse_wsl_default_distro(bytes: &[u8]) -> Option<String> {
    decode_utf16le(bytes).lines().find_map(|line| {
        let rest = line
            .trim_start_matches(|c: char| c.is_whitespace() || c == '\0')
            .strip_prefix('*')?;
        rest.split_whitespace().next().map(str::to_string)
    })
}

/// 既定 WSL distro 名を返す。取得できなければ `None`。
///
/// `-d` を付けずに起動した WSL タブ (`wsl.exe --cd ~` など) が出す Linux パスを
/// `\\wsl.localhost\<distro>\...` に解決するために使う (file_link.rs)。
///
/// リンクのクリック時にだけ呼ばれる。既に WSL タブが動いている状況なので、
/// この `wsl.exe` 実行が停止中の distro を起こすことはない。
pub fn default_wsl_distro() -> Option<String> {
    let output = hidden_command("wsl.exe")
        .args(["--list", "--verbose"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_wsl_default_distro(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str) -> Vec<u8> {
        let mut buf = vec![0xFF, 0xFE]; // BOM
        for u in s.encode_utf16() {
            buf.push((u & 0xFF) as u8);
            buf.push((u >> 8) as u8);
        }
        buf
    }

    #[test]
    fn parse_typical_output() {
        // wsl --list --quiet の典型的な出力 (BOM + UTF-16LE + CRLF)
        let bytes = utf16le("Ubuntu-22.04\r\nDebian\r\ndocker-desktop\r\ndocker-desktop-data\r\n");
        let result = parse_wsl_list_output(&bytes);
        assert_eq!(result, vec!["Ubuntu-22.04", "Debian"]);
    }

    #[test]
    fn parse_empty_output() {
        assert_eq!(parse_wsl_list_output(&[]), Vec::<String>::new());
        assert_eq!(parse_wsl_list_output(&utf16le("")), Vec::<String>::new());
    }

    #[test]
    fn parse_only_docker_desktop() {
        let bytes = utf16le("docker-desktop\r\ndocker-desktop-data\r\n");
        assert_eq!(parse_wsl_list_output(&bytes), Vec::<String>::new());
    }

    #[test]
    fn parse_no_bom() {
        // BOM なしでもデコードできる (堅牢性のため)
        let mut buf = vec![];
        for u in "Ubuntu-22.04\r\n".encode_utf16() {
            buf.push((u & 0xFF) as u8);
            buf.push((u >> 8) as u8);
        }
        assert_eq!(parse_wsl_list_output(&buf), vec!["Ubuntu-22.04"]);
    }

    #[test]
    fn parse_default_distro_from_verbose_output() {
        let bytes = utf16le(
            "  NAME              STATE           VERSION\r\n\
             * Ubuntu-24.04      Running         2\r\n\
             \x20 Ubuntu-22.04      Stopped         2\r\n",
        );
        assert_eq!(
            parse_wsl_default_distro(&bytes),
            Some("Ubuntu-24.04".to_string())
        );
    }

    #[test]
    fn parse_default_distro_includes_docker_desktop() {
        // 既定が docker-desktop の環境もある。実際にそれが起動するので除外しない
        let bytes = utf16le(
            "  NAME              STATE           VERSION\r\n\
             * docker-desktop    Running         2\r\n",
        );
        assert_eq!(
            parse_wsl_default_distro(&bytes),
            Some("docker-desktop".to_string())
        );
    }

    #[test]
    fn parse_default_distro_absent_returns_none() {
        // `*` の行が無い (WSL 未セットアップ等)
        let bytes = utf16le("  NAME              STATE           VERSION\r\n");
        assert_eq!(parse_wsl_default_distro(&bytes), None);
        assert_eq!(parse_wsl_default_distro(&[]), None);
    }

    #[test]
    fn parse_with_null_chars() {
        // 末尾に NUL が混入するケース (古い Windows 環境で観測されうる)
        let mut bytes = utf16le("Ubuntu-22.04\r\n");
        bytes.extend_from_slice(&[0x00, 0x00]);
        assert_eq!(parse_wsl_list_output(&bytes), vec!["Ubuntu-22.04"]);
    }
}
