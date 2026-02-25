use chrono::{DateTime, Local};
use colored::Colorize;
use fslock::LockFile;
use serde::Deserialize;
use std::fs;
use std::thread;
use std::time::{Duration, Instant};

use crate::{
    AUTH_RELOGIN_AND_SAVE, Paths, UI_ERROR_TWO_LINE, UI_INFO_PREFIX, USAGE_ERR_ACCESS_DENIED_403,
    USAGE_ERR_INVALID_RESPONSE, USAGE_ERR_LOCK_ACQUIRE, USAGE_ERR_LOCK_HELD, USAGE_ERR_LOCK_OPEN,
    USAGE_ERR_RATE_LIMITED_429, USAGE_ERR_REQUEST_FAILED_CODE, USAGE_ERR_SERVICE_UNREACHABLE,
    USAGE_ERR_UNAUTHORIZED_401_TITLE, USAGE_UNAVAILABLE_402_DETAIL, USAGE_UNAVAILABLE_402_TITLE,
    USAGE_UNAVAILABLE_DEFAULT, command_name,
};
use crate::{is_plain, style_text, use_color_stdout};

const DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const USER_AGENT: &str = "codex-profiles";
#[cfg(not(test))]
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_RETRY_DELAY: Duration = Duration::from_secs(1);

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(test)]
const LOCK_FAIL_ERR: usize = 1;
#[cfg(test)]
const LOCK_FAIL_BUSY: usize = 2;
#[cfg(test)]
static LOCK_FAILPOINT: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Default)]
pub(crate) struct UsageLimits {
    pub(crate) five_hour: Option<UsageWindow>,
    pub(crate) weekly: Option<UsageWindow>,
}

#[derive(Clone, Debug)]
pub(crate) struct UsageWindow {
    pub(crate) left_percent: f64,
    pub(crate) reset_at: i64,
    pub(crate) reset_at_relative: Option<String>,
}

#[derive(Debug)]
pub enum UsageFetchError {
    Status(u16),
    Transport(String),
    Parse(String),
}

impl UsageFetchError {
    pub fn status_code(&self) -> Option<u16> {
        match self {
            UsageFetchError::Status(code) => Some(*code),
            _ => None,
        }
    }

    pub fn message(&self) -> String {
        match self {
            UsageFetchError::Status(401) => crate::msg2(
                UI_ERROR_TWO_LINE,
                USAGE_ERR_UNAUTHORIZED_401_TITLE,
                AUTH_RELOGIN_AND_SAVE,
            ),
            UsageFetchError::Status(402) => crate::msg2(
                UI_ERROR_TWO_LINE,
                USAGE_UNAVAILABLE_402_TITLE,
                USAGE_UNAVAILABLE_402_DETAIL,
            ),
            UsageFetchError::Status(403) => USAGE_ERR_ACCESS_DENIED_403.to_string(),
            UsageFetchError::Status(429) => USAGE_ERR_RATE_LIMITED_429.to_string(),
            UsageFetchError::Status(code) => crate::msg1(USAGE_ERR_REQUEST_FAILED_CODE, code),
            UsageFetchError::Transport(err) => crate::msg1(USAGE_ERR_SERVICE_UNREACHABLE, err),
            UsageFetchError::Parse(err) => crate::msg1(USAGE_ERR_INVALID_RESPONSE, err),
        }
    }
}

impl std::fmt::Display for UsageFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

#[derive(Debug, Deserialize)]
struct UsagePayload {
    #[serde(default)]
    rate_limit: Option<RateLimitDetails>,
}

#[derive(Clone, Debug, Deserialize)]
struct RateLimitDetails {
    #[serde(default)]
    primary_window: Option<RateLimitWindowSnapshot>,
    #[serde(default)]
    secondary_window: Option<RateLimitWindowSnapshot>,
}

#[derive(Clone, Debug, Deserialize)]
struct RateLimitWindowSnapshot {
    used_percent: f64,
    limit_window_seconds: i64,
    reset_at: i64,
}

pub fn read_base_url(paths: &Paths) -> String {
    let config_path = paths.codex.join("config.toml");
    if let Ok(contents) = fs::read_to_string(config_path) {
        for line in contents.lines() {
            if let Some(value) = parse_config_value(line, "chatgpt_base_url") {
                return normalize_base_url(&value);
            }
        }
    }
    DEFAULT_BASE_URL.to_string()
}

#[doc(hidden)]
pub fn parse_config_value(line: &str, key: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (config_key, raw_value) = line.split_once('=')?;
    if config_key.trim() != key {
        return None;
    }
    let value = strip_inline_comment(raw_value).trim();
    if value.is_empty() {
        return None;
    }
    let value = value.trim_matches('"').trim_matches('\'').trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

fn strip_inline_comment(value: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    for (idx, ch) in value.char_indices() {
        match ch {
            '"' if !in_single && !escape => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            '#' if !in_single && !in_double => return value[..idx].trim_end(),
            _ => {}
        }
        escape = in_double && ch == '\\' && !escape;
        if ch != '\\' {
            escape = false;
        }
    }
    value.trim_end()
}

fn normalize_base_url(value: &str) -> String {
    let mut base = value.trim_end_matches('/').to_string();
    if (base.starts_with("https://chatgpt.com") || base.starts_with("https://chat.openai.com"))
        && !base.contains("/backend-api")
    {
        base = format!("{base}/backend-api");
    }
    base
}

fn usage_endpoint(base_url: &str) -> String {
    if base_url.contains("/backend-api") {
        format!("{base_url}/wham/usage")
    } else {
        format!("{base_url}/api/codex/usage")
    }
}

fn fetch_usage_payload(
    base_url: &str,
    access_token: &str,
    account_id: &str,
) -> Result<UsagePayload, UsageFetchError> {
    let endpoint = usage_endpoint(base_url);
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .build();
    let agent: ureq::Agent = config.into();
    let response = match agent
        .get(&endpoint)
        .header("Authorization", &format!("Bearer {access_token}"))
        .header("ChatGPT-Account-Id", account_id)
        .header("User-Agent", USER_AGENT)
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(code)) => return Err(UsageFetchError::Status(code)),
        Err(err) => return Err(UsageFetchError::Transport(err.to_string())),
    };
    response
        .into_body()
        .read_json::<UsagePayload>()
        .map_err(|err| UsageFetchError::Parse(err.to_string()))
}

pub fn fetch_usage_details(
    base_url: &str,
    access_token: &str,
    account_id: &str,
    unavailable_text: &str,
    now: DateTime<Local>,
) -> Result<Vec<String>, UsageFetchError> {
    let payload = fetch_usage_payload(base_url, access_token, account_id)?;
    let limits = build_usage_limits(&payload, now);
    Ok(format_usage(
        format_limit(limits.five_hour.as_ref(), now, unavailable_text),
        format_limit(limits.weekly.as_ref(), now, unavailable_text),
        unavailable_text,
    ))
}

fn build_usage_limits(payload: &UsagePayload, now: DateTime<Local>) -> UsageLimits {
    let mut limits = UsageLimits::default();
    let Some(rate_limit) = payload.rate_limit.as_ref() else {
        return limits;
    };
    let mut windows: Vec<(i64, UsageWindow)> = [
        rate_limit.primary_window.as_ref(),
        rate_limit.secondary_window.as_ref(),
    ]
    .into_iter()
    .flatten()
    .map(|window| {
        (
            window.limit_window_seconds,
            usage_window_output(window, now),
        )
    })
    .collect();
    if windows.is_empty() {
        return limits;
    }
    windows.sort_by_key(|(secs, _)| *secs);
    if let Some((_, first)) = windows.first() {
        limits.five_hour = Some(first.clone());
    }
    if let Some((_, second)) = windows.get(1) {
        limits.weekly = Some(second.clone());
    }
    limits
}

fn usage_window_output(window: &RateLimitWindowSnapshot, now: DateTime<Local>) -> UsageWindow {
    let left_percent = (100.0 - window.used_percent).clamp(0.0, 100.0);
    let reset_at = window.reset_at;
    let reset_at_relative = format_reset_relative(reset_at, now);
    UsageWindow {
        left_percent,
        reset_at,
        reset_at_relative,
    }
}

pub(crate) struct UsageLine {
    pub(crate) bar: String,
    pub(crate) percent: String,
    pub(crate) reset: String,
    pub(crate) left_percent: Option<i64>,
}

impl UsageLine {
    fn unavailable(text: &str) -> Self {
        UsageLine {
            bar: text.to_string(),
            percent: String::new(),
            reset: String::new(),
            left_percent: None,
        }
    }
}

pub(crate) fn format_limit(
    window: Option<&UsageWindow>,
    now: DateTime<Local>,
    unavailable_text: &str,
) -> UsageLine {
    let Some(window) = window else {
        return UsageLine::unavailable(unavailable_text);
    };
    let left_percent = window.left_percent;
    let left_percent_rounded = left_percent.round() as i64;
    let bar = render_bar(left_percent);
    let bar = style_usage_bar(&bar, left_percent);
    let percent = format!("{left_percent_rounded}%");
    let reset = window.reset_at_relative.clone().unwrap_or_else(|| {
        let local = local_from_timestamp(window.reset_at).unwrap_or(now);
        local.format("%H:%M on %d %b").to_string()
    });
    UsageLine {
        bar,
        percent,
        reset,
        left_percent: Some(left_percent_rounded),
    }
}

pub fn usage_unavailable() -> &'static str {
    USAGE_UNAVAILABLE_DEFAULT
}

pub fn format_usage_unavailable(text: &str, use_color: bool) -> String {
    if is_plain() {
        crate::msg1(UI_INFO_PREFIX, text)
    } else if use_color {
        text.red().bold().to_string()
    } else {
        text.to_string()
    }
}

pub(crate) fn format_usage(
    five: UsageLine,
    weekly: UsageLine,
    unavailable_text: &str,
) -> Vec<String> {
    let use_color = use_color_stdout();
    let available: Vec<UsageLine> = [five, weekly]
        .into_iter()
        .filter(|line| line.left_percent.is_some())
        .collect();
    if available.is_empty() {
        return vec![format_usage_unavailable(unavailable_text, use_color)];
    }
    let has_zero = available.iter().any(|line| line.left_percent == Some(0));
    let multiple = available.len() > 1;
    available
        .into_iter()
        .map(|line| {
            let dim = use_color && multiple && has_zero && line.left_percent != Some(0);
            format_usage_line(&line, dim, use_color)
        })
        .collect()
}

pub(crate) fn format_reset_relative(reset_at: i64, now: DateTime<Local>) -> Option<String> {
    let reset_at = local_from_timestamp(reset_at)?;
    let duration = reset_at.signed_duration_since(now);
    if duration.num_seconds() <= 0 {
        return Some("now".to_string());
    }
    let duration = duration.to_std().ok()?;
    Some(format_duration(duration, DurationStyle::ResetTimer))
}

fn format_usage_line(line: &UsageLine, dim: bool, use_color: bool) -> String {
    let reset = reset_label(&line.reset);
    let reset = reset.to_string();
    let percent = if line.percent.is_empty() {
        String::new()
    } else {
        format!("{} left", line.percent)
    };
    let resets = format_resets_suffix(&reset, use_color);
    if is_plain() {
        let mut out = String::new();
        if !percent.is_empty() {
            out.push_str(&percent);
        }
        if !resets.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&resets);
        }
        return out;
    }
    let resets = if resets.is_empty() {
        resets
    } else {
        format!(" {resets}")
    };
    let bar = if dim {
        strip_ansi(&line.bar)
    } else {
        line.bar.clone()
    };
    let formatted = if percent.is_empty() {
        format!("{bar}{resets}")
    } else {
        format!("{bar} {percent}{resets}")
    };
    if dim && use_color {
        formatted.dimmed().to_string()
    } else {
        formatted
    }
}

fn reset_label(reset: &str) -> &str {
    if reset.is_empty() { "unknown" } else { reset }
}

fn format_resets_suffix(reset: &str, use_color: bool) -> String {
    let text = format!("(resets {reset})");
    style_text(&text, use_color, |text| text.dimmed().italic())
}

fn render_bar(left_percent: f64) -> String {
    let total = 20;
    let filled = ((left_percent / 100.0) * total as f64).round() as usize;
    let filled = filled.min(total);
    let empty = total.saturating_sub(filled);
    format!(
        "{}{}",
        "▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮"
            .chars()
            .take(filled)
            .collect::<String>(),
        "▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯"
            .chars()
            .take(empty)
            .collect::<String>()
    )
}

fn style_usage_bar(bar: &str, left_percent: f64) -> String {
    if !use_color_stdout() {
        return bar.to_string();
    }
    if left_percent >= 66.0 {
        bar.green().to_string()
    } else if left_percent >= 33.0 {
        bar.yellow().to_string()
    } else {
        bar.red().to_string()
    }
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    loop {
        let Some(ch) = chars.next() else {
            break;
        };
        if ch == '\x1b' && consume_ansi_escape(&mut chars) {
            continue;
        }
        out.push(ch);
    }
    out
}

fn consume_ansi_escape<I>(chars: &mut std::iter::Peekable<I>) -> bool
where
    I: Iterator<Item = char>,
{
    if chars.peek() != Some(&'[') {
        return false;
    }
    chars.next();
    for c in chars.by_ref() {
        if c == 'm' {
            break;
        }
    }
    true
}

enum DurationStyle {
    ResetTimer,
}

fn format_duration(duration: Duration, style: DurationStyle) -> String {
    let secs = duration.as_secs();
    let (value, unit) = if secs < 60 {
        (secs, "s")
    } else if secs < 60 * 60 {
        (secs / 60, "m")
    } else if secs < 60 * 60 * 24 {
        (secs / (60 * 60), "h")
    } else {
        (secs / (60 * 60 * 24), "d")
    };
    match style {
        DurationStyle::ResetTimer => format!("in {value}{unit}"),
    }
}

fn local_from_timestamp(ts: i64) -> Option<DateTime<Local>> {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)?;
    Some(dt.with_timezone(&Local))
}

#[derive(Debug)]
pub struct UsageLock {
    _lock: LockFile,
}

pub fn lock_usage(paths: &Paths) -> Result<UsageLock, String> {
    let start = Instant::now();
    let mut lock = LockFile::open(&paths.profiles_lock)
        .map_err(|err| crate::msg1(USAGE_ERR_LOCK_OPEN, err))?;
    loop {
        match try_lock(&mut lock) {
            Ok(true) => break,
            Ok(false) => {
                if start.elapsed() > lock_timeout() {
                    return Err(crate::msg1(USAGE_ERR_LOCK_ACQUIRE, command_name()));
                }
                thread::sleep(LOCK_RETRY_DELAY);
            }
            Err(err) => {
                return Err(crate::msg1(USAGE_ERR_LOCK_HELD, err));
            }
        }
    }
    Ok(UsageLock { _lock: lock })
}

#[cfg(not(test))]
fn lock_timeout() -> Duration {
    LOCK_TIMEOUT
}

#[cfg(not(test))]
fn try_lock(lock: &mut LockFile) -> Result<bool, fslock::Error> {
    lock.try_lock()
}

#[cfg(test)]
fn lock_timeout() -> Duration {
    Duration::from_millis(50)
}

#[cfg(test)]
fn try_lock(lock: &mut LockFile) -> Result<bool, fslock::Error> {
    match LOCK_FAILPOINT.load(Ordering::Relaxed) {
        LOCK_FAIL_ERR => Err(std::io::Error::other("fail")),
        LOCK_FAIL_BUSY => Ok(false),
        _ => lock.try_lock(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{
        http_ok_response, make_paths, set_env_guard, set_plain_guard, spawn_server,
    };
    use std::fs;
    use std::sync::Mutex;

    static LOCK_TEST_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn config_parsing_paths() {
        assert!(parse_config_value("", "key").is_none());
        assert!(parse_config_value("# comment", "key").is_none());
        assert!(parse_config_value("other = 1", "key").is_none());
        assert!(parse_config_value("key =", "key").is_none());
        assert_eq!(
            parse_config_value("key = 'value'", "key"),
            Some("value".to_string())
        );
        assert_eq!(strip_inline_comment("value # comment"), "value");
    }

    #[test]
    fn normalize_base_url_and_endpoint() {
        let url = normalize_base_url("https://chatgpt.com");
        assert!(url.ends_with("/backend-api"));
        assert!(usage_endpoint(&url).contains("wham/usage"));
        assert!(usage_endpoint("http://example.com").contains("api/codex/usage"));
    }

    #[test]
    fn fetch_usage_payload_paths() {
        let payload = r#"{"rate_limit":{"primary_window":{"used_percent":50.0,"limit_window_seconds":3600,"reset_at":1}}}"#;
        let resp = http_ok_response(payload, "application/json");
        let url = spawn_server(resp);
        let base_url = format!("{url}/backend-api");
        fetch_usage_payload(&base_url, "token", "acct").unwrap();

        let err_resp =
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n".to_string();
        let err_url = spawn_server(err_resp);
        let base_url = format!("{err_url}/backend-api");
        let err = fetch_usage_payload(&base_url, "token", "acct").unwrap_err();
        assert!(matches!(err, UsageFetchError::Status(_)));

        let bad_resp =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1\r\n\r\n{"
                .to_string();
        let bad_url = spawn_server(bad_resp);
        let base_url = format!("{bad_url}/backend-api");
        let err = fetch_usage_payload(&base_url, "token", "acct").unwrap_err();
        assert!(matches!(err, UsageFetchError::Parse(_)));
    }

    #[test]
    fn fetch_usage_details_paths() {
        let payload = r#"{"rate_limit":{"primary_window":{"used_percent":10.0,"limit_window_seconds":3600,"reset_at":1}}}"#;
        let resp = http_ok_response(payload, "application/json");
        let url = spawn_server(resp);
        let base_url = format!("{url}/backend-api");
        let lines =
            fetch_usage_details(&base_url, "token", "acct", "unavailable", Local::now()).unwrap();
        assert!(!lines.is_empty());
    }

    #[test]
    fn usage_limits_and_formatting() {
        let payload = UsagePayload { rate_limit: None };
        let limits = build_usage_limits(&payload, Local::now());
        assert!(limits.five_hour.is_none());

        let window = RateLimitWindowSnapshot {
            used_percent: 50.0,
            limit_window_seconds: 10,
            reset_at: Local::now().timestamp(),
        };
        let rate_limit = RateLimitDetails {
            primary_window: Some(window.clone()),
            secondary_window: Some(window.clone()),
        };
        let payload = UsagePayload {
            rate_limit: Some(rate_limit),
        };
        let limits = build_usage_limits(&payload, Local::now());
        assert!(limits.five_hour.is_some());
        let line = format_limit(limits.five_hour.as_ref(), Local::now(), "none");
        assert!(line.left_percent.is_some());
    }

    #[test]
    fn usage_unavailable_paths() {
        let _plain = set_plain_guard(true);
        assert_eq!(usage_unavailable(), "Data not available");
        let text = format_usage_unavailable("text", false);
        assert!(text.contains("Info"));
    }

    #[test]
    fn format_usage_variants() {
        let unavailable = "unavailable";
        let lines = format_usage(
            UsageLine::unavailable(unavailable),
            UsageLine::unavailable(unavailable),
            unavailable,
        );
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn format_usage_line_plain_and_dim() {
        let line = UsageLine {
            bar: render_bar(50.0),
            percent: "50%".to_string(),
            reset: "soon".to_string(),
            left_percent: Some(50),
        };
        let _plain = set_plain_guard(true);
        let plain = format_usage_line(&line, false, false);
        assert!(plain.contains("left"));
    }

    #[test]
    fn style_bar_and_strip_ansi() {
        let _env = set_env_guard("NO_COLOR", Some("1"));
        let bar = render_bar(10.0);
        let styled = style_usage_bar(&bar, 10.0);
        assert_eq!(bar, styled);
        let stripped = strip_ansi("\x1b[31mred\x1b[0m");
        assert_eq!(stripped, "red");
    }

    #[test]
    fn format_duration_helpers() {
        assert_eq!(
            format_duration(Duration::from_secs(60), DurationStyle::ResetTimer),
            "in 1m"
        );
        assert!(local_from_timestamp(0).is_some());
        assert!(local_from_timestamp(-1).is_some());
    }

    #[test]
    fn lock_usage_failure_paths() {
        let _guard = LOCK_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = make_paths(dir.path());
        fs::create_dir_all(&paths.profiles).unwrap();
        fs::write(&paths.profiles_lock, "").unwrap();

        LOCK_FAILPOINT.store(LOCK_FAIL_BUSY, Ordering::Relaxed);
        let err = lock_usage(&paths).unwrap_err();
        assert!(err.contains("Could not acquire profiles lock"));
        LOCK_FAILPOINT.store(LOCK_FAIL_ERR, Ordering::Relaxed);
        let err = lock_usage(&paths).unwrap_err();
        assert!(err.contains("Could not lock profiles file"));
        LOCK_FAILPOINT.store(0, Ordering::Relaxed);
    }

    #[test]
    fn lock_usage_open_error() {
        let _guard = LOCK_TEST_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().expect("tempdir");
        let lock_dir = dir.path().join("locked");
        fs::create_dir_all(&lock_dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&lock_dir, fs::Permissions::from_mode(0o400)).unwrap();
        }
        let mut paths = make_paths(dir.path());
        paths.profiles_lock = lock_dir.join("profiles.lock");
        let err = lock_usage(&paths).unwrap_err();
        assert!(err.contains("Could not open profiles lock"));
    }
}
