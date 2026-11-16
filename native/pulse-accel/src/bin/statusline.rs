use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value};

const MAX_INPUT: usize = 256 * 1024;
const MAX_SAFE_INT: u64 = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

const HELP_TEXT: &str = "\
Antigrative Dashboard for Antigravity CLI (Native Rust)
Reads the official statusLine JSON from stdin or reads local ledger/snapshot state.
  --preview              Render synthetic data; does not write statistics
  --language en|zh-CN    Override shared desktop language preference
  --width 1..500         Override terminal columns
  --details, --full      Include capacity and current request token counts
  --compact              Compact view (omit details line)
  --no-color             Disable ANSI (also honors NO_COLOR and TERM=dumb)
  --json                 Print only normalized, whitelisted metrics
  --instance pro|vertex|all  Select desktop instance for preferences/snapshot
  --stale-minutes N      Staleness threshold in minutes for snapshot mode
  --snapshot             Read local instance snapshot/SQLite cache instead of stdin
  --help                 Show this help
";

#[derive(Debug, Clone, Default)]
pub struct CliOptions {
    pub preview: bool,
    pub details: bool,
    pub compact: bool,
    pub json: bool,
    pub help: bool,
    pub no_color: bool,
    pub snapshot: bool,
    pub language: Option<String>,
    pub width: Option<usize>,
    pub instance: Option<String>,
    pub stale_minutes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCacheRate {
    pub percentage: Option<f64>,
    pub basis: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliQuotaWindow {
    pub id: String,
    pub remaining: Option<f64>,
    pub reset_in_seconds: Option<f64>,
    pub reset_time: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliContextMetrics {
    pub used_percentage: Option<f64>,
    pub capacity: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliNormalizedMetrics {
    pub model: Option<String>,
    pub state: Option<String>,
    pub width: usize,
    pub context: CliContextMetrics,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub cache_rate: CliCacheRate,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub quotas: Vec<CliQuotaWindow>,
}

#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub language: String,
    pub width: usize,
    pub color: bool,
    pub details: bool,
    pub light_background: bool,
    pub now_ms: i64,
}

#[derive(Debug, Clone)]
struct TextSegment {
    text: String,
    code: String,
    bold: bool,
    dim: bool,
}

#[derive(Debug, Clone)]
struct QuotaGroupWindow {
    quota: CliQuotaWindow,
    window: Option<String>,
}

#[derive(Debug, Clone)]
struct QuotaGroup {
    id: String,
    name: String,
    code: &'static str,
    known: bool,
    windows: Vec<QuotaGroupWindow>,
}

struct Labels {
    context: &'static str,
    short_context: &'static str,
    cache: &'static str,
    read: &'static str,
    capacity: &'static str,
    created: &'static str,
    input: &'static str,
    output: &'static str,
    left: &'static str,
    quota: &'static str,
    week: &'static str,
    unknown: &'static str,
    idle: &'static str,
    thinking: &'static str,
    working: &'static str,
    tool_use: &'static str,
    initializing: &'static str,
}

const LABELS_EN: Labels = Labels {
    context: "Context",
    short_context: "Ctx",
    cache: "Cache",
    read: "read",
    capacity: "Capacity",
    created: "Cache write",
    input: "Input",
    output: "Output",
    left: "left",
    quota: "Quota",
    week: "week",
    unknown: "Unknown",
    idle: "Ready",
    thinking: "Thinking",
    working: "Working",
    tool_use: "Tool",
    initializing: "Starting",
};

const LABELS_ZH: Labels = Labels {
    context: "上下文",
    short_context: "上下文",
    cache: "缓存",
    read: "读取",
    capacity: "容量",
    created: "缓存写入",
    input: "输入",
    output: "输出",
    left: "剩余",
    quota: "额度",
    week: "周",
    unknown: "未知",
    idle: "就绪",
    thinking: "思考中",
    working: "生成中",
    tool_use: "工具",
    initializing: "启动中",
};

pub fn parse_options(args: &[String]) -> Result<CliOptions, &'static str> {
    let mut opts = CliOptions::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--preview" => opts.preview = true,
            "--details" | "--full" => {
                opts.details = true;
                opts.compact = false;
            }
            "--compact" => {
                opts.compact = true;
                opts.details = false;
            }
            "--json" => opts.json = true,
            "--help" | "-h" => opts.help = true,
            "--no-color" => opts.no_color = true,
            "--snapshot" => opts.snapshot = true,
            "--language" => {
                i += 1;
                let value = args.get(i).ok_or("Invalid option")?;
                if value != "en" && value != "zh-CN" {
                    return Err("Invalid option");
                }
                opts.language = Some(value.clone());
            }
            "--width" => {
                i += 1;
                let value = args.get(i).ok_or("Invalid option")?;
                let parsed: usize = value.parse().map_err(|_| "Invalid option")?;
                if parsed < 1 || parsed > 500 {
                    return Err("Invalid option");
                }
                opts.width = Some(parsed);
            }
            "--instance" => {
                i += 1;
                let value = args.get(i).ok_or("Invalid option")?;
                if value != "pro" && value != "vertex" && value != "all" {
                    return Err("Invalid option");
                }
                opts.instance = Some(value.clone());
            }
            "--stale-minutes" => {
                i += 1;
                let value = args.get(i).ok_or("Invalid option")?;
                let parsed: u64 = value.parse().map_err(|_| "Invalid option")?;
                opts.stale_minutes = Some(parsed);
            }
            _ => return Err("Invalid option"),
        }
        i += 1;
    }
    Ok(opts)
}

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(|v| v.as_object())
}

fn non_negative_number(value: Option<&Value>) -> Option<f64> {
    let v = value?.as_f64()?;
    if v.is_finite() && v >= 0.0 {
        Some(v)
    } else {
        None
    }
}

fn token_count(value: Option<&Value>) -> Option<u64> {
    let val = value?;
    if let Some(u) = val.as_u64() {
        (u <= MAX_SAFE_INT).then_some(u)
    } else if let Some(f) = val.as_f64() {
        if f.is_finite() && f >= 0.0 && f.fract() == 0.0 && f <= MAX_SAFE_INT as f64 {
            Some(f as u64)
        } else {
            None
        }
    } else {
        None
    }
}

fn is_busy_state(state: &str) -> bool {
    matches!(state, "thinking" | "working" | "tool_use" | "initializing")
}

fn is_known_state(state: &str) -> bool {
    matches!(
        state,
        "idle" | "thinking" | "working" | "tool_use" | "initializing"
    )
}

fn eq_sep_ascii(b: u8, allow_dot: bool) -> bool {
    b == b'-' || b == b' ' || (allow_dot && b == b'.')
}

fn matches_sonnet_4_6(identity: &str) -> bool {
    let s = identity.trim().to_ascii_lowercase();
    let bytes = s.as_bytes();
    if !bytes.starts_with(b"claude") || bytes.len() < 17 {
        return false;
    }
    let mut i = 6;
    if !eq_sep_ascii(bytes[i], false) {
        return false;
    }
    i += 1;
    if !bytes[i..].starts_with(b"sonnet") {
        return false;
    }
    i += 6;
    if i >= bytes.len() || !eq_sep_ascii(bytes[i], false) {
        return false;
    }
    i += 1;
    if i + 2 >= bytes.len()
        || bytes[i] != b'4'
        || !eq_sep_ascii(bytes[i + 1], true)
        || bytes[i + 2] != b'6'
    {
        return false;
    }
    let rest = &bytes[i + 3..];
    rest.is_empty() || rest == b" (thinking)"
}

fn matches_gpt_oss_120b(identity: &str) -> bool {
    let s = identity.trim().to_ascii_lowercase();
    let bytes = s.as_bytes();
    if !bytes.starts_with(b"gpt-oss") || bytes.len() < 12 {
        return false;
    }
    let mut i = 7;
    if !eq_sep_ascii(bytes[i], false) {
        return false;
    }
    i += 1;
    if !bytes[i..].starts_with(b"120b") {
        return false;
    }
    let rest = &bytes[i + 4..];
    rest.is_empty() || rest == b"-medium" || rest == b" (medium)"
}

fn matches_gemini_3_8_flash_high(identity: &str) -> bool {
    let s = identity.trim().to_ascii_lowercase();
    s == "gemini-3.8-flash-high" || s == "gemini 3.8 flash (high)"
}

fn compute_cache_rate(
    model: Option<&Map<String, Value>>,
    version: Option<&Value>,
    input: Option<u64>,
    read: Option<u64>,
    write: Option<u64>,
    state: Option<&str>,
    snapshot_source: Option<&str>,
) -> CliCacheRate {
    let unavailable = |reason: &str| CliCacheRate {
        percentage: None,
        basis: None,
        reason: Some(reason.to_string()),
    };

    let (Some(input), Some(read), Some(write)) = (input, read, write) else {
        return unavailable("missing-or-invalid-counts");
    };

    if read == 0 && state.is_some_and(is_busy_state) {
        return unavailable("awaiting-stable-usage");
    }

    let total = match input.checked_add(read).and_then(|s| s.checked_add(write)) {
        Some(t) if t <= MAX_SAFE_INT => t,
        _ => return unavailable("unsafe-total"),
    };

    if total == 0 {
        return unavailable("empty-input");
    }
    if read == 0 {
        return CliCacheRate {
            percentage: Some(0.0),
            basis: Some("zero-read".to_string()),
            reason: None,
        };
    }
    if snapshot_source == Some("sqlite-cache") {
        return CliCacheRate {
            percentage: Some((read as f64 / total as f64) * 100.0),
            basis: Some("sqlite-cache".to_string()),
            reason: None,
        };
    }
    if write != 0 {
        return unavailable("unverified-cache-write");
    }

    let ver = match version.and_then(|v| v.as_str()) {
        Some(v) if v == "1.3.2" || v == "1.3.3" => v,
        _ => return unavailable("unverified-cli-version"),
    };

    let identity = model
        .and_then(|m| m.get("id").and_then(|v| v.as_str()))
        .filter(|s| !s.trim().is_empty())
        .or_else(|| model.and_then(|m| m.get("display_name").and_then(|v| v.as_str())));

    let supported = match identity {
        Some(id) => {
            matches_sonnet_4_6(id)
                || matches_gpt_oss_120b(id)
                || (ver == "1.3.3" && matches_gemini_3_8_flash_high(id))
        }
        None => false,
    };

    if !supported {
        return unavailable("unverified-model");
    }

    CliCacheRate {
        percentage: Some((read as f64 / total as f64) * 100.0),
        basis: Some(format!("separate-input-cli-{ver}")),
        reason: None,
    }
}

pub fn clean_text(value: Option<&Value>, limit: usize) -> String {
    let Some(raw) = value.and_then(|v| v.as_str()) else {
        return String::new();
    };

    // Strip OSC (\x1b] ... (\x07|\x1b\\|$)) and CSI (\x1b[ ... @-~) sequences.
    let bytes = raw.as_bytes();
    let mut stripped = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            if bytes[i + 1] == b']' {
                i += 2;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            if bytes[i + 1] == b'[' {
                i += 2;
                while i < bytes.len() && (0x30..=0x3f).contains(&bytes[i]) {
                    i += 1;
                }
                while i < bytes.len() && (0x20..=0x2f).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() && (0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                continue;
            }
        }
        stripped.push(bytes[i]);
        i += 1;
    }

    let text = String::from_utf8_lossy(&stripped);
    let mut out = String::with_capacity(text.len().min(limit));
    let mut prev_space = true; // trim leading whitespace
    for ch in text.chars() {
        let code = ch as u32;
        if code <= 0x1f
            || (0x7f..=0x9f).contains(&code)
            || (0x202a..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code)
        {
            continue;
        }
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    let mut utf16_len = 0usize;
    let mut byte_end = 0usize;
    for (idx, ch) in out.char_indices() {
        let u16_len = ch.len_utf16();
        if utf16_len + u16_len > limit {
            break;
        }
        utf16_len += u16_len;
        byte_end = idx + ch.len_utf8();
    }
    out[..byte_end].to_string()
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 59 {
        return None;
    }
    let mut idx = 19;
    let mut millis: i64 = 0;
    if idx < b.len() && b[idx] == b'.' {
        idx += 1;
        let frac_start = idx;
        while idx < b.len() && b[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac = &s[frac_start..idx];
        if frac.is_empty() {
            return None;
        }
        let mut mul = 100i64;
        for d in frac.bytes().take(3) {
            millis += ((d - b'0') as i64) * mul;
            mul /= 10;
        }
    }
    let mut tz_offset_ms: i64 = 0;
    if idx < b.len() {
        if b[idx] == b'Z' || b[idx] == b'z' {
            idx += 1;
        } else if b[idx] == b'+' || b[idx] == b'-' {
            let sign = if b[idx] == b'+' { 1i64 } else { -1i64 };
            idx += 1;
            let tz_h: i64 = s.get(idx..idx + 2)?.parse().ok()?;
            idx += 2;
            if idx < b.len() && b[idx] == b':' {
                idx += 1;
            }
            let tz_m: i64 = if idx + 2 <= b.len() {
                let v = s.get(idx..idx + 2)?.parse().ok()?;
                idx += 2;
                v
            } else {
                0
            };
            if tz_h > 23 || tz_m > 59 {
                return None;
            }
            tz_offset_ms = sign * ((tz_h * 60 + tz_m) * 60_000);
        }
    }
    if idx != b.len() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + min * 60 + sec;
    Some(secs * 1_000 + millis - tz_offset_ms)
}

pub fn normalize(payload: &Value) -> Result<CliNormalizedMetrics, &'static str> {
    let raw = payload.as_object().ok_or("Invalid status payload")?;
    let context = as_object(raw.get("context_window"));
    let usage = as_object(context.and_then(|c| c.get("current_usage")));
    let model = as_object(raw.get("model"));

    let input = token_count(usage.and_then(|u| u.get("input_tokens")));
    let read = token_count(usage.and_then(|u| u.get("cache_read_input_tokens")));
    let write = token_count(usage.and_then(|u| u.get("cache_creation_input_tokens")));
    let used = non_negative_number(context.and_then(|c| c.get("used_percentage")));
    let remaining = non_negative_number(context.and_then(|c| c.get("remaining_percentage")));

    let mut quotas = Vec::new();
    if let Some(quota_map) = as_object(raw.get("quota")) {
        for (key, item) in quota_map.iter().take(16) {
            let id = clean_text(Some(&Value::String(key.clone())), 64);
            if id.is_empty() {
                continue;
            }
            let value_obj = as_object(Some(item));
            let fraction = non_negative_number(value_obj.and_then(|v| v.get("remaining_fraction")));
            let remaining_pct = fraction.filter(|&f| f <= 1.0).map(|f| f * 100.0);
            let reset_in_seconds =
                non_negative_number(value_obj.and_then(|v| v.get("reset_in_seconds")));
            let reset_time = value_obj
                .and_then(|v| v.get("reset_time"))
                .and_then(|v| v.as_str())
                .and_then(parse_iso_ms);
            quotas.push(CliQuotaWindow {
                id,
                remaining: remaining_pct,
                reset_in_seconds,
                reset_time,
            });
        }
    }

    let raw_state = raw.get("agent_state").and_then(|v| v.as_str());
    let state = raw_state
        .filter(|s| is_known_state(s))
        .map(|s| s.to_string());

    let width = raw
        .get("terminal_width")
        .and_then(|v| token_count(Some(v)))
        .filter(|&w| w > 0)
        .map(|w| (w as usize).min(500))
        .unwrap_or(80);

    let model_name = model
        .and_then(|m| {
            let disp = m.get("display_name").filter(|v| {
                v.as_str().is_some_and(|s| !s.is_empty())
            });
            disp.or_else(|| m.get("id"))
        })
        .map(|v| clean_text(Some(v), 120))
        .filter(|s| !s.is_empty());

    let used_percentage = used.or_else(|| remaining.filter(|&r| r <= 100.0).map(|r| 100.0 - r));
    let capacity = token_count(context.and_then(|c| c.get("context_window_size"))).filter(|&v| v > 0);
    let output = token_count(usage.and_then(|u| u.get("output_tokens")));
    let snapshot_source = raw.get("snapshot_source").and_then(|v| v.as_str());
    let cache_rate = compute_cache_rate(
        model,
        raw.get("version"),
        input,
        read,
        write,
        raw_state,
        snapshot_source,
    );

    Ok(CliNormalizedMetrics {
        model: model_name,
        state,
        width,
        context: CliContextMetrics {
            used_percentage,
            capacity,
        },
        cache_read_tokens: read,
        cache_creation_tokens: write,
        cache_rate,
        input_tokens: input,
        output_tokens: output,
        quotas,
    })
}

fn format_trimmed_1(val: f64) -> String {
    if !val.is_finite() {
        return "--".to_string();
    }
    let scaled = (val * 10.0).round();
    if !scaled.is_finite() {
        return if val.is_sign_negative() { "-Infinity" } else { "Infinity" }.to_string();
    }
    let rounded = scaled / 10.0;
    let rounded = if rounded == -0.0 { 0.0 } else { rounded };
    let s = format!("{rounded:.1}");
    s.strip_suffix(".0").unwrap_or(&s).to_string()
}

pub fn compact(value: Option<u64>) -> String {
    match value {
        None => "--".to_string(),
        Some(v) if v >= 1_000_000 => format!("{}M", format_trimmed_1(v as f64 / 1_000_000.0)),
        Some(v) if v >= 1_000 => format!("{}K", format_trimmed_1(v as f64 / 1_000.0)),
        Some(v) => v.to_string(),
    }
}

pub fn percentage(value: Option<f64>) -> String {
    match value {
        None => "--".to_string(),
        Some(v) => format!("{}%", format_trimmed_1(v)),
    }
}

pub fn countdown(quota: &CliQuotaWindow, now_ms: i64) -> Option<String> {
    let seconds = if let Some(rt) = quota.reset_time {
        (rt.saturating_sub(now_ms) as f64 / 1000.0).max(0.0)
    } else if let Some(rs) = quota.reset_in_seconds {
        rs
    } else {
        return None;
    };
    if seconds < 60.0 {
        Some("<1m".to_string())
    } else if seconds < 3600.0 {
        Some(format!("{}m", (seconds / 60.0).ceil() as u64))
    } else if seconds < 86_400.0 {
        let h = (seconds / 3600.0).floor() as u64;
        let m = ((seconds % 3600.0) / 60.0).floor() as u64;
        Some(format!("{h}h{m}m"))
    } else {
        let d = (seconds / 86_400.0).floor() as u64;
        let h = ((seconds % 86_400.0) / 3600.0).floor() as u64;
        Some(format!("{d}d{h}h"))
    }
}

fn is_combining_mark(ch: char) -> bool {
    let c = ch as u32;
    (0x0300..=0x036F).contains(&c)
        || (0x1AB0..=0x1AFF).contains(&c)
        || (0x1DC0..=0x1DFF).contains(&c)
        || (0x20D0..=0x20FF).contains(&c)
        || (0xFE20..=0xFE2F).contains(&c)
        || (0xFE00..=0xFE0F).contains(&c)
        || (0xE0100..=0xE01EF).contains(&c)
}

fn is_regional_indicator(ch: char) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&(ch as u32))
}

fn is_extended_pictographic(ch: char) -> bool {
    let c = ch as u32;
    (0x1F300..=0x1FAFF).contains(&c)
        || (0x2600..=0x27BF).contains(&c)
        || (0x231A..=0x231B).contains(&c)
        || (0x23E9..=0x23F3).contains(&c)
        || (0x23F8..=0x23FA).contains(&c)
        || (0x25AA..=0x25AB).contains(&c)
        || c == 0x25B6
        || c == 0x25C0
        || (0x25FB..=0x25FE).contains(&c)
        || c == 0x2B50
        || c == 0x2B55
        || c == 0x3030
        || c == 0x303D
        || c == 0x3297
        || c == 0x3299
}

fn is_emoji_modifier(ch: char) -> bool {
    (0x1F3FB..=0x1F3FF).contains(&(ch as u32))
}

fn split_graphemes(text: &str) -> Vec<&str> {
    let mut clusters = Vec::new();
    let mut start = 0usize;
    let mut prev_ch: Option<char> = None;
    let mut ri_count = 0usize;

    for (idx, ch) in text.char_indices() {
        let join = match prev_ch {
            None => true,
            Some(prev) => {
                is_combining_mark(ch)
                    || is_emoji_modifier(ch)
                    || ch == '\u{200D}'
                    || ch == '\u{20E3}'
                    || prev == '\u{200D}'
                    || (is_regional_indicator(prev) && is_regional_indicator(ch) && ri_count % 2 == 1)
            }
        };
        if !join {
            clusters.push(&text[start..idx]);
            start = idx;
            ri_count = 0;
        }
        if is_regional_indicator(ch) {
            ri_count += 1;
        } else if !is_combining_mark(ch) && !is_emoji_modifier(ch) && ch != '\u{200D}' {
            ri_count = 0;
        }
        prev_ch = Some(ch);
    }
    if start < text.len() {
        clusters.push(&text[start..]);
    }
    clusters
}

fn cell_width(cluster: &str) -> usize {
    if cluster.chars().all(is_combining_mark) {
        return 0;
    }
    if cluster
        .chars()
        .any(|c| is_extended_pictographic(c) || is_regional_indicator(c) || c == '\u{20e3}')
    {
        return 2;
    }
    let code = cluster.chars().next().map(|c| c as u32).unwrap_or(0);
    if code >= 0x1100
        && (code <= 0x115f
            || code == 0x2329
            || code == 0x232a
            || ((0x2e80..=0xa4cf).contains(&code) && code != 0x303f)
            || (0xac00..=0xd7a3).contains(&code)
            || (0xf900..=0xfaff).contains(&code)
            || (0xfe10..=0xfe19).contains(&code)
            || (0xfe30..=0xfe6f).contains(&code)
            || (0xff00..=0xff60).contains(&code)
            || (0xffe0..=0xffe6).contains(&code)
            || (0x20000..=0x3fffd).contains(&code))
    {
        2
    } else {
        1
    }
}

pub fn display_width(text: &str) -> usize {
    split_graphemes(text).into_iter().map(cell_width).sum()
}

pub fn truncate(text: &str, width: usize) -> String {
    if display_width(text) <= width {
        return text.to_string();
    }
    let mut result = String::new();
    let mut used = 0usize;
    for item in split_graphemes(text) {
        let size = cell_width(item);
        if used + size > width.saturating_sub(1) {
            break;
        }
        result.push_str(item);
        used += size;
    }
    if width > 0 {
        result.push('…');
    }
    result
}
fn part(text: impl Into<String>, code: &str, bold: bool, dim: bool) -> TextSegment {
    TextSegment {
        text: text.into(),
        code: code.to_string(),
        bold,
        dim,
    }
}

fn subtle(text: impl Into<String>) -> TextSegment {
    part(text, "39", false, true)
}

fn plain_text(parts: &[TextSegment]) -> String {
    let mut s = String::new();
    for item in parts {
        s.push_str(&item.text);
    }
    s
}

fn fit_segments(parts: &[TextSegment], max_cols: usize) -> Vec<TextSegment> {
    if display_width(&plain_text(parts)) <= max_cols {
        return parts.to_vec();
    }
    let mut result = Vec::new();
    let mut left = max_cols.saturating_sub(1);
    for item in parts {
        let mut text = String::new();
        for cluster in split_graphemes(&item.text) {
            let size = cell_width(cluster);
            if size > left {
                break;
            }
            text.push_str(cluster);
            left -= size;
        }
        if !text.is_empty() {
            result.push(TextSegment {
                text: text.clone(),
                code: item.code.clone(),
                bold: item.bold,
                dim: item.dim,
            });
        }
        if text != item.text {
            break;
        }
    }
    result.push(subtle("…"));
    result
}

fn paint_segments(parts: &[TextSegment], max_cols: usize, color: bool) -> String {
    let fitted = fit_segments(parts, max_cols);
    let mut out = String::new();
    for item in fitted {
        if color {
            let prefix = if item.bold {
                "1;"
            } else if item.dim {
                "2;"
            } else {
                ""
            };
            out.push_str(&format!("\x1b[{prefix}{}m{}\x1b[0m", item.code, item.text));
        } else {
            out.push_str(&item.text);
        }
    }
    out
}

fn progress_bar(value: Option<f64>, code: &str, size: usize) -> Vec<TextSegment> {
    let Some(v) = value else {
        return Vec::new();
    };
    let filled = (((v / 100.0) * size as f64).round() as isize).clamp(0, size as isize) as usize;
    vec![
        part("█".repeat(filled), code, false, false),
        subtle("░".repeat(size - filled)),
    ]
}

fn starts_with_ci_word(s: &str, word: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    if !lower.starts_with(word) {
        return false;
    }
    lower[word.len()..]
        .chars()
        .next()
        .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
}

fn detect_active_family(model: Option<&str>) -> Option<&'static str> {
    let m = model?;
    if starts_with_ci_word(m, "gemini") {
        return Some("gemini");
    }
    if starts_with_ci_word(m, "claude") || starts_with_ci_word(m, "gpt") {
        return Some("3p");
    }
    let lower = m.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'o' && matches!(bytes[1], b'1' | b'3' | b'4') {
        if bytes.len() == 2 || bytes[2] == b'-' {
            return Some("3p");
        }
    }
    None
}

pub fn render(metrics: &CliNormalizedMetrics, opts: &RenderOptions) -> String {
    let l = if opts.language == "zh-CN" {
        &LABELS_ZH
    } else {
        &LABELS_EN
    };
    let max_cols = opts.width.clamp(1, 500);

    let used = metrics.context.used_percentage;
    let level = match used {
        Some(u) if u >= 90.0 => "31",
        Some(u) if u >= 60.0 => "33",
        _ => "36",
    };
    let rate = metrics.cache_rate.percentage;

    let main_row = |bars: bool, reads: bool, short: bool| -> Vec<TextSegment> {
        let mut row = vec![
            part(format!("{} ", if short { l.short_context } else { l.context }), "39", false, false),
            part(percentage(used), if used.is_none() { "39" } else { level }, true, false),
        ];
        if used.is_some_and(|u| u >= 90.0) {
            row.push(part(" !", "31", true, false));
        }
        if bars && used.is_some() {
            row.push(subtle("  "));
            row.extend(progress_bar(used, level, 8));
        }
        row.push(subtle(if short { " │ " } else { "   │   " }));
        row.push(part(format!("{} ", l.cache), "39", false, false));
        row.push(part(
            percentage(rate),
            if rate.is_none() { "39" } else { "35" },
            true,
            false,
        ));
        if reads && metrics.cache_rate.reason.as_deref() != Some("awaiting-stable-usage") {
            row.push(subtle(format!(" · {} {}", compact(metrics.cache_read_tokens), l.read)));
        }
        row
    };

    let mut main = main_row(max_cols >= 60, true, false);
    if display_width(&plain_text(&main)) > max_cols {
        main = main_row(false, true, false);
    }
    if display_width(&plain_text(&main)) > max_cols {
        main = main_row(false, false, false);
    }
    if display_width(&plain_text(&main)) > max_cols {
        main = main_row(false, false, true);
    }

    let state_label = match metrics.state.as_deref() {
        Some("idle") => l.idle,
        Some("thinking") => l.thinking,
        Some("working") => l.working,
        Some("tool_use") => l.tool_use,
        Some("initializing") => l.initializing,
        _ => l.unknown,
    };
    let state_segs = vec![
        subtle("   ·   "),
        part(
            state_label,
            if metrics.state.as_deref() == Some("idle") { "32" } else { "33" },
            false,
            false,
        ),
    ];
    let mut main_with_state = main.clone();
    main_with_state.extend(state_segs.clone());
    if display_width(&plain_text(&main_with_state)) <= max_cols {
        main = main_with_state;
    }

    let mut groups: BTreeMap<String, QuotaGroup> = BTreeMap::new();
    let mut group_order: Vec<String> = Vec::new();
    for quota in &metrics.quotas {
        let (id, name, window_label, code, known) = match quota.id.as_str() {
            "gemini-5h" => ("gemini", "Gemini", Some("5h"), "36", true),
            "gemini-weekly" => ("gemini", "Gemini", Some(l.week), "36", true),
            "3p-5h" => ("3p", "Claude/GPT", Some("5h"), "35", true),
            "3p-weekly" => ("3p", "Claude/GPT", Some(l.week), "35", true),
            other => (other, other, None, "36", false),
        };
        if !groups.contains_key(id) {
            group_order.push(id.to_string());
            groups.insert(
                id.to_string(),
                QuotaGroup {
                    id: id.to_string(),
                    name: name.to_string(),
                    code,
                    known,
                    windows: Vec::new(),
                },
            );
        }
        groups.get_mut(id).unwrap().windows.push(QuotaGroupWindow {
            quota: quota.clone(),
            window: window_label.map(|s| s.to_string()),
        });
    }

    let active = detect_active_family(metrics.model.as_deref());
    let mut sorted: Vec<QuotaGroup> = group_order
        .into_iter()
        .filter_map(|id| groups.remove(&id))
        .collect();
    sorted.sort_by(|a, b| {
        let a_active = u8::from(active == Some(a.id.as_str()));
        let b_active = u8::from(active == Some(b.id.as_str()));
        b_active
            .cmp(&a_active)
            .then_with(|| u8::from(b.known).cmp(&u8::from(a.known)))
            .then_with(|| a.name.cmp(&b.name))
    });

    let quota_row = |group: &QuotaGroup, bars: bool, resets: bool| -> Vec<TextSegment> {
        let mut row = if group.id == "3p" && group.known {
            vec![
                part("Claude", "38;2;218;119;86", true, false),
                subtle("/"),
                part(
                    "GPT",
                    if opts.light_background { "39" } else { "38;2;248;250;252" },
                    true,
                    false,
                ),
                part(" ", "39", false, false),
            ]
        } else {
            let mut label = if group.known {
                group.name.clone()
            } else {
                format!("{} ", group.name)
            };
            if group.known && label.chars().count() < 11 {
                label.push_str(&" ".repeat(11 - label.chars().count()));
            }
            vec![part(label, group.code, true, false)]
        };
        row.push(subtle(format!("{}  ", l.left)));

        let mut windows = group.windows.clone();
        windows.sort_by_key(|w| if w.window.as_deref() == Some("5h") { 0 } else { 1 });

        for (index, item) in windows.iter().enumerate() {
            if index > 0 {
                row.push(subtle("   │   "));
            }
            if let Some(win) = &item.window {
                row.push(part(format!("{win} "), "39", false, false));
            }
            let rem = item.quota.remaining;
            let alert = rem.is_some_and(|r| r < 30.0);
            let code = match rem {
                None => "39",
                Some(r) if r >= 70.0 => "32",
                Some(r) if r >= 30.0 => "33",
                _ => "31",
            };
            row.push(part(percentage(rem), code, true, false));
            if alert {
                row.push(part(" !", code, true, false));
            }
            if bars && rem.is_some() {
                row.push(subtle(" "));
                row.extend(progress_bar(rem, code, 5));
            }
            if resets {
                if let Some(reset) = countdown(&item.quota, opts.now_ms) {
                    row.push(subtle(format!("  ↻ {reset}")));
                }
            }
        }
        row
    };

    let mut lines = vec![paint_segments(&main, max_cols, opts.color)];
    if sorted.is_empty() {
        lines.push(paint_segments(&[subtle(format!("{} --", l.quota))], max_cols, opts.color));
    }
    let total_groups = sorted.len();
    for (idx, group) in sorted.iter().take(2).enumerate() {
        let mut row = quota_row(group, max_cols >= 100, max_cols >= 80);
        if display_width(&plain_text(&row)) > max_cols {
            row = quota_row(group, false, max_cols >= 80);
        }
        if display_width(&plain_text(&row)) > max_cols {
            row = quota_row(group, false, false);
        }
        if total_groups > 2 && idx == 1 {
            row.push(subtle(format!("  … +{}", total_groups - 2)));
        }
        lines.push(paint_segments(&row, max_cols, opts.color));
    }
    if opts.details {
        let model_label = metrics.model.as_deref().unwrap_or("Antigravity");
        let more = format!(
            "{model_label} · {} {} · {} {} · {} {} · {} {}",
            l.capacity,
            compact(metrics.context.capacity),
            l.input,
            compact(metrics.input_tokens),
            l.output,
            compact(metrics.output_tokens),
            l.created,
            compact(metrics.cache_creation_tokens)
        );
        lines.push(paint_segments(&[subtle(more)], max_cols, opts.color));
    }
    lines.join("\n")
}
fn resolve_home_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    } else {
        env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }
}

fn resolve_local_data_dir() -> Option<PathBuf> {
    let home = resolve_home_dir();
    if cfg!(target_os = "windows") {
        env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join("AppData").join("Local")))
    } else if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library").join("Application Support"))
    } else {
        env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".local").join("share")))
    }
}

fn read_saved_language_from_path(pref_path: &Path) -> Option<String> {
    let raw = fs::read_to_string(pref_path).ok()?;
    let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    let parsed: Value = serde_json::from_str(trimmed).ok()?;
    let obj = parsed.as_object()?;
    if obj.get("schema").and_then(|v| v.as_i64()) != Some(1) {
        return None;
    }
    let lang = obj.get("language").and_then(|v| v.as_str())?;
    if lang == "en" || lang == "zh-CN" {
        Some(lang.to_string())
    } else {
        None
    }
}

fn read_saved_language() -> String {
    resolve_local_data_dir()
        .map(|dir| dir.join("AntigravityPulse").join("preferences.json"))
        .and_then(|p| read_saved_language_from_path(&p))
        .unwrap_or_else(|| "en".to_string())
}

fn resolve_instance_data_dir(instance: &str) -> Option<PathBuf> {
    if instance == "pro" {
        if let Some(override_dir) = env::var_os("ANTIGRAVITY_EXECUTABLE_DATA_DIR").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(override_dir));
        }
    }
    let home = resolve_home_dir()?;
    let eff_home = if instance == "vertex" {
        home.join(".antigravity-vertex").join("home")
    } else {
        home
    };
    Some(
        eff_home
            .join(".gemini")
            .join("antigravity")
            .join("sidecar_data")
            .join("antigravity-pulse")
            .join("panel")
            .join("data"),
    )
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Default)]
struct SnapshotRecord {
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    updated_at_ms: Option<i64>,
    state: Option<String>,
}

fn is_vertex_path_str(p: &str) -> bool {
    let normalized = p.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/.antigravity-vertex/")
}

fn read_sqlite_latest_usage(cache_db_path: &Path, is_vertex: bool) -> Option<SnapshotRecord> {
    if !cache_db_path.is_file() {
        return None;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(cache_db_path, flags).ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    let mut stmt = conn
        .prepare(
            "SELECT db_path, payload_json, updated_at_ms FROM usage_cache ORDER BY updated_at_ms DESC LIMIT 32",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .ok()?;
    let mut chosen: Option<(String, i64)> = None;
    for item in rows {
        let Ok((db_path, payload_json, updated_at_ms)) = item else {
            continue;
        };
        if is_vertex_path_str(&db_path) == is_vertex {
            chosen = Some((payload_json, updated_at_ms));
            break;
        }
    }
    let row = chosen?;
    let parsed: Value = serde_json::from_str(&row.0).ok()?;
    let records = parsed.as_array()?;
    let last = records.last()?.as_object()?;
    Some(SnapshotRecord {
        model: last
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        input_tokens: last.get("uncached").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: last.get("output").and_then(|v| v.as_u64()).unwrap_or(0),
        cache_read_tokens: last.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0),
        cache_creation_tokens: last.get("cacheWrite").and_then(|v| v.as_u64()).unwrap_or(0),
        updated_at_ms: Some(row.1),
        state: Some("idle".to_string()),
    })
}

fn shared_cache_candidates(data_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = env::var_os("PULSE_SHARED_CACHE_PATH").filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(p));
    }
    if let Some(local_db) = data_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("shared-usage-cache-v1.db"))
    {
        out.push(local_db);
    }
    if cfg!(target_os = "windows") {
        if let Some(local) = resolve_local_data_dir() {
            out.push(local.join("antigravity-pulse").join("shared-usage-cache-v1.db"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(xdg) = env::var_os("XDG_CACHE_HOME").filter(|v| !v.is_empty()) {
            out.push(PathBuf::from(xdg).join("antigravity-pulse").join("shared-usage-cache-v1.db"));
        } else if let Some(home) = resolve_home_dir() {
            out.push(
                home.join("Library")
                    .join("Caches")
                    .join("antigravity-pulse")
                    .join("shared-usage-cache-v1.db"),
            );
        }
    } else if let Some(xdg) = env::var_os("XDG_CACHE_HOME").filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(xdg).join("antigravity-pulse").join("shared-usage-cache-v1.db"));
    } else if let Some(home) = resolve_home_dir() {
        out.push(
            home.join(".cache")
                .join("antigravity-pulse")
                .join("shared-usage-cache-v1.db"),
        );
    }
    out
}

fn read_snapshot_for_data_dir(data_dir: &Path, stale_minutes: Option<u64>, now_ms: i64) -> Option<Value> {
    let mut rec = SnapshotRecord::default();

    let health_path = data_dir.join("integration-state.json");
    if let Ok(raw) = fs::read_to_string(&health_path) {
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw.strip_prefix('\u{FEFF}').unwrap_or(&raw)) {
            if let Some(updated_at) = obj.get("updatedAt").and_then(|v| v.as_i64()) {
                rec.updated_at_ms = Some(updated_at);
            }
            if let Some(connected) = obj.get("connected").and_then(|v| v.as_bool()) {
                rec.state = Some(if connected { "idle" } else { "initializing" }.to_string());
            }
        }
    }

    let is_vertex = is_vertex_path_str(&data_dir.to_string_lossy());
    for db_path in shared_cache_candidates(data_dir) {
        if let Some(sql_rec) = read_sqlite_latest_usage(&db_path, is_vertex) {
            rec.model = sql_rec.model.or(rec.model);
            rec.input_tokens = sql_rec.input_tokens;
            rec.output_tokens = sql_rec.output_tokens;
            rec.cache_read_tokens = sql_rec.cache_read_tokens;
            rec.cache_creation_tokens = sql_rec.cache_creation_tokens;
            rec.updated_at_ms = match (rec.updated_at_ms, sql_rec.updated_at_ms) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            if rec.state.is_none() {
                rec.state = sql_rec.state;
            }
            break;
        }
    }

    if rec.model.is_none() && rec.updated_at_ms.is_none() && rec.state.is_none() {
        return None;
    }

    if let (Some(max_mins), Some(updated_ms)) = (stale_minutes, rec.updated_at_ms) {
        let age_ms = now_ms.saturating_sub(updated_ms);
        if age_ms > (max_mins as i64) * 60_000 {
            rec.state = Some("idle".to_string());
        }
    }

    Some(serde_json::json!({
        "snapshot_source": "sqlite-cache",
        "model": { "display_name": rec.model.unwrap_or_else(|| "Antigravity".to_string()) },
        "agent_state": rec.state.unwrap_or_else(|| "idle".to_string()),
        "terminal_width": 100,
        "context_window": {
            "current_usage": {
                "input_tokens": rec.input_tokens,
                "output_tokens": rec.output_tokens,
                "cache_read_input_tokens": rec.cache_read_tokens,
                "cache_creation_input_tokens": rec.cache_creation_tokens
            }
        }
    }))
}

fn read_snapshot_payload(instance: &str, stale_minutes: Option<u64>, now_ms: i64) -> Result<Value, &'static str> {
    let candidates = if instance == "all" {
        vec!["pro", "vertex"]
    } else {
        vec![instance]
    };
    for inst in candidates {
        if let Some(dir) = resolve_instance_data_dir(inst) {
            if let Some(val) = read_snapshot_for_data_dir(&dir, stale_minutes, now_ms) {
                return Ok(val);
            }
        }
    }
    Err("No snapshot available")
}

fn preview_payload() -> Value {
    serde_json::json!({
        "version": "1.3.2",
        "model": { "id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6 (Thinking)" },
        "agent_state": "working",
        "terminal_width": 100,
        "context_window": {
            "used_percentage": 44.2,
            "context_window_size": 1048576,
            "current_usage": {
                "input_tokens": 190,
                "output_tokens": 346,
                "cache_read_input_tokens": 17244,
                "cache_creation_input_tokens": 0
            }
        },
        "quota": {
            "gemini-5h": { "remaining_fraction": 0.72, "reset_in_seconds": 8100 },
            "gemini-weekly": { "remaining_fraction": 0.9378, "reset_in_seconds": 560580 }
        }
    })
}

fn read_stdin_bytes_limited() -> Result<Vec<u8>, &'static str> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let stdin = io::stdin();
    let mut handle = stdin.lock();
    loop {
        let n = handle.read(&mut chunk).map_err(|_| "Read error")?;
        if n == 0 {
            break;
        }
        if buf.len() + n > MAX_INPUT {
            return Err("Oversized input");
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf)
}

fn is_light_background() -> bool {
    let Ok(val) = env::var("COLORFGBG") else {
        return false;
    };
    let tail = val.rsplit(';').next().unwrap_or("");
    tail == "7" || tail == "15"
}

fn run() -> Result<String, &'static str> {
    let args: Vec<String> = env::args().skip(1).collect();
    let opts = parse_options(&args)?;
    if opts.help {
        return Ok(HELP_TEXT.to_string());
    }

    let now_ms = now_epoch_ms();
    let payload: Value = if opts.preview {
        preview_payload()
    } else if opts.snapshot {
        read_snapshot_payload(opts.instance.as_deref().unwrap_or("pro"), opts.stale_minutes, now_ms)?
    } else if (opts.instance.is_some() || opts.stale_minutes.is_some()) && io::stdin().is_terminal() {
        read_snapshot_payload(opts.instance.as_deref().unwrap_or("pro"), opts.stale_minutes, now_ms)?
    } else {
        let bytes = read_stdin_bytes_limited()?;
        if bytes.is_empty() && (opts.instance.is_some() || opts.stale_minutes.is_some()) {
            read_snapshot_payload(opts.instance.as_deref().unwrap_or("pro"), opts.stale_minutes, now_ms)?
        } else {
            let text = std::str::from_utf8(&bytes).map_err(|_| "Invalid UTF-8")?;
            let clean = text.strip_prefix('\u{FEFF}').unwrap_or(text);
            serde_json::from_str(clean).map_err(|_| "Invalid JSON")?
        }
    };

    let metrics = normalize(&payload)?;
    let language = opts.language.unwrap_or_else(read_saved_language);
    let output = if opts.json {
        serde_json::to_string(&metrics).map_err(|_| "Serialize error")?
    } else {
        let color = !opts.no_color
            && env::var_os("NO_COLOR").is_none()
            && env::var("TERM").as_deref() != Ok("dumb");
        render(
            &metrics,
            &RenderOptions {
                language,
                width: opts.width.unwrap_or(metrics.width),
                color,
                details: opts.details && !opts.compact,
                light_background: is_light_background(),
                now_ms,
            },
        )
    };
    Ok(format!("{output}\n"))
}

fn main() {
    match run() {
        Ok(out) => {
            let _ = io::stdout().write_all(out.as_bytes());
        }
        Err(_) => {
            let _ = io::stdout().write_all(b"Antigrative Dashboard: --\n");
            std::process::exit(1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cache_payload(input: Value, read: Value, write: Value, model: Value, version: Value) -> Value {
        json!({
            "version": version,
            "model": model,
            "context_window": {
                "used_percentage": 8.6,
                "total_input_tokens": 999999,
                "total_output_tokens": 888888,
                "current_usage": {
                    "input_tokens": input,
                    "cache_read_input_tokens": read,
                    "cache_creation_input_tokens": write,
                    "output_tokens": 777777
                }
            }
        })
    }

    #[test]
    fn parses_cli_options_and_rejects_invalid() {
        let opts = parse_options(&[
            "--compact".into(),
            "--json".into(),
            "--no-color".into(),
            "--width".into(),
            "120".into(),
            "--instance".into(),
            "vertex".into(),
            "--stale-minutes".into(),
            "15".into(),
        ])
        .unwrap();
        assert!(opts.compact);
        assert!(!opts.details);
        assert!(opts.json);
        assert!(opts.no_color);
        assert_eq!(opts.width, Some(120));
        assert_eq!(opts.instance.as_deref(), Some("vertex"));
        assert_eq!(opts.stale_minutes, Some(15));

        let full = parse_options(&["--full".into()]).unwrap();
        assert!(full.details);
        assert!(!full.compact);

        assert!(parse_options(&["--width".into(), "0".into()]).is_err());
        assert!(parse_options(&["--width".into(), "501".into()]).is_err());
        assert!(parse_options(&["--language".into(), "fr".into()]).is_err());
        assert!(parse_options(&["--instance".into(), "other".into()]).is_err());
        assert!(parse_options(&["--unknown".into()]).is_err());
    }

    #[test]
    fn cache_policy_matches_ts_semantics() {
        let m1 = normalize(&cache_payload(
            json!(190),
            json!(17244),
            json!(0),
            json!({ "id": "claude-sonnet-4-6" }),
            json!("1.3.2"),
        ))
        .unwrap();
        assert!((m1.cache_rate.percentage.unwrap() - 98.9101755).abs() < 0.005);

        let m2 = normalize(&cache_payload(
            json!(2100),
            json!(130000),
            json!(0),
            json!({ "id": "gemini-3.8-flash-high" }),
            json!("1.3.3"),
        ))
        .unwrap();
        assert!((m2.cache_rate.percentage.unwrap() - (130000.0 / 132100.0 * 100.0)).abs() < 0.001);

        let m2_old = normalize(&cache_payload(
            json!(2100),
            json!(130000),
            json!(0),
            json!({ "id": "gemini-3.8-flash-high" }),
            json!("1.3.2"),
        ))
        .unwrap();
        assert_eq!(m2_old.cache_rate.percentage, None);
        assert_eq!(m2_old.cache_rate.reason.as_deref(), Some("unverified-model"));

        let mut busy = cache_payload(
            json!(2100),
            json!(0),
            json!(0),
            json!({ "id": "claude-sonnet-4-6" }),
            json!("1.3.2"),
        );
        busy.as_object_mut()
            .unwrap()
            .insert("agent_state".into(), json!("working"));
        let busy_norm = normalize(&busy).unwrap();
        assert_eq!(
            busy_norm.cache_rate.reason.as_deref(),
            Some("awaiting-stable-usage")
        );
        assert_eq!(busy_norm.cache_rate.percentage, None);

        let invalid_float = normalize(&cache_payload(
            json!(0.5),
            json!(10),
            json!(0),
            json!({ "id": "claude-sonnet-4-6" }),
            json!("1.3.2"),
        ))
        .unwrap();
        assert_eq!(
            invalid_float.cache_rate.reason.as_deref(),
            Some("missing-or-invalid-counts")
        );
    }

    #[test]
    fn clean_text_and_display_width_match_ts() {
        let hostile = "\x1b]0;SECRET_TITLE\x07\x1b[31mGemini\n\r\x08\u{202e}";
        assert_eq!(clean_text(Some(&json!(hostile)), 120), "Gemini");
        assert_eq!(display_width("中文"), 4);
        assert_eq!(display_width("e\u{0301}"), 1);
        assert_eq!(display_width("👨‍👩‍👧‍👦"), 2);
        assert_eq!(truncate("A🧪B", 3), "A…");
    }

    #[test]
    fn ansi_and_plain_rendering_match_ts() {
        let payload = json!({
            "version": "1.3.2",
            "model": { "id": "claude-sonnet-4-6" },
            "agent_state": "working",
            "context_window": {
                "used_percentage": 95,
                "context_window_size": 1000000,
                "current_usage": {
                    "input_tokens": 6000,
                    "cache_read_input_tokens": 24000,
                    "cache_creation_input_tokens": 0,
                    "output_tokens": 500
                }
            },
            "quota": {
                "gemini-5h": { "remaining_fraction": 0.08, "reset_in_seconds": 3600 }
            }
        });
        let metrics = normalize(&payload).unwrap();
        let colored = render(
            &metrics,
            &RenderOptions {
                language: "en".into(),
                width: 120,
                color: true,
                details: true,
                light_background: false,
                now_ms: 0,
            },
        );
        let plain = render(
            &metrics,
            &RenderOptions {
                language: "en".into(),
                width: 120,
                color: false,
                details: true,
                light_background: false,
                now_ms: 0,
            },
        );
        assert!(colored.contains("\x1b[1;31m95%"));
        assert!(colored.contains("\x1b[1;35m80%"));
        assert!(colored.contains("\x1b[2;39m · 24K read"));
        assert!(colored.contains("\x1b[1;31m8%"));
        assert!(plain.contains("Capacity 1M"));

        // Narrow width guarantee
        for w in [1, 10, 20, 30, 55, 80, 100] {
            let text = render(
                &metrics,
                &RenderOptions {
                    language: "zh-CN".into(),
                    width: w,
                    color: false,
                    details: true,
                    light_background: false,
                    now_ms: 0,
                },
            );
            for line in text.lines() {
                assert!(display_width(line) <= w, "width={w} exceeded by {line}");
            }
        }
    }

    #[test]
    fn snapshot_reader_reads_sqlite_cache_and_health() {
        let dir = env::temp_dir().join(format!("pulse-statusline-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let data_dir = dir.join("panel").join("data");
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("integration-state.json"),
            r#"{"connected":true,"updatedAt":1776429000000}"#,
        )
        .unwrap();

        let db_path = dir.join("shared-usage-cache-v1.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE usage_cache (db_path TEXT PRIMARY KEY, db_mtime_ms INTEGER NOT NULL, db_size_bytes INTEGER NOT NULL, wal_mtime_ms INTEGER NOT NULL, wal_size_bytes INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_cache VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "/tmp/cid-1.sqlite",
                1000i64,
                2048i64,
                0i64,
                0i64,
                r#"[{"model":"Claude Sonnet 4.6","uncached":100,"cacheRead":900,"cacheWrite":0,"output":50}]"#,
                1776429005000i64
            ],
        )
        .unwrap();
        drop(conn);

        let snap = read_snapshot_for_data_dir(&data_dir, Some(15), 1776429010000).unwrap();
        let norm = normalize(&snap).unwrap();
        assert_eq!(norm.model.as_deref(), Some("Claude Sonnet 4.6"));
        assert_eq!(norm.input_tokens, Some(100));
        assert_eq!(norm.cache_read_tokens, Some(900));
        assert_eq!(norm.output_tokens, Some(50));
        assert_eq!(norm.cache_rate.percentage, Some(90.0));
        assert_eq!(norm.cache_rate.basis.as_deref(), Some("sqlite-cache"));
        assert_eq!(norm.cache_rate.reason, None);

        let _ = fs::remove_dir_all(&dir);
    }
}
