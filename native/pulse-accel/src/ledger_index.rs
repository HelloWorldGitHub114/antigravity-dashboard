use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

const LEDGER_CACHE_FILE: &str = "ledger-compact-v1.bin";
const LEDGER_CACHE_MAGIC: &[u8; 8] = b"AGPLDG01";
const LEDGER_CACHE_VERSION: u32 = 1;
const MAX_LEDGER_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;
const PARALLEL_DIRTY_THRESHOLD: usize = 8;
const LEGACY_DISPLAY_NAME: &str = "早期历史未区分用量";

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownAccountInfo {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub primary: Option<bool>,
    #[serde(default)]
    pub secondary: Option<bool>,
    #[serde(default)]
    pub added_at: Option<f64>,
    #[serde(default)]
    pub created_at: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TzTransition {
    pub at_ms: i64,
    pub offset_secs: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSummaryQuery {
    pub directory: String,
    pub scope: String,
    pub now_ms: i64,
    pub today: String,
    pub time_zone: String,
    pub source: String,
    #[serde(default, deserialize_with = "deserialize_known_accounts")]
    pub known_accounts: Vec<(String, KnownAccountInfo)>,
    #[serde(default)]
    pub fallback_scope: Option<String>,
    #[serde(default)]
    pub fixed_offset_secs: Option<i32>,
    #[serde(default)]
    pub tz_min_ms: Option<i64>,
    #[serde(default)]
    pub tz_max_ms: Option<i64>,
    #[serde(default)]
    pub tz_transitions: Option<Vec<TzTransition>>,
    #[serde(default)]
    pub dirty_rel_paths: Vec<String>,
}

fn deserialize_known_accounts<'de, D>(
    deserializer: D,
) -> Result<Vec<(String, KnownAccountInfo)>, D::Error>
where
    D: Deserializer<'de>,
{
    struct KnownAccountsVisitor;

    impl<'de> Visitor<'de> for KnownAccountsVisitor {
        type Value = Vec<(String, KnownAccountInfo)>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a map of known accounts")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut out = Vec::new();
            while let Some((k, v)) = map.next_entry::<String, Value>()? {
                if let Some(info) = parse_known_account_value(&v) {
                    out.push((k, info));
                }
            }
            Ok(out)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(Vec::new())
        }
    }

    deserializer.deserialize_any(KnownAccountsVisitor)
}

fn parse_known_account_value(val: &Value) -> Option<KnownAccountInfo> {
    let obj = val.as_object()?;
    Some(KnownAccountInfo {
        email: obj.get("email").and_then(|v| v.as_str()).map(|s| s.to_string()),
        name: obj.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
        primary: obj.get("primary").and_then(|v| v.as_bool()),
        secondary: obj.get("secondary").and_then(|v| v.as_bool()),
        added_at: obj.get("addedAt").and_then(|v| v.as_f64()),
        created_at: obj.get("createdAt").and_then(|v| v.as_f64()),
    })
}

#[derive(Debug, Clone)]
struct PackedUsageRecord {
    id: String,
    at: Option<i64>,
    model: String,
    uncached: Option<i64>,
    cache_read: Option<i64>,
    cache_write: Option<i64>,
    output: Option<i64>,
    partial: bool,
    is_legacy: bool,
}

impl PackedUsageRecord {
    fn sum(&self) -> i64 {
        self.uncached
            .unwrap_or(0)
            .saturating_add(self.cache_read.unwrap_or(0))
            .saturating_add(self.cache_write.unwrap_or(0))
            .saturating_add(self.output.unwrap_or(0))
    }
}

fn validate_cached_i64(raw: i64) -> Option<Option<i64>> {
    if raw == -1 {
        Some(None)
    } else if (0..=MAX_SAFE_INT).contains(&raw) {
        Some(Some(raw))
    } else {
        None
    }
}

#[derive(Debug, Clone)]
struct ManualEntryMeta {
    doc_id: String,
    timestamp: f64,
    model: String,
    tokens_json: String,
    project_name: String,
    note: String,
}

#[derive(Debug, Clone)]
struct CachedFileEntry {
    scope: String,
    file_name: String,
    mtime_ns: i128,
    file_size: u64,
    unreadable: bool,
    file_marked_legacy: bool,
    manual_meta: Option<ManualEntryMeta>,
    records: Vec<PackedUsageRecord>,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_ledger_file_name(name: &str) -> bool {
    name.len() == 69 && name.ends_with(".json") && is_hex64(&name[..64])
}

fn is_valid_guid(s: &str) -> bool {
    let mut parts = s.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_some() {
            if part.is_empty()
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
            {
                return false;
            }
        } else {
            return part.len() == 36
                && part
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F' | b'-'));
        }
    }
    false
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn opt_non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.is_empty())
}

fn parse_safe_nonneg_int(val: &Value) -> Option<i64> {
    if let Some(n) = val.as_i64() {
        if (0..=MAX_SAFE_INT).contains(&n) {
            return Some(n);
        }
        return None;
    }
    if let Some(n) = val.as_u64() {
        if n <= MAX_SAFE_INT as u64 {
            return Some(n as i64);
        }
        return None;
    }
    if let Some(f) = val.as_f64() {
        if f.is_finite() && f >= 0.0 && f <= MAX_SAFE_INT as f64 && f.fract() == 0.0 {
            return Some(f as i64);
        }
    }
    None
}

fn parse_nullable_safe_int(val: Option<&Value>) -> Result<Option<i64>, ()> {
    match val {
        None => Err(()),
        Some(Value::Null) => Ok(None),
        Some(v) => parse_safe_nonneg_int(v).map(Some).ok_or(()),
    }
}

fn is_js_truthy(val: Option<&Value>) -> bool {
    match val {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Bool(true)) | Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn mtime_ns_from_metadata(meta: &fs::Metadata) -> Option<i128> {
    let mtime = meta.modified().ok()?;
    match mtime.duration_since(UNIX_EPOCH) {
        Ok(d) => Some(d.as_nanos() as i128),
        Err(e) => Some(-(e.duration().as_nanos() as i128)),
    }
}

fn load_accounts_meta(dir: &Path) -> Result<HashMap<String, KnownAccountInfo>, ()> {
    let path = dir.join("accounts-v1.json");
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err(()),
    };
    if bytes.len() > MAX_LEDGER_JSON_BYTES {
        return Ok(HashMap::new());
    }
    let Ok(val) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(HashMap::new());
    };
    let Some(obj) = val.as_object() else {
        return Ok(HashMap::new());
    };
    let raw = obj
        .get("accounts")
        .and_then(|v| v.as_object())
        .unwrap_or(obj);
    let mut out = HashMap::new();
    for (k, v) in raw {
        if is_hex64(k) {
            if let Some(info) = parse_known_account_value(v) {
                out.insert(k.clone(), info);
            }
        }
    }
    Ok(out)
}

fn load_ownership(dir: &Path) -> Result<HashMap<String, String>, ()> {
    let path = dir.join("ownership-v1.json");
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err(()),
    };
    if bytes.len() > MAX_LEDGER_JSON_BYTES {
        return Ok(HashMap::new());
    }
    let Ok(val) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(HashMap::new());
    };
    let Some(obj) = val.as_object() else {
        return Ok(HashMap::new());
    };
    let raw = obj
        .get("owners")
        .and_then(|v| v.as_object())
        .unwrap_or(obj);
    let mut out = HashMap::new();
    for (k, v) in raw {
        if let Some(s) = v.as_str() {
            if is_hex64(s) {
                out.insert(k.to_ascii_lowercase(), s.to_string());
            }
        }
    }
    Ok(out)
}

fn list_scope_directories(dir: &Path) -> Result<Vec<String>, ()> {
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(()),
    };
    let mut scopes = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            return Err(());
        };
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                if is_hex64(name) {
                    scopes.push(name.to_string());
                }
            }
        }
    }
    scopes.sort();
    Ok(scopes)
}

enum ParseFileStatus {
    Parsed(CachedFileEntry),
    Missing,
    TransientError,
}

fn parse_ledger_file(
    scope: &str,
    file_name: &str,
    path: &Path,
    mtime_ns: i128,
    file_size: u64,
) -> ParseFileStatus {
    let make_unreadable = || {
        ParseFileStatus::Parsed(CachedFileEntry {
            scope: scope.to_string(),
            file_name: file_name.to_string(),
            mtime_ns,
            file_size,
            unreadable: true,
            file_marked_legacy: false,
            manual_meta: None,
            records: Vec::new(),
        })
    };

    if file_size > MAX_RECORD_FILE_BYTES {
        return make_unreadable();
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ParseFileStatus::Missing,
        Err(_) => return ParseFileStatus::TransientError,
    };
    if bytes.len() as u64 > MAX_RECORD_FILE_BYTES {
        return make_unreadable();
    }
    let Ok(val) = serde_json::from_slice::<Value>(&bytes) else {
        return make_unreadable();
    };
    let Some(obj) = val.as_object() else {
        return make_unreadable();
    };
    if obj.get("schema").and_then(parse_safe_nonneg_int) != Some(1) {
        return make_unreadable();
    }
    if obj.get("account").and_then(|v| v.as_str()) != Some(scope) {
        return make_unreadable();
    }
    let Some(records_arr) = obj.get("records").and_then(|v| v.as_array()) else {
        return make_unreadable();
    };

    let mut records = Vec::with_capacity(records_arr.len());
    for item in records_arr {
        let Some(robj) = item.as_object() else {
            return make_unreadable();
        };
        let Some(rid) = robj.get("id").and_then(|v| v.as_str()) else {
            return make_unreadable();
        };
        if !is_hex64(rid) {
            return make_unreadable();
        }
        let Some(rmodel) = robj.get("model").and_then(|v| v.as_str()) else {
            return make_unreadable();
        };
        if rmodel.encode_utf16().count() > 120 {
            return make_unreadable();
        }
        let Ok(at) = parse_nullable_safe_int(robj.get("at")) else {
            return make_unreadable();
        };
        let Ok(uncached) = parse_nullable_safe_int(robj.get("uncached")) else {
            return make_unreadable();
        };
        let Ok(cache_read) = parse_nullable_safe_int(robj.get("cacheRead")) else {
            return make_unreadable();
        };
        let Ok(cache_write) = parse_nullable_safe_int(robj.get("cacheWrite")) else {
            return make_unreadable();
        };
        let Ok(output) = parse_nullable_safe_int(robj.get("output")) else {
            return make_unreadable();
        };
        records.push(PackedUsageRecord {
            id: rid.to_string(),
            at,
            model: rmodel.to_string(),
            uncached,
            cache_read,
            cache_write,
            output,
            partial: is_js_truthy(robj.get("partial")),
            is_legacy: robj.get("isLegacy").and_then(|v| v.as_bool()) == Some(true),
        });
    }

    let meta_obj = obj.get("metadata").and_then(|m| m.as_object());
    let file_marked_legacy = meta_obj
        .and_then(|m| m.get("isLegacy"))
        .and_then(|v| v.as_bool())
        == Some(true)
        || obj.get("isLegacy").and_then(|v| v.as_bool()) == Some(true);

    let manual_meta = if meta_obj
        .and_then(|m| m.get("source"))
        .and_then(|v| v.as_str())
        == Some("remote-manual")
    {
        let meta = meta_obj.unwrap();
        let doc_id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string();
        let timestamp = meta
            .get("timestamp")
            .and_then(|v| if v.is_null() { None } else { v.as_f64() })
            .unwrap_or(0.0);
        let model = meta
            .get("model")
            .and_then(|v| if v.is_null() { None } else { v.as_str() })
            .unwrap_or("manual-model")
            .to_string();
        let tokens_json = meta
            .get("tokens")
            .and_then(|v| {
                if v.is_null() {
                    None
                } else {
                    serde_json::to_string(v).ok()
                }
            })
            .unwrap_or_default();
        let project_name = meta
            .get("projectName")
            .and_then(|v| if v.is_null() { None } else { v.as_str() })
            .unwrap_or("")
            .to_string();
        let note = meta
            .get("note")
            .and_then(|v| if v.is_null() { None } else { v.as_str() })
            .unwrap_or("")
            .to_string();
        Some(ManualEntryMeta {
            doc_id,
            timestamp,
            model,
            tokens_json,
            project_name,
            note,
        })
    } else {
        None
    };

    ParseFileStatus::Parsed(CachedFileEntry {
        scope: scope.to_string(),
        file_name: file_name.to_string(),
        mtime_ns,
        file_size,
        unreadable: false,
        file_marked_legacy,
        manual_meta,
        records,
    })
}

struct BinCursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BinCursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn read_bytes(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(len)?;
        if end > self.data.len() {
            return None;
        }
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Some(slice)
    }

    fn read_u8(&mut self) -> Option<u8> {
        let b = self.read_bytes(1)?;
        Some(b[0])
    }

    fn read_u32(&mut self) -> Option<u32> {
        let b = self.read_bytes(4)?;
        Some(u32::from_le_bytes(b.try_into().ok()?))
    }

    fn read_u64(&mut self) -> Option<u64> {
        let b = self.read_bytes(8)?;
        Some(u64::from_le_bytes(b.try_into().ok()?))
    }

    fn read_i64(&mut self) -> Option<i64> {
        let b = self.read_bytes(8)?;
        Some(i64::from_le_bytes(b.try_into().ok()?))
    }

    fn read_i128(&mut self) -> Option<i128> {
        let b = self.read_bytes(16)?;
        Some(i128::from_le_bytes(b.try_into().ok()?))
    }

    fn read_f64(&mut self) -> Option<f64> {
        let b = self.read_bytes(8)?;
        Some(f64::from_le_bytes(b.try_into().ok()?))
    }

    fn read_str(&mut self) -> Option<String> {
        let len = self.read_u32()? as usize;
        let bytes = self.read_bytes(len)?;
        std::str::from_utf8(bytes).ok().map(|s| s.to_string())
    }
}

fn write_str(out: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn load_binary_cache(path: &Path) -> (HashMap<(String, String), CachedFileEntry>, bool) {
    let Ok(bytes) = fs::read(path) else {
        return (HashMap::new(), true);
    };
    if bytes.len() < 8 + 4 + 4 + 8 {
        return (HashMap::new(), true);
    }
    let payload_end = bytes.len() - 8;
    let payload = &bytes[..payload_end];
    let checksum = &bytes[payload_end..];
    let digest = Sha256::digest(payload);
    if &digest[..8] != checksum {
        return (HashMap::new(), true);
    }

    let Some(entries) = decode_binary_cache_payload(payload) else {
        return (HashMap::new(), true);
    };
    let mut map = HashMap::with_capacity(entries.len());
    for e in entries {
        map.insert((e.scope.clone(), e.file_name.clone()), e);
    }
    (map, false)
}

fn decode_binary_cache_payload(payload: &[u8]) -> Option<Vec<CachedFileEntry>> {
    let mut cur = BinCursor::new(payload);
    if cur.read_bytes(8)? != LEDGER_CACHE_MAGIC {
        return None;
    }
    if cur.read_u32()? != LEDGER_CACHE_VERSION {
        return None;
    }
    let count = cur.read_u32()? as usize;
    let mut out = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        let scope = cur.read_str()?;
        let file_name = cur.read_str()?;
        let mtime_ns = cur.read_i128()?;
        let file_size = cur.read_u64()?;
        let flags = cur.read_u8()?;
        let unreadable = (flags & 0x01) != 0;
        let file_marked_legacy = (flags & 0x02) != 0;
        let has_manual = (flags & 0x04) != 0;

        let mut manual_meta = None;
        let mut records = Vec::new();
        if !unreadable {
            if has_manual {
                let doc_id = cur.read_str()?;
                let timestamp = cur.read_f64()?;
                if !timestamp.is_finite() {
                    return None;
                }
                let model = cur.read_str()?;
                let tokens_json = cur.read_str()?;
                let project_name = cur.read_str()?;
                let note = cur.read_str()?;
                manual_meta = Some(ManualEntryMeta {
                    doc_id,
                    timestamp,
                    model,
                    tokens_json,
                    project_name,
                    note,
                });
            }
            let rec_count = cur.read_u32()? as usize;
            records.reserve(rec_count.min(1024));
            for _ in 0..rec_count {
                let id = cur.read_str()?;
                let model = cur.read_str()?;
                let at = validate_cached_i64(cur.read_i64()?)?;
                let uncached = validate_cached_i64(cur.read_i64()?)?;
                let cache_read = validate_cached_i64(cur.read_i64()?)?;
                let cache_write = validate_cached_i64(cur.read_i64()?)?;
                let output = validate_cached_i64(cur.read_i64()?)?;
                let rec_flags = cur.read_u8()?;
                records.push(PackedUsageRecord {
                    id,
                    at,
                    model,
                    uncached,
                    cache_read,
                    cache_write,
                    output,
                    partial: (rec_flags & 0x01) != 0,
                    is_legacy: (rec_flags & 0x02) != 0,
                });
            }
        }
        out.push(CachedFileEntry {
            scope,
            file_name,
            mtime_ns,
            file_size,
            unreadable,
            file_marked_legacy,
            manual_meta,
            records,
        });
    }
    if cur.pos != payload.len() {
        return None;
    }
    Some(out)
}

fn encode_binary_cache(entries: &[&CachedFileEntry]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(entries.len() * 160 + 32);
    buf.extend_from_slice(LEDGER_CACHE_MAGIC);
    buf.extend_from_slice(&LEDGER_CACHE_VERSION.to_le_bytes());
    buf.extend_from_slice(&(entries.len() as u32).to_le_bytes());

    for e in entries {
        write_str(&mut buf, &e.scope);
        write_str(&mut buf, &e.file_name);
        buf.extend_from_slice(&e.mtime_ns.to_le_bytes());
        buf.extend_from_slice(&e.file_size.to_le_bytes());
        let flags: u8 = (if e.unreadable { 0x01 } else { 0 })
            | (if e.file_marked_legacy { 0x02 } else { 0 })
            | (if e.manual_meta.is_some() { 0x04 } else { 0 });
        buf.push(flags);
        if !e.unreadable {
            if let Some(m) = &e.manual_meta {
                write_str(&mut buf, &m.doc_id);
                buf.extend_from_slice(&m.timestamp.to_le_bytes());
                write_str(&mut buf, &m.model);
                write_str(&mut buf, &m.tokens_json);
                write_str(&mut buf, &m.project_name);
                write_str(&mut buf, &m.note);
            }
            buf.extend_from_slice(&(e.records.len() as u32).to_le_bytes());
            for r in &e.records {
                write_str(&mut buf, &r.id);
                write_str(&mut buf, &r.model);
                buf.extend_from_slice(&r.at.unwrap_or(-1).to_le_bytes());
                buf.extend_from_slice(&r.uncached.unwrap_or(-1).to_le_bytes());
                buf.extend_from_slice(&r.cache_read.unwrap_or(-1).to_le_bytes());
                buf.extend_from_slice(&r.cache_write.unwrap_or(-1).to_le_bytes());
                buf.extend_from_slice(&r.output.unwrap_or(-1).to_le_bytes());
                let rflags: u8 =
                    (if r.partial { 0x01 } else { 0 }) | (if r.is_legacy { 0x02 } else { 0 });
                buf.push(rflags);
            }
        }
    }

    let digest = Sha256::digest(&buf);
    buf.extend_from_slice(&digest[..8]);
    buf
}

fn persist_binary_cache(dir: &Path, entries: &HashMap<(String, String), CachedFileEntry>) {
    if !dir.is_dir() {
        return;
    }
    let cache_path = dir.join(LEDGER_CACHE_FILE);
    if entries.is_empty() && !cache_path.exists() {
        return;
    }
    let mut sorted: Vec<&CachedFileEntry> = entries.values().collect();
    sorted.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
    let encoded = encode_binary_cache(&sorted);
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!("{LEDGER_CACHE_FILE}.tmp.{}.{seq}", std::process::id()));
    let write_ok = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp_path)?;
        f.write_all(&encoded)?;
        f.flush()?;
        drop(f);
        for attempt in 0..5u64 {
            match fs::rename(&tmp_path, &cache_path) {
                Ok(()) => return Ok(()),
                Err(err)
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::AlreadyExists
                    ) && attempt < 4 =>
                {
                    std::thread::sleep(std::time::Duration::from_millis((attempt + 1) * 2));
                }
                Err(err) => return Err(err),
            }
        }
        Ok(())
    })();
    if write_ok.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m as u32, d as u32)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = m as u64;
    let d = d as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + (doe as i64) - 719468
}

fn parse_yyyy_mm_dd(s: &str) -> Option<(i64, u32, u32)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

fn week_start(today: &str) -> Option<String> {
    let (y, m, d) = parse_yyyy_mm_dd(today)?;
    let days = days_from_civil(y, m, d);
    let offset = (days + 3).rem_euclid(7);
    let (wy, wm, wd) = civil_from_days(days - offset);
    Some(format!("{wy:04}-{wm:02}-{wd:02}"))
}

fn format_iso_utc(now_ms: i64) -> Option<String> {
    let secs = now_ms.div_euclid(1000);
    let millis = now_ms.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (y, m, d) = civil_from_days(days);
    if !(0..=9999).contains(&y) {
        return None;
    }
    Some(format!(
        "{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z"
    ))
}

fn resolve_offset_secs(query: &LedgerSummaryQuery, at_ms: i64) -> Option<i32> {
    if let Some(min_ms) = query.tz_min_ms {
        if at_ms < min_ms {
            return None;
        }
    }
    if let Some(max_ms) = query.tz_max_ms {
        if at_ms >= max_ms {
            return None;
        }
    }
    if let Some(fixed) = query.fixed_offset_secs {
        return Some(fixed);
    }
    let transitions = query.tz_transitions.as_ref()?;
    if transitions.is_empty() {
        return None;
    }
    let idx = transitions.partition_point(|t| t.at_ms <= at_ms);
    if idx == 0 {
        return None;
    }
    Some(transitions[idx - 1].offset_secs)
}

fn date_time_parts(query: &LedgerSummaryQuery, at_ms: i64) -> Option<(String, usize)> {
    let offset_secs = resolve_offset_secs(query, at_ms)?;
    let local_ms = at_ms.checked_add((offset_secs as i64) * 1000)?;
    let local_secs = local_ms.div_euclid(1000);
    let days = local_secs.div_euclid(86400);
    let sec_of_day = local_secs.rem_euclid(86400);
    let hour = (sec_of_day / 3600) as usize;
    let (y, m, d) = civil_from_days(days);
    if !(0..=9999).contains(&y) {
        return None;
    }
    Some((format!("{y:04}-{m:02}-{d:02}"), hour))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageBucketCountsOut {
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    total: i64,
    requests: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageUserBucketOut {
    name: String,
    user_key: String,
    is_legacy: bool,
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    total: i64,
    requests: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageDayBucketOut {
    date: String,
    models: BTreeMap<String, UsageBucketCountsOut>,
    users: BTreeMap<String, UsageUserBucketOut>,
    hours: [i64; 24],
    legacy_tokens: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageUserMetaOut {
    name: String,
    email: String,
    is_legacy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManualUsageRecordOut {
    id: String,
    hash: String,
    account: String,
    timestamp: Number,
    source: String,
    model: String,
    tokens: Value,
    project_name: String,
    note: String,
    #[serde(skip)]
    ts_sort: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummarySnapshotOut {
    account_key: String,
    view_scope: String,
    time_zone: String,
    today: String,
    today_hours: [i64; 24],
    days: Vec<UsageDayBucketOut>,
    models: Vec<String>,
    users: Vec<String>,
    user_meta: BTreeMap<String, UsageUserMetaOut>,
    users_summary: BTreeMap<String, UsageUserBucketOut>,
    legacy_tokens: i64,
    today_tokens: i64,
    week_tokens: i64,
    month_tokens: i64,
    total_tokens: i64,
    unknown_tokens: i64,
    unknown_requests: i64,
    partial_requests: i64,
    unreadable_files: i64,
    manual_entries: Vec<ManualUsageRecordOut>,
    requests: usize,
    first_date: Option<String>,
    updated_at: String,
    source: String,
}

fn json_number_from_f64(v: f64) -> Number {
    if v.is_finite() && v.fract() == 0.0 && v >= (i64::MIN as f64) && v <= (i64::MAX as f64) {
        Number::from(v as i64)
    } else {
        Number::from_f64(v).unwrap_or_else(|| Number::from(0))
    }
}

struct DirtyTask {
    scope: String,
    name: String,
    path: PathBuf,
    mtime_ns: i128,
    file_size: u64,
}

struct AttributedRecord<'a> {
    rec: &'a PackedUsageRecord,
    is_legacy: bool,
    user_key: String,
    user_name: String,
}

pub fn query_usage_ledger_summary_json(query_json: &str) -> Option<String> {
    let query: LedgerSummaryQuery = serde_json::from_str(query_json).ok()?;
    if query.directory.is_empty()
        || query.scope.is_empty()
        || (!is_hex64(&query.scope) && query.scope != "all")
    {
        return None;
    }

    let week_start_str = week_start(&query.today)?;
    let month_prefix = &query.today[..7];
    let updated_at = format_iso_utc(query.now_ms)?;

    let dir = Path::new(&query.directory);
    let meta = load_accounts_meta(dir).ok()?;
    let ownership = load_ownership(dir).ok()?;
    let all_scopes = list_scope_directories(dir).ok()?;

    let mut owner_by_name: HashMap<String, String> = HashMap::new();
    for (conv_id, owner_scope) in &ownership {
        if is_hex64(owner_scope) {
            if !is_valid_guid(conv_id) {
                return None;
            }
            let file_name = format!("{}.json", sha256_hex(&conv_id.to_ascii_lowercase()));
            owner_by_name.insert(file_name, owner_scope.clone());
        }
    }

    let target_scopes: Vec<String> = if query.scope == "all" {
        if !all_scopes.is_empty() {
            all_scopes.clone()
        } else if let Some(fb) = query.fallback_scope.as_ref().filter(|s| is_hex64(s)) {
            vec![fb.clone()]
        } else {
            Vec::new()
        }
    } else {
        vec![query.scope.clone()]
    };
    let target_set: HashSet<String> = target_scopes.iter().cloned().collect();
    let all_scope_set: HashSet<String> = all_scopes.iter().cloned().collect();

    let scan_scopes: Vec<String> = if all_scopes.len() > 1 {
        let mut seen_sc = HashSet::new();
        let mut merged = Vec::new();
        for s in all_scopes.iter().chain(target_scopes.iter()) {
            if seen_sc.insert(s.clone()) {
                merged.push(s.clone());
            }
        }
        merged
    } else {
        target_scopes.clone()
    };
    let scan_scope_set: HashSet<String> = scan_scopes.iter().cloned().collect();

    let dirty_set: HashSet<String> = query
        .dirty_rel_paths
        .iter()
        .map(|p| p.replace('\\', "/"))
        .collect();

    let cache_path = dir.join(LEDGER_CACHE_FILE);
    let (mut cache_map, mut cache_dirty) = load_binary_cache(&cache_path);

    let before_len = cache_map.len();
    cache_map.retain(|(s, _), _| {
        scan_scope_set.contains(s) || all_scope_set.contains(s) || target_set.contains(s)
    });
    if cache_map.len() != before_len {
        cache_dirty = true;
    }

    let mut scope_files: Vec<(String, Vec<String>)> = Vec::with_capacity(scan_scopes.len());
    let mut dirty_tasks: Vec<DirtyTask> = Vec::new();

    for s in &scan_scopes {
        let scope_dir = dir.join(s);
        let mut valid_files = Vec::new();
        match fs::read_dir(&scope_dir) {
            Ok(rd) => {
                for entry in rd {
                    let Ok(entry) = entry else {
                        return None;
                    };
                    if let Some(name) = entry.file_name().to_str() {
                        if is_ledger_file_name(name) {
                            valid_files.push(name.to_string());
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        valid_files.sort();
        let valid_set: HashSet<&str> = valid_files.iter().map(|n| n.as_str()).collect();

        let keys_to_remove: Vec<(String, String)> = cache_map
            .keys()
            .filter(|(cs, cname)| cs == s && !valid_set.contains(cname.as_str()))
            .cloned()
            .collect();
        for k in keys_to_remove {
            cache_map.remove(&k);
            cache_dirty = true;
        }

        let mut existing_files = Vec::with_capacity(valid_files.len());
        for name in valid_files {
            let full_path = scope_dir.join(&name);
            let meta_res = fs::metadata(&full_path);
            let file_meta = match meta_res {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if cache_map.remove(&(s.clone(), name)).is_some() {
                        cache_dirty = true;
                    }
                    continue;
                }
                Err(_) => return None,
            };
            let mtime_ns = mtime_ns_from_metadata(&file_meta)?;
            let file_size = file_meta.len();
            let rel_path = format!("{s}/{name}");
            let is_dirty = dirty_set.contains(&rel_path);
            let cache_hit = !is_dirty
                && cache_map
                    .get(&(s.clone(), name.clone()))
                    .is_some_and(|e| e.mtime_ns == mtime_ns && e.file_size == file_size);
            if !cache_hit {
                dirty_tasks.push(DirtyTask {
                    scope: s.clone(),
                    name: name.clone(),
                    path: full_path,
                    mtime_ns,
                    file_size,
                });
            }
            existing_files.push(name);
        }
        scope_files.push((s.clone(), existing_files));
    }

    if !dirty_tasks.is_empty() {
        let mut results: Vec<Option<ParseFileStatus>> = (0..dirty_tasks.len()).map(|_| None).collect();
        let transient_err = AtomicBool::new(false);
        if dirty_tasks.len() > PARALLEL_DIRTY_THRESHOLD {
            let next_idx = AtomicUsize::new(0);
            let workers = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
                .clamp(1, 8)
                .min(dirty_tasks.len());
            let handles: Vec<_> = std::thread::scope(|scope_handle| {
                let mut threads = Vec::with_capacity(workers);
                for _ in 0..workers {
                    threads.push(scope_handle.spawn(|| {
                        let mut local = Vec::new();
                        loop {
                            if transient_err.load(Ordering::Relaxed) {
                                break;
                            }
                            let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                            if idx >= dirty_tasks.len() {
                                break;
                            }
                            let task = &dirty_tasks[idx];
                            let status = parse_ledger_file(
                                &task.scope,
                                &task.name,
                                &task.path,
                                task.mtime_ns,
                                task.file_size,
                            );
                            if matches!(status, ParseFileStatus::TransientError) {
                                transient_err.store(true, Ordering::Relaxed);
                                break;
                            }
                            local.push((idx, status));
                        }
                        local
                    }));
                }
                threads.into_iter().filter_map(|h| h.join().ok()).collect()
            });
            for local in handles {
                for (idx, status) in local {
                    results[idx] = Some(status);
                }
            }
        } else {
            for (idx, task) in dirty_tasks.iter().enumerate() {
                let status = parse_ledger_file(
                    &task.scope,
                    &task.name,
                    &task.path,
                    task.mtime_ns,
                    task.file_size,
                );
                if matches!(status, ParseFileStatus::TransientError) {
                    transient_err.store(true, Ordering::Relaxed);
                    break;
                }
                results[idx] = Some(status);
            }
        }
        if transient_err.load(Ordering::Relaxed) {
            return None;
        }
        for (idx, task) in dirty_tasks.into_iter().enumerate() {
            match results[idx].take()? {
                ParseFileStatus::Parsed(entry) => {
                    cache_map.insert((task.scope, task.name), entry);
                    cache_dirty = true;
                }
                ParseFileStatus::Missing => {
                    if cache_map.remove(&(task.scope, task.name)).is_some() {
                        cache_dirty = true;
                    }
                }
                ParseFileStatus::TransientError => return None,
            }
        }
    }

    if cache_dirty {
        persist_binary_cache(dir, &cache_map);
    }

    let mut record_scopes: HashMap<String, Vec<String>> = HashMap::new();
    let mut parsed_entries: Vec<&CachedFileEntry> = Vec::new();
    let mut unreadable: i64 = 0;

    for (s, files) in &scope_files {
        let is_target = target_set.contains(s);
        for name in files {
            let Some(entry) = cache_map.get(&(s.clone(), name.clone())) else {
                continue;
            };
            if entry.unreadable {
                if is_target {
                    unreadable += 1;
                }
                continue;
            }
            let mut seen_rids = HashSet::new();
            for r in &entry.records {
                if seen_rids.insert(r.id.as_str()) {
                    let list = record_scopes.entry(r.id.clone()).or_default();
                    if !list.iter().any(|existing| existing == s) {
                        list.push(s.clone());
                    }
                }
            }
            if is_target {
                parsed_entries.push(entry);
            }
        }
    }

    let known_keys: Vec<String> = query.known_accounts.iter().map(|(k, _)| k.clone()).collect();
    let known_map: HashMap<String, &KnownAccountInfo> = query
        .known_accounts
        .iter()
        .map(|(k, v)| (k.clone(), v))
        .collect();
    let known_index: HashMap<&str, usize> = known_keys
        .iter()
        .enumerate()
        .map(|(i, k)| (k.as_str(), i))
        .collect();

    let get_account_name = |s: &str| -> String {
        let m = meta.get(s).or_else(|| known_map.get(s).copied());
        if let Some(info) = m {
            if let Some(email) = opt_non_empty(info.email.as_deref()) {
                return email.to_string();
            }
            if let Some(name) = opt_non_empty(info.name.as_deref()) {
                return name.to_string();
            }
        }
        format!("Account ({})", &s[..8.min(s.len())])
    };

    let primary_rank = |s: &str| -> i32 {
        let m = meta.get(s);
        let k = known_map.get(s).copied();
        if m.and_then(|v| v.primary) == Some(true) || k.and_then(|v| v.primary) == Some(true) {
            return 0;
        }
        if m.and_then(|v| v.primary) == Some(false)
            || k.and_then(|v| v.primary) == Some(false)
            || m.and_then(|v| v.secondary) == Some(true)
            || k.and_then(|v| v.secondary) == Some(true)
        {
            return 2;
        }
        if k.is_some() && known_index.get(s).copied().unwrap_or(0) > 0 {
            return 2;
        }
        1
    };

    let pick_primary = |scopes_list: &[String]| -> Option<String> {
        if scopes_list.is_empty() {
            return None;
        }
        let mut sorted = scopes_list.to_vec();
        sorted.sort_by(|a, b| {
            let ra = primary_rank(a);
            let rb = primary_rank(b);
            if ra != rb {
                return ra.cmp(&rb);
            }
            let ta = meta
                .get(a)
                .and_then(|v| v.added_at.or(v.created_at))
                .unwrap_or(f64::MAX);
            let tb = meta
                .get(b)
                .and_then(|v| v.added_at.or(v.created_at))
                .unwrap_or(f64::MAX);
            if ta != tb {
                return ta.partial_cmp(&tb).unwrap_or(std::cmp::Ordering::Equal);
            }
            let ia = known_index.get(a.as_str()).copied();
            let ib = known_index.get(b.as_str()).copied();
            if let (Some(i_a), Some(i_b)) = (ia, ib) {
                if i_a != i_b {
                    return i_a.cmp(&i_b);
                }
            }
            a.cmp(b)
        });
        sorted.into_iter().next()
    };

    let mut manual_entries: Vec<ManualUsageRecordOut> = Vec::new();
    let mut seen_map: HashMap<String, usize> = HashMap::new();
    let mut seen_vec: Vec<AttributedRecord<'_>> = Vec::new();

    for entry in parsed_entries {
        let s = entry.scope.as_str();
        if let Some(m) = &entry.manual_meta {
            let tokens_val: Value = if m.tokens_json.is_empty() {
                serde_json::json!({ "prompt": 0, "candidates": 0, "total": 0 })
            } else {
                serde_json::from_str(&m.tokens_json)
                    .unwrap_or_else(|_| serde_json::json!({ "prompt": 0, "candidates": 0, "total": 0 }))
            };
            manual_entries.push(ManualUsageRecordOut {
                id: m.doc_id.clone(),
                hash: entry
                    .file_name
                    .strip_suffix(".json")
                    .unwrap_or(&entry.file_name)
                    .to_string(),
                account: s.to_string(),
                timestamp: json_number_from_f64(m.timestamp),
                source: "remote-manual".to_string(),
                model: m.model.clone(),
                tokens: tokens_val,
                project_name: m.project_name.clone(),
                note: m.note.clone(),
                ts_sort: m.timestamp,
            });
        }
        let explicit_owner = owner_by_name.get(&entry.file_name).map(|v| v.as_str());
        for r in &entry.records {
            let single_scope = [entry.scope.clone()];
            let scopes_for_record: &[String] = record_scopes
                .get(&r.id)
                .map(|v| v.as_slice())
                .unwrap_or(&single_scope);
            let is_duplicate = scopes_for_record.len() > 1;
            let resolved_owner = explicit_owner.filter(|eo| scopes_for_record.iter().any(|x| x == eo));
            if query.scope != "all" {
                if let Some(ro) = resolved_owner {
                    if ro != s {
                        continue;
                    }
                } else if is_duplicate && pick_primary(scopes_for_record).as_deref() != Some(s) {
                    continue;
                }
            }
            let effective_owner = resolved_owner.or(if is_duplicate { None } else { Some(s) });
            let is_legacy =
                (effective_owner.is_none() && is_duplicate) || (resolved_owner.is_none() && entry.file_marked_legacy);
            let user_key = if query.scope == "all" && is_legacy {
                "legacy".to_string()
            } else {
                effective_owner.unwrap_or(s).to_string()
            };
            let user_name = if user_key == "legacy" {
                LEGACY_DISPLAY_NAME.to_string()
            } else {
                get_account_name(&user_key)
            };

            let r_sum = r.sum();
            if let Some(&idx) = seen_map.get(&r.id) {
                let prev = &seen_vec[idx];
                let prev_sum = prev.rec.sum();
                if r_sum > prev_sum {
                    seen_vec[idx] = AttributedRecord {
                        rec: r,
                        is_legacy: is_legacy || r.is_legacy,
                        user_key,
                        user_name,
                    };
                } else if r_sum == prev_sum && effective_owner == Some(s) && prev.is_legacy {
                    seen_vec[idx] = AttributedRecord {
                        rec: r,
                        is_legacy: false,
                        user_key: s.to_string(),
                        user_name: get_account_name(s),
                    };
                }
            } else {
                let idx = seen_vec.len();
                seen_map.insert(r.id.clone(), idx);
                seen_vec.push(AttributedRecord {
                    rec: r,
                    is_legacy: is_legacy || r.is_legacy,
                    user_key,
                    user_name,
                });
            }
        }
    }

    let mut daily: BTreeMap<String, UsageDayBucketOut> = BTreeMap::new();
    let mut models_set: HashSet<String> = HashSet::new();
    let mut users_order: Vec<String> = Vec::new();
    let mut users_seen: HashSet<String> = HashSet::new();
    let mut unknown_tokens: i64 = 0;
    let mut unknown_requests: i64 = 0;
    let mut partial_requests: i64 = 0;
    let mut legacy_tokens: i64 = 0;

    for attr in &seen_vec {
        let r = attr.rec;
        models_set.insert(r.model.clone());
        if users_seen.insert(attr.user_key.clone()) {
            users_order.push(attr.user_key.clone());
        }
        let token_sum = r.sum();
        if attr.is_legacy {
            legacy_tokens = legacy_tokens.saturating_add(token_sum);
        }
        if r.partial {
            partial_requests += 1;
        }
        let Some(at_ms) = r.at else {
            unknown_tokens = unknown_tokens.saturating_add(token_sum);
            unknown_requests += 1;
            continue;
        };
        let (date, hour) = date_time_parts(&query, at_ms)?;
        let day = daily.entry(date.clone()).or_insert_with(|| UsageDayBucketOut {
            date,
            models: BTreeMap::new(),
            users: BTreeMap::new(),
            hours: [0; 24],
            legacy_tokens: 0,
        });
        if hour < 24 {
            day.hours[hour] = day.hours[hour].saturating_add(token_sum);
        }
        if attr.is_legacy {
            day.legacy_tokens = day.legacy_tokens.saturating_add(token_sum);
        }

        let mb = day
            .models
            .entry(r.model.clone())
            .or_insert(UsageBucketCountsOut {
                uncached: 0,
                cache_read: 0,
                cache_write: 0,
                output: 0,
                total: 0,
                requests: 0,
            });
        mb.uncached = mb.uncached.saturating_add(r.uncached.unwrap_or(0));
        mb.cache_read = mb.cache_read.saturating_add(r.cache_read.unwrap_or(0));
        mb.cache_write = mb.cache_write.saturating_add(r.cache_write.unwrap_or(0));
        mb.output = mb.output.saturating_add(r.output.unwrap_or(0));
        mb.total = mb.total.saturating_add(token_sum);
        mb.requests += 1;

        let ub = day
            .users
            .entry(attr.user_key.clone())
            .or_insert_with(|| UsageUserBucketOut {
                name: attr.user_name.clone(),
                user_key: attr.user_key.clone(),
                is_legacy: attr.is_legacy,
                uncached: 0,
                cache_read: 0,
                cache_write: 0,
                output: 0,
                total: 0,
                requests: 0,
            });
        ub.uncached = ub.uncached.saturating_add(r.uncached.unwrap_or(0));
        ub.cache_read = ub.cache_read.saturating_add(r.cache_read.unwrap_or(0));
        ub.cache_write = ub.cache_write.saturating_add(r.cache_write.unwrap_or(0));
        ub.output = ub.output.saturating_add(r.output.unwrap_or(0));
        ub.total = ub.total.saturating_add(token_sum);
        ub.requests += 1;
    }

    let days: Vec<UsageDayBucketOut> = daily.into_values().collect();
    let day_total = |d: &UsageDayBucketOut| -> i64 {
        d.models
            .values()
            .fold(0_i64, |acc, b| acc.saturating_add(b.total))
    };
    let today_hours = days
        .iter()
        .find(|d| d.date == query.today)
        .map(|d| d.hours)
        .unwrap_or([0; 24]);

    let mut users_summary: BTreeMap<String, UsageUserBucketOut> = BTreeMap::new();
    for day in &days {
        for (u_key, u_data) in &day.users {
            let target = users_summary
                .entry(u_key.clone())
                .or_insert_with(|| UsageUserBucketOut {
                    name: u_data.name.clone(),
                    user_key: u_key.clone(),
                    is_legacy: u_data.is_legacy,
                    uncached: 0,
                    cache_read: 0,
                    cache_write: 0,
                    output: 0,
                    total: 0,
                    requests: 0,
                });
            target.uncached = target.uncached.saturating_add(u_data.uncached);
            target.cache_read = target.cache_read.saturating_add(u_data.cache_read);
            target.cache_write = target.cache_write.saturating_add(u_data.cache_write);
            target.output = target.output.saturating_add(u_data.output);
            target.total = target.total.saturating_add(u_data.total);
            target.requests += u_data.requests;
        }
    }

    let mut user_meta: BTreeMap<String, UsageUserMetaOut> = BTreeMap::new();
    for k in &users_order {
        if k == "legacy" {
            user_meta.insert(
                k.clone(),
                UsageUserMetaOut {
                    name: LEGACY_DISPLAY_NAME.to_string(),
                    email: LEGACY_DISPLAY_NAME.to_string(),
                    is_legacy: true,
                },
            );
        } else {
            let name = get_account_name(k);
            let email = meta
                .get(k)
                .and_then(|v| opt_non_empty(v.email.as_deref()))
                .or_else(|| {
                    known_map
                        .get(k)
                        .and_then(|v| opt_non_empty(v.email.as_deref()))
                })
                .map(|s| s.to_string())
                .unwrap_or_else(|| name.clone());
            user_meta.insert(
                k.clone(),
                UsageUserMetaOut {
                    name,
                    email,
                    is_legacy: false,
                },
            );
        }
    }

    let mut models: Vec<String> = models_set.into_iter().collect();
    models.sort();

    let today_tokens: i64 = days
        .iter()
        .filter(|d| d.date == query.today)
        .map(day_total)
        .fold(0_i64, |acc, v| acc.saturating_add(v));
    let week_tokens: i64 = days
        .iter()
        .filter(|d| d.date.as_str() >= week_start_str.as_str() && d.date.as_str() <= query.today.as_str())
        .map(day_total)
        .fold(0_i64, |acc, v| acc.saturating_add(v));
    let month_tokens: i64 = days
        .iter()
        .filter(|d| d.date.len() >= 7 && &d.date[..7] == month_prefix && d.date.as_str() <= query.today.as_str())
        .map(day_total)
        .fold(0_i64, |acc, v| acc.saturating_add(v));
    let total_tokens: i64 = days
        .iter()
        .map(day_total)
        .fold(0_i64, |acc, v| acc.saturating_add(v))
        .saturating_add(unknown_tokens);
    let first_date = days.first().map(|d| d.date.clone());

    manual_entries.sort_by(|a, b| b.ts_sort.total_cmp(&a.ts_sort));

    let snapshot = UsageSummarySnapshotOut {
        account_key: query.scope.clone(),
        view_scope: query.scope,
        time_zone: query.time_zone,
        today: query.today,
        today_hours,
        days,
        models,
        users: users_order,
        user_meta,
        users_summary,
        legacy_tokens,
        today_tokens,
        week_tokens,
        month_tokens,
        total_tokens,
        unknown_tokens,
        unknown_requests,
        partial_requests,
        unreadable_files: unreadable,
        manual_entries,
        requests: seen_vec.len(),
        first_date,
        updated_at,
        source: query.source,
    };

    serde_json::to_string(&snapshot).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        static TEST_SEQ: AtomicU64 = AtomicU64::new(0);
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "pulse-accel-ledger-{label}-{}-{ts}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hex64(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn write_ledger_doc(
        dir: &Path,
        scope: &str,
        file_hash: &str,
        records_json: Value,
        extra: Option<(&str, Value)>,
    ) -> PathBuf {
        let scope_dir = dir.join(scope);
        fs::create_dir_all(&scope_dir).unwrap();
        let file_path = scope_dir.join(format!("{file_hash}.json"));
        let mut doc = serde_json::json!({
            "schema": 1,
            "account": scope,
            "records": records_json,
        });
        if let Some((k, v)) = extra {
            doc.as_object_mut().unwrap().insert(k.to_string(), v);
        }
        fs::write(&file_path, serde_json::to_vec(&doc).unwrap()).unwrap();
        file_path
    }

    #[test]
    fn test_civil_dates_and_week_start() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(days_from_civil(2026, 2, 28)), (2026, 2, 28));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        // 2026-10-11 is Sunday -> Monday is 2026-10-05
        assert_eq!(week_start("2026-10-11").as_deref(), Some("2026-10-05"));
        // 2026-10-05 is Monday -> Monday is 2026-10-05
        assert_eq!(week_start("2026-10-05").as_deref(), Some("2026-10-05"));
        // 2026-01-01 is Thursday -> Monday is 2025-12-29
        assert_eq!(week_start("2026-01-01").as_deref(), Some("2025-12-29"));
        assert_eq!(
            format_iso_utc(1791684000000).as_deref(),
            Some("2026-10-11T02:00:00.000Z")
        );
    }

    #[test]
    fn test_tz_transitions_lookup() {
        let query: LedgerSummaryQuery = serde_json::from_value(serde_json::json!({
            "directory": "/tmp/x",
            "scope": "all",
            "nowMs": 1770000000000i64,
            "today": "2026-06-01",
            "timeZone": "America/New_York",
            "source": "desktop-local",
            "knownAccounts": {},
            "tzMinMs": 1767225600000i64,
            "tzMaxMs": 1798761600000i64,
            "tzTransitions": [
                { "atMs": 1767225600000i64, "offsetSecs": -18000 },
                { "atMs": 1772953200000i64, "offsetSecs": -14400 },
                { "atMs": 1793512800000i64, "offsetSecs": -18000 }
            ]
        }))
        .unwrap();
        // Before spring forward (2026-01-15T12:00:00Z -> -5h = 07:00)
        assert_eq!(
            date_time_parts(&query, 1768478400000),
            Some(("2026-01-15".to_string(), 7))
        );
        // After spring forward (2026-06-15T12:00:00Z -> -4h = 08:00)
        assert_eq!(
            date_time_parts(&query, 1781524800000),
            Some(("2026-06-15".to_string(), 8))
        );
        // Out of bounds returns None
        assert_eq!(date_time_parts(&query, 1700000000000), None);
    }

    #[test]
    fn test_binary_cache_cold_warm_corrupt_dirty_and_delete() {
        let dir = temp_dir("cache");
        let scope_a = hex64('a');
        let rid1 = hex64('1');
        let fhash1 = hex64('b');
        let rid2 = hex64('2');
        let fhash2 = hex64('c');

        let f1 = write_ledger_doc(
            &dir,
            &scope_a,
            &fhash1,
            serde_json::json!([{
                "id": rid1,
                "at": 1791684000000i64,
                "model": "Gemini 3.8",
                "uncached": 100,
                "cacheRead": 900,
                "cacheWrite": 20,
                "output": 80,
                "partial": false,
                "timeBasis": "planner-created"
            }]),
            None,
        );
        let f2 = write_ledger_doc(
            &dir,
            &scope_a,
            &fhash2,
            serde_json::json!([{
                "id": rid2,
                "at": null,
                "model": "Gemini 3.8",
                "uncached": 50,
                "cacheRead": 0,
                "cacheWrite": 0,
                "output": 50,
                "partial": true,
                "timeBasis": "unknown"
            }]),
            None,
        );

        let base_query = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "nowMs": 1791684000000i64,
            "today": "2026-10-11",
            "timeZone": "Asia/Shanghai",
            "source": "desktop-local",
            "knownAccounts": {},
            "fixedOffsetSecs": 28800,
            "dirtyRelPaths": []
        });

        let out1: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out1["totalTokens"], 1200);
        assert_eq!(out1["todayTokens"], 1100);
        assert_eq!(out1["unknownTokens"], 100);
        assert_eq!(out1["unknownRequests"], 1);
        assert_eq!(out1["partialRequests"], 1);
        assert_eq!(out1["requests"], 2);
        assert_eq!(out1["todayHours"][10], 1100);
        assert!(dir.join(LEDGER_CACHE_FILE).exists());

        // Corrupt binary sidecar -> rebuilds gracefully
        fs::write(dir.join(LEDGER_CACHE_FILE), b"BADMAGIC").unwrap();
        let out2: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out2["totalTokens"], 1200);

        // Overwrite f1 with same byte length and pass dirtyRelPaths -> must re-parse!
        write_ledger_doc(
            &dir,
            &scope_a,
            &fhash1,
            serde_json::json!([{
                "id": rid1,
                "at": 1791684000000i64,
                "model": "Gemini 3.8",
                "uncached": 200,
                "cacheRead": 800,
                "cacheWrite": 20,
                "output": 90,
                "partial": false,
                "timeBasis": "planner-created"
            }]),
            None,
        );
        let mut dirty_query = base_query.clone();
        dirty_query["dirtyRelPaths"] = serde_json::json!([format!("{scope_a}/{fhash1}.json")]);
        let out3: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&dirty_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out3["totalTokens"], 1210);

        // Delete f2 and write a corrupt file -> unreadableFiles increments and deleted removed
        fs::remove_file(&f2).unwrap();
        fs::write(&f1, b"{broken").unwrap();
        let mut dirty_query2 = base_query.clone();
        dirty_query2["dirtyRelPaths"] = serde_json::json!([format!("{scope_a}/{fhash1}.json")]);
        let out4: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&dirty_query2.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out4["totalTokens"], 0);
        assert_eq!(out4["unreadableFiles"], 1);
        assert_eq!(out4["requests"], 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parallel_dirty_and_multi_account_ownership_and_manual() {
        let dir = temp_dir("multi");
        let scope_a = hex64('a');
        let scope_b = hex64('b');
        let shared_conv = "33333333-3333-3333-3333-333333333333";
        let shared_hash = sha256_hex(shared_conv);
        let shared_rid = hex64('9');

        fs::write(
            dir.join("accounts-v1.json"),
            serde_json::json!({
                "schema": 1,
                "accounts": {
                    scope_a.clone(): { "email": "alpha@example.test", "primary": true },
                    scope_b.clone(): { "email": "beta@example.test", "primary": false }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("ownership-v1.json"),
            serde_json::json!({
                shared_conv: scope_b.clone()
            })
            .to_string(),
        )
        .unwrap();

        // Shared conversation in both A and B, owned by B
        for sc in [&scope_a, &scope_b] {
            write_ledger_doc(
                &dir,
                sc,
                &shared_hash,
                serde_json::json!([{
                    "id": shared_rid,
                    "at": 1791684000000i64,
                    "model": "Gemini 2.5 Pro",
                    "uncached": 500,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "output": 50,
                    "partial": false,
                    "timeBasis": "request-start"
                }]),
                None,
            );
        }

        // 12 extra files in A to trigger parallel dirty path (> 8)
        for i in 0..12u8 {
            let h = format!("{:064x}", i + 10);
            let rid = format!("{:064x}", i + 100);
            write_ledger_doc(
                &dir,
                &scope_a,
                &h,
                serde_json::json!([{
                    "id": rid,
                    "at": 1791684000000i64,
                    "model": "Gemini 2.5 Pro",
                    "uncached": 10,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "output": 0,
                    "partial": false,
                    "timeBasis": "request-start"
                }]),
                None,
            );
        }

        // Manual entry in A
        let man_hash = hex64('f');
        write_ledger_doc(
            &dir,
            &scope_a,
            &man_hash,
            serde_json::json!([{
                "id": man_hash,
                "at": 1791687600000i64,
                "model": "manual-m",
                "uncached": 40,
                "cacheRead": 0,
                "cacheWrite": 0,
                "output": 10,
                "partial": false,
                "timeBasis": "request-start"
            }]),
            Some((
                "metadata",
                serde_json::json!({
                    "source": "remote-manual",
                    "timestamp": 1791687600000i64,
                    "model": "manual-m",
                    "tokens": { "prompt": 40, "candidates": 10, "total": 50 },
                    "projectName": "Proj",
                    "note": "Test"
                }),
            )),
        );

        let query_all = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": "all",
            "nowMs": 1791687600000i64,
            "today": "2026-10-11",
            "timeZone": "Asia/Shanghai",
            "source": "desktop-local",
            "knownAccounts": {},
            "fixedOffsetSecs": 28800,
            "dirtyRelPaths": []
        });
        let out_all: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&query_all.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_all["totalTokens"], 550 + 120 + 50);
        assert_eq!(out_all["legacyTokens"], 0);
        assert_eq!(out_all["manualEntries"].as_array().unwrap().len(), 1);
        assert_eq!(out_all["manualEntries"][0]["projectName"], "Proj");

        let mut query_a = query_all.clone();
        query_a["scope"] = Value::String(scope_a.clone());
        let out_a: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&query_a.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_a["totalTokens"], 170);

        let mut query_b = query_all.clone();
        query_b["scope"] = Value::String(scope_b.clone());
        let out_b: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&query_b.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_b["totalTokens"], 550);

        let mut query_bad_fb = query_all.clone();
        query_bad_fb["scope"] = Value::String("all".to_string());
        query_bad_fb["fallbackScope"] = Value::String("非ASCII/../bad_scope".to_string());
        let out_bad_fb: Value = serde_json::from_str(
            &query_usage_ledger_summary_json(&query_bad_fb.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_bad_fb["totalTokens"], 720);

        // Corrupt binary payload check: crafted extreme > MAX_SAFE_INT value is rejected on decode.
        assert!(validate_cached_i64(MAX_SAFE_INT + 1).is_none());
        assert!(validate_cached_i64(-2).is_none());
        assert_eq!(validate_cached_i64(-1), Some(None));
        assert_eq!(validate_cached_i64(42), Some(Some(42)));

        let _ = fs::remove_dir_all(&dir);
    }
}
