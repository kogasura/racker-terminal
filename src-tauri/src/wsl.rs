//! WSL distro 検出用 Tauri command
//! Phase 4 P-K で追加。

use std::process::Command;

/// `wsl.exe --list --quiet` の出力をパースする純関数。
/// - UTF-16LE BOM をスキップ
/// - CRLF を改行として扱う
/// - 空行 / `docker-desktop*` を除外
/// - NUL 文字や trailing \r を trim
///
/// テスト容易性のため pub にする。
pub fn parse_wsl_list_output(bytes: &[u8]) -> Vec<String> {
    let bytes = if bytes.starts_with(&[0xFF, 0xFE]) { &bytes[2..] } else { bytes };
    let utf16: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let text = String::from_utf16_lossy(&utf16);
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("docker-desktop"))
        .collect()
}

/// インストール済み WSL distro 一覧を返す Tauri command。
/// - `wsl.exe --list --quiet` を実行 (UTF-16LE 出力を `parse_wsl_list_output` でデコード)
/// - WSL 未インストール / 実行失敗時は **空 vec を返す** (エラーにしない)
/// - `docker-desktop` / `docker-desktop-data` は除外
#[tauri::command]
pub fn list_wsl_distros() -> Vec<String> {
    let Ok(output) = Command::new("wsl.exe").args(["--list", "--quiet"]).output() else {
        return vec![];   // wsl.exe が無い / 実行失敗 → 空
    };
    if !output.status.success() {
        return vec![];   // 異常終了 → 空
    }
    parse_wsl_list_output(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str) -> Vec<u8> {
        let mut buf = vec![0xFF, 0xFE];   // BOM
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
    fn parse_with_null_chars() {
        // 末尾に NUL が混入するケース (古い Windows 環境で観測されうる)
        let mut bytes = utf16le("Ubuntu-22.04\r\n");
        bytes.extend_from_slice(&[0x00, 0x00]);
        assert_eq!(parse_wsl_list_output(&bytes), vec!["Ubuntu-22.04"]);
    }
}
