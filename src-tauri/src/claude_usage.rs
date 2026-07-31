//! Claude のプラン利用量 (5 時間ウィンドウ / 週次) を取得する Tauri command。
//!
//! Claude Code の `/usage` が読んでいるのと同じ値を、同じ経路で取りに行く:
//! `~/.claude/.credentials.json` の OAuth アクセストークンで
//! `https://api.anthropic.com/api/oauth/usage` を GET し、利用率とリセット時刻を得る。
//!
//! ## 設計方針
//!
//! - **トークンをフロントへ渡さない。** 読み取りもリクエストも Rust 側で完結させ、
//!   webview には利用率とリセット時刻だけを返す
//! - **失敗はすべて `None`。** 未ログイン・期限切れ・オフライン・API の仕様変更、
//!   どれも「表示しない」に落とす。ターミナルの主機能とは無関係なので、
//!   ここでエラーを上げてもユーザーにできることがない
//! - **呼ぶ間隔は呼び出し側が決める。** ここは 1 回叩くだけ。
//!   数分に 1 回を超える頻度で呼ばないこと (フロント側の App.tsx を参照)
//!
//! ⚠️ このエンドポイントは公式にドキュメント化された API ではない。
//! レスポンス形式が変われば値が取れなくなるだけで済むよう、
//! 必要なフィールドだけを緩く読む。

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 利用量エンドポイント。Claude Code 本体が使っているものと同じ。
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// HTTP のタイムアウト。数分に 1 回の背景処理なので、粘らず諦めてよい。
const TIMEOUT: Duration = Duration::from_secs(15);

/// フロントへ返す利用量。すべて `Option` で、取れたぶんだけ表示させる。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    /// 5 時間ウィンドウの使用率 (0〜100)。
    pub five_hour_percent: Option<f64>,
    /// 5 時間ウィンドウがリセットされる時刻 (ISO8601)。
    pub five_hour_resets_at: Option<String>,
    /// 週次の使用率 (0〜100)。
    pub seven_day_percent: Option<f64>,
    /// 週次のリセット時刻 (ISO8601)。
    pub seven_day_resets_at: Option<String>,
}

impl UsageLimits {
    /// 何ひとつ取れなかったか。空の枠を UI に出さないための判定。
    fn is_empty(&self) -> bool {
        self.five_hour_percent.is_none() && self.seven_day_percent.is_none()
    }
}

/// `.credentials.json` からアクセストークンを取り出す。
///
/// `now_ms` より前に失効しているトークンは `None` にする。期限切れを投げても
/// 401 が返るだけなので、無駄な通信をしない。リフレッシュは行わない
/// (それは Claude Code 本体の仕事で、racker が肩代わりするとトークンが競合する)。
pub fn parse_access_token(credentials_json: &str, now_ms: i64) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(credentials_json).ok()?;
    let oauth = v.get("claudeAiOauth")?;

    if let Some(expires_at) = oauth.get("expiresAt").and_then(serde_json::Value::as_i64) {
        if expires_at <= now_ms {
            return None;
        }
    }

    let token = oauth.get("accessToken")?.as_str()?;
    (!token.is_empty()).then(|| token.to_string())
}

/// 利用量レスポンスから必要な値だけを抜き出す。
///
/// `five_hour` / `seven_day` の 2 ブロックだけを見る。レスポンスには他にも
/// 多くのフィールドがあるが、いずれも実験的なもの・null のものなので触らない。
pub fn parse_usage(body: &str) -> Option<UsageLimits> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;

    let block = |name: &str| -> (Option<f64>, Option<String>) {
        let Some(b) = v.get(name) else {
            return (None, None);
        };
        (
            b.get("utilization").and_then(serde_json::Value::as_f64),
            b.get("resets_at")
                .and_then(|r| r.as_str())
                .map(str::to_string),
        )
    };

    let (five_hour_percent, five_hour_resets_at) = block("five_hour");
    let (seven_day_percent, seven_day_resets_at) = block("seven_day");

    let limits = UsageLimits {
        five_hour_percent,
        five_hour_resets_at,
        seven_day_percent,
        seven_day_resets_at,
    };
    (!limits.is_empty()).then_some(limits)
}

/// rustls の暗号プロバイダを一度だけ登録する。
///
/// reqwest を `rustls-no-provider` で入れているため、プロバイダはアプリ側が指定する。
/// 既定の `rustls` feature に任せると aws-lc-rs が入り、そのビルドに cmake と
/// C/C++ ツールチェインが必要になる。updater が既に ring を使っているので、
/// 揃えておけばビルド要件が増えない。
///
/// 既に登録済みなら `install_default` は `Err` を返すだけで害はない。
fn ensure_tls_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// 現在時刻を UNIX ミリ秒で返す。取れなければ 0 (= 期限判定を素通しさせる)。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// ログイン中のアクセストークンを読む。未ログイン・期限切れなら `None`。
fn access_token() -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
    let text = std::fs::read_to_string(path).ok()?;
    parse_access_token(&text, now_ms())
}

/// プランの利用量を取得する Tauri command。
///
/// 未ログイン・オフライン・仕様変更のいずれでも `None` を返す。
/// 呼び出し側は「使用量を表示しない」だけにすること。
///
/// 数分に 1 回を超える頻度で呼ばないこと。表示のためだけに Anthropic の API を
/// 叩いており、頻繁に呼ぶ理由がない (利用率は分単位でしか動かない)。
#[tauri::command(async)]
pub async fn get_claude_usage() -> Option<UsageLimits> {
    let token = access_token()?;

    ensure_tls_provider();
    let client = reqwest::Client::builder().timeout(TIMEOUT).build().ok()?;
    let response = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        // 401 (トークン失効) / 5xx。どちらも次の巡回で回復しうるので黙る
        return None;
    }
    parse_usage(&response.text().await.ok()?)
}

#[cfg(test)]
mod tests {
    // assert_eq! は展開すると if/else になるため、アサーションを並べただけの
    // テストでも認知的複雑度が嵩む。TS 側で test を対象外にしているのと揃えて許容する。
    #![allow(clippy::cognitive_complexity)]

    use super::*;

    const CREDENTIALS: &str = r#"{
        "claudeAiOauth": {
            "accessToken": "sk-ant-oat-example",
            "refreshToken": "sk-ant-ort-example",
            "expiresAt": 2000,
            "subscriptionType": "max"
        }
    }"#;

    /// 実際のレスポンスから、読む対象のフィールドを残して切り出したもの。
    const USAGE_BODY: &str = r#"{
        "five_hour": {
            "utilization": 13.0,
            "resets_at": "2026-07-31T07:00:00.541409+00:00",
            "limit_dollars": null
        },
        "seven_day": {
            "utilization": 22.0,
            "resets_at": "2026-08-06T00:00:00.541429+00:00"
        },
        "seven_day_opus": null,
        "limits": [{"kind": "session", "percent": 13}]
    }"#;

    #[test]
    fn reads_a_valid_token() {
        assert_eq!(
            parse_access_token(CREDENTIALS, 1000).as_deref(),
            Some("sk-ant-oat-example")
        );
    }

    #[test]
    fn rejects_an_expired_token() {
        // expiresAt を過ぎていれば投げない (401 が返るだけなので通信を省く)
        assert!(parse_access_token(CREDENTIALS, 2001).is_none());
    }

    #[test]
    fn returns_none_when_not_logged_in() {
        assert!(parse_access_token("{}", 0).is_none());
        assert!(parse_access_token("not json", 0).is_none());
    }

    #[test]
    fn parses_usage_percentages_and_resets() {
        let usage = parse_usage(USAGE_BODY).expect("should parse");

        assert_eq!(usage.five_hour_percent, Some(13.0));
        assert_eq!(usage.seven_day_percent, Some(22.0));
        assert_eq!(
            usage.five_hour_resets_at.as_deref(),
            Some("2026-07-31T07:00:00.541409+00:00")
        );
        assert_eq!(
            usage.seven_day_resets_at.as_deref(),
            Some("2026-08-06T00:00:00.541429+00:00")
        );
    }

    #[test]
    fn tolerates_missing_blocks() {
        // 週次だけ返ってきても、取れたぶんは使えること
        let usage = parse_usage(r#"{"five_hour": {"utilization": 5.0}}"#).expect("should parse");

        assert_eq!(usage.five_hour_percent, Some(5.0));
        assert_eq!(usage.seven_day_percent, None);
        assert_eq!(usage.five_hour_resets_at, None);
    }

    #[test]
    fn returns_none_when_nothing_usable() {
        // 形式が変わって利用率が 1 つも取れないなら、空の枠を出さない
        assert!(parse_usage(r#"{"something_else": 1}"#).is_none());
        assert!(parse_usage("<html>error</html>").is_none());
    }
}
