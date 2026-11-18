use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::ledger_index::{
    atomic_write_cache_file, date_ymd_hour_from_tz, is_hex64, is_ledger_file_name,
    mtime_ns_from_metadata, read_cache_file_stamp, write_str, BinCursor, TzTransition,
    MAX_RECORD_FILE_BYTES, MAX_SAFE_INT, PARALLEL_DIRTY_THRESHOLD,
};

const PROJECT_CACHE_FILE: &str = "project-ledger-v1.bin";
const PROJECT_CACHE_MAGIC: &[u8; 8] = b"AGPPRJ01";
const PROJECT_CACHE_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerProjectQuery {
    pub directory: String,
    pub scope: String,
    pub time_zone: String,
    #[serde(default)]
    pub fixed_offset_secs: Option<i32>,
    #[serde(default)]
    pub tz_min_ms: Option<i64>,
    #[serde(default)]
    pub tz_max_ms: Option<i64>,
    #[serde(default)]
    pub tz_transitions: Option<Vec<TzTransition>>,
    pub zero_at_date: String,
    #[serde(default)]
    pub dirty_rel_paths: Vec<String>,
}

#[derive(Debug, Clone)]
struct ProjectDayBucket {
    date: String,
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    requests: i64,
    max_at: i64,
}

#[derive(Debug, Clone)]
struct CachedProjectFileEntry {
    scope: String,
    file_name: String,
    mtime_ns: i128,
    file_size: u64,
    unreadable: bool,
    doc_id: String,
    source: String,
    project_name: String,
    note: String,
    days: Vec<ProjectDayBucket>,
}

struct InMemProjectCache {
    directory: String,
    bin_mtime_ns: Option<i128>,
    bin_size: Option<u64>,
    tz_signature: [u8; 32],
    entries: Arc<HashMap<(String, String), CachedProjectFileEntry>>,
}

static PROJECT_MEM_CACHE: Mutex<Option<InMemProjectCache>> = Mutex::new(None);

fn compute_tz_signature(query: &LedgerProjectQuery) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let write_opt_i64 = |h: &mut Sha256, v: Option<i64>| match v {
        Some(n) => {
            h.update([1u8]);
            h.update(n.to_le_bytes());
        }
        None => h.update([0u8]),
    };
    let tz_bytes = query.time_zone.as_bytes();
    hasher.update((tz_bytes.len() as u32).to_le_bytes());
    hasher.update(tz_bytes);
    match query.fixed_offset_secs {
        Some(s) => {
            hasher.update([1u8]);
            hasher.update(s.to_le_bytes());
        }
        None => hasher.update([0u8]),
    }
    write_opt_i64(&mut hasher, query.tz_min_ms);
    write_opt_i64(&mut hasher, query.tz_max_ms);
    match &query.tz_transitions {
        Some(list) => {
            hasher.update([1u8]);
            hasher.update((list.len() as u32).to_le_bytes());
            for t in list {
                hasher.update(t.at_ms.to_le_bytes());
                hasher.update(t.offset_secs.to_le_bytes());
            }
        }
        None => hasher.update([0u8]),
    }
    let zero_bytes = query.zero_at_date.as_bytes();
    hasher.update((zero_bytes.len() as u32).to_le_bytes());
    hasher.update(zero_bytes);
    hasher.finalize().into()
}

fn format_date_buf(y: i64, m: u32, d: u32) -> [u8; 10] {
    let y = y as u32;
    [
        b'0' + ((y / 1000) % 10) as u8,
        b'0' + ((y / 100) % 10) as u8,
        b'0' + ((y / 10) % 10) as u8,
        b'0' + (y % 10) as u8,
        b'-',
        b'0' + ((m / 10) % 10) as u8,
        b'0' + (m % 10) as u8,
        b'-',
        b'0' + ((d / 10) % 10) as u8,
        b'0' + (d % 10) as u8,
    ]
}

struct OptStringSeed;

impl<'de> DeserializeSeed<'de> for OptStringSeed {
    type Value = Option<String>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Option<String>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("optional string")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(Some(v.to_string()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(Some(v))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(None)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(None)
            }
        }
        deserializer.deserialize_any(V)
    }
}

#[derive(Default)]
struct DocMetadata {
    source: String,
    project_name: String,
    note: String,
}

enum MetaKey {
    Source,
    ProjectName,
    Note,
    Other,
}

impl<'de> Deserialize<'de> for MetaKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = MetaKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("metadata key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(match v {
                    "source" => MetaKey::Source,
                    "projectName" => MetaKey::ProjectName,
                    "note" => MetaKey::Note,
                    _ => MetaKey::Other,
                })
            }
            fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(match v {
                    b"source" => MetaKey::Source,
                    b"projectName" => MetaKey::ProjectName,
                    b"note" => MetaKey::Note,
                    _ => MetaKey::Other,
                })
            }
        }
        deserializer.deserialize_identifier(V)
    }
}

struct MetadataSeed;

impl<'de> DeserializeSeed<'de> for MetadataSeed {
    type Value = DocMetadata;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = DocMetadata;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("metadata object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut meta = DocMetadata::default();
                while let Some(key) = map.next_key::<MetaKey>()? {
                    match key {
                        MetaKey::Source => {
                            meta.source = map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        MetaKey::ProjectName => {
                            meta.project_name =
                                map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        MetaKey::Note => {
                            meta.note = map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        MetaKey::Other => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(meta)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(DocMetadata::default())
            }
        }
        deserializer.deserialize_any(V)
    }
}

struct Hex64ValidSeed;

impl<'de> DeserializeSeed<'de> for Hex64ValidSeed {
    type Value = bool;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = bool;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("64-hex string")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(is_hex64(v))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(false)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(false)
            }
        }
        deserializer.deserialize_any(V)
    }
}

struct ModelValidSeed;

impl<'de> DeserializeSeed<'de> for ModelValidSeed {
    type Value = bool;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = bool;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("model string <= 120 UTF-16 units")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(v.encode_utf16().count() <= 120)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(false)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(false)
            }
        }
        deserializer.deserialize_any(V)
    }
}

struct NullableSafeIntSeed;

impl<'de> DeserializeSeed<'de> for NullableSafeIntSeed {
    type Value = Result<Option<i64>, ()>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Result<Option<i64>, ()>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("null or safe non-negative integer")
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Ok(None))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                if (0..=MAX_SAFE_INT).contains(&v) {
                    Ok(Ok(Some(v)))
                } else {
                    Ok(Err(()))
                }
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                if v <= MAX_SAFE_INT as u64 {
                    Ok(Ok(Some(v as i64)))
                } else {
                    Ok(Err(()))
                }
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                if v.is_finite() && v >= 0.0 && v <= MAX_SAFE_INT as f64 && v.fract() == 0.0 {
                    Ok(Ok(Some(v as i64)))
                } else {
                    Ok(Err(()))
                }
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(Err(()))
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(Err(()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Err(()))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Err(()))
            }
        }
        deserializer.deserialize_any(V)
    }
}

enum RecordKey {
    Id,
    Model,
    At,
    Uncached,
    CacheRead,
    CacheWrite,
    Output,
    Other,
}

impl<'de> Deserialize<'de> for RecordKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = RecordKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("record key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(match v {
                    "id" => RecordKey::Id,
                    "model" => RecordKey::Model,
                    "at" => RecordKey::At,
                    "uncached" => RecordKey::Uncached,
                    "cacheRead" => RecordKey::CacheRead,
                    "cacheWrite" => RecordKey::CacheWrite,
                    "output" => RecordKey::Output,
                    _ => RecordKey::Other,
                })
            }
            fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(match v {
                    b"id" => RecordKey::Id,
                    b"model" => RecordKey::Model,
                    b"at" => RecordKey::At,
                    b"uncached" => RecordKey::Uncached,
                    b"cacheRead" => RecordKey::CacheRead,
                    b"cacheWrite" => RecordKey::CacheWrite,
                    b"output" => RecordKey::Output,
                    _ => RecordKey::Other,
                })
            }
        }
        deserializer.deserialize_identifier(V)
    }
}

struct RecordItemSeed<'a> {
    query: &'a LedgerProjectQuery,
    days: &'a mut BTreeMap<String, ProjectDayBucket>,
    tz_out_of_bounds: &'a mut bool,
}

impl<'de, 'a> DeserializeSeed<'de> for RecordItemSeed<'a> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V<'a> {
            query: &'a LedgerProjectQuery,
            days: &'a mut BTreeMap<String, ProjectDayBucket>,
            tz_out_of_bounds: &'a mut bool,
        }

        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = ();
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("ledger record item")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut id_valid = false;
                let mut model_valid = false;
                let mut at_val: Option<Result<Option<i64>, ()>> = None;
                let mut uncached_val: Option<Result<Option<i64>, ()>> = None;
                let mut cache_read_val: Option<Result<Option<i64>, ()>> = None;
                let mut cache_write_val: Option<Result<Option<i64>, ()>> = None;
                let mut output_val: Option<Result<Option<i64>, ()>> = None;

                while let Some(key) = map.next_key::<RecordKey>()? {
                    match key {
                        RecordKey::Id => {
                            id_valid = map.next_value_seed(Hex64ValidSeed)?;
                        }
                        RecordKey::Model => {
                            model_valid = map.next_value_seed(ModelValidSeed)?;
                        }
                        RecordKey::At => {
                            at_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::Uncached => {
                            uncached_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::CacheRead => {
                            cache_read_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::CacheWrite => {
                            cache_write_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::Output => {
                            output_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::Other => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }

                if !id_valid || !model_valid {
                    return Ok(());
                }
                let (Some(Ok(at)), Some(Ok(uncached)), Some(Ok(cache_read)), Some(Ok(cache_write)), Some(Ok(output))) =
                    (at_val, uncached_val, cache_read_val, cache_write_val, output_val)
                else {
                    return Ok(());
                };

                let date_buf;
                let (date_str, rec_max_at): (&str, i64) = match at {
                    None | Some(0) => (self.query.zero_at_date.as_str(), 0),
                    Some(at_ms) => {
                        let Some((y, m, d, _hour)) = date_ymd_hour_from_tz(
                            self.query.fixed_offset_secs,
                            self.query.tz_min_ms,
                            self.query.tz_max_ms,
                            self.query.tz_transitions.as_deref(),
                            at_ms,
                        ) else {
                            *self.tz_out_of_bounds = true;
                            return Err(de::Error::custom("tz_out_of_bounds"));
                        };
                        date_buf = format_date_buf(y, m, d);
                        let s = std::str::from_utf8(&date_buf)
                            .map_err(|_| de::Error::custom("invalid date buffer"))?;
                        (s, at_ms)
                    }
                };

                let add_uncached = uncached.unwrap_or(0);
                let add_cache_read = cache_read.unwrap_or(0);
                let add_cache_write = cache_write.unwrap_or(0);
                let add_output = output.unwrap_or(0);

                if let Some(bucket) = self.days.get_mut(date_str) {
                    bucket.uncached = bucket.uncached.saturating_add(add_uncached);
                    bucket.cache_read = bucket.cache_read.saturating_add(add_cache_read);
                    bucket.cache_write = bucket.cache_write.saturating_add(add_cache_write);
                    bucket.output = bucket.output.saturating_add(add_output);
                    bucket.requests += 1;
                    if rec_max_at > bucket.max_at {
                        bucket.max_at = rec_max_at;
                    }
                } else {
                    self.days.insert(
                        date_str.to_string(),
                        ProjectDayBucket {
                            date: date_str.to_string(),
                            uncached: add_uncached,
                            cache_read: add_cache_read,
                            cache_write: add_cache_write,
                            output: add_output,
                            requests: 1,
                            max_at: rec_max_at,
                        },
                    );
                }
                Ok(())
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(())
            }
        }

        deserializer.deserialize_any(V {
            query: self.query,
            days: self.days,
            tz_out_of_bounds: self.tz_out_of_bounds,
        })
    }
}

struct RecordsSeed<'a> {
    query: &'a LedgerProjectQuery,
    days: &'a mut BTreeMap<String, ProjectDayBucket>,
    tz_out_of_bounds: &'a mut bool,
}

impl<'de, 'a> DeserializeSeed<'de> for RecordsSeed<'a> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V<'a> {
            query: &'a LedgerProjectQuery,
            days: &'a mut BTreeMap<String, ProjectDayBucket>,
            tz_out_of_bounds: &'a mut bool,
        }

        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = ();
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("records array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                self.days.clear();
                while seq
                    .next_element_seed(RecordItemSeed {
                        query: self.query,
                        days: self.days,
                        tz_out_of_bounds: self.tz_out_of_bounds,
                    })?
                    .is_some()
                {}
                Ok(())
            }
        }

        deserializer.deserialize_seq(V {
            query: self.query,
            days: self.days,
            tz_out_of_bounds: self.tz_out_of_bounds,
        })
    }
}

enum DocKey {
    Id,
    Metadata,
    Records,
    Other,
}

impl<'de> Deserialize<'de> for DocKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = DocKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("ledger document key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(match v {
                    "id" => DocKey::Id,
                    "metadata" => DocKey::Metadata,
                    "records" => DocKey::Records,
                    _ => DocKey::Other,
                })
            }
            fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(match v {
                    b"id" => DocKey::Id,
                    b"metadata" => DocKey::Metadata,
                    b"records" => DocKey::Records,
                    _ => DocKey::Other,
                })
            }
        }
        deserializer.deserialize_identifier(V)
    }
}

struct ParsedDocFields {
    doc_id: String,
    meta: DocMetadata,
    days: BTreeMap<String, ProjectDayBucket>,
    has_records: bool,
}

struct LedgerDocSeed<'a> {
    query: &'a LedgerProjectQuery,
    tz_out_of_bounds: &'a mut bool,
}

impl<'de, 'a> DeserializeSeed<'de> for LedgerDocSeed<'a> {
    type Value = ParsedDocFields;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V<'a> {
            query: &'a LedgerProjectQuery,
            tz_out_of_bounds: &'a mut bool,
        }

        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = ParsedDocFields;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("ledger document object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out = ParsedDocFields {
                    doc_id: String::new(),
                    meta: DocMetadata::default(),
                    days: BTreeMap::new(),
                    has_records: false,
                };
                while let Some(key) = map.next_key::<DocKey>()? {
                    match key {
                        DocKey::Id => {
                            out.doc_id = map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        DocKey::Metadata => {
                            out.meta = map.next_value_seed(MetadataSeed)?;
                        }
                        DocKey::Records => {
                            map.next_value_seed(RecordsSeed {
                                query: self.query,
                                days: &mut out.days,
                                tz_out_of_bounds: self.tz_out_of_bounds,
                            })?;
                            out.has_records = true;
                        }
                        DocKey::Other => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(out)
            }
        }

        deserializer.deserialize_map(V {
            query: self.query,
            tz_out_of_bounds: self.tz_out_of_bounds,
        })
    }
}

enum ParseProjectFileStatus {
    Parsed(CachedProjectFileEntry),
    Missing,
    TransientError,
    TzOutOfBounds,
}

fn parse_project_ledger_file(
    query: &LedgerProjectQuery,
    file_name: &str,
    path: &Path,
    mtime_ns: i128,
    file_size: u64,
) -> ParseProjectFileStatus {
    let make_unreadable = || {
        ParseProjectFileStatus::Parsed(CachedProjectFileEntry {
            scope: query.scope.clone(),
            file_name: file_name.to_string(),
            mtime_ns,
            file_size,
            unreadable: true,
            doc_id: String::new(),
            source: String::new(),
            project_name: String::new(),
            note: String::new(),
            days: Vec::new(),
        })
    };

    if file_size > MAX_RECORD_FILE_BYTES {
        return make_unreadable();
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ParseProjectFileStatus::Missing,
        Err(_) => return ParseProjectFileStatus::TransientError,
    };
    if bytes.len() as u64 > MAX_RECORD_FILE_BYTES {
        return make_unreadable();
    }

    let mut tz_out_of_bounds = false;
    let mut de = serde_json::Deserializer::from_slice(&bytes);
    let parsed = LedgerDocSeed {
        query,
        tz_out_of_bounds: &mut tz_out_of_bounds,
    }
    .deserialize(&mut de);

    if tz_out_of_bounds {
        return ParseProjectFileStatus::TzOutOfBounds;
    }
    let Ok(doc) = parsed else {
        return make_unreadable();
    };
    if de.end().is_err() || !doc.has_records {
        return make_unreadable();
    }

    ParseProjectFileStatus::Parsed(CachedProjectFileEntry {
        scope: query.scope.clone(),
        file_name: file_name.to_string(),
        mtime_ns,
        file_size,
        unreadable: false,
        doc_id: doc.doc_id,
        source: doc.meta.source,
        project_name: doc.meta.project_name,
        note: doc.meta.note,
        days: doc.days.into_values().collect(),
    })
}

fn load_project_binary_cache(
    path: &Path,
    expected_tz_sig: &[u8; 32],
) -> (HashMap<(String, String), CachedProjectFileEntry>, bool) {
    let Ok(bytes) = fs::read(path) else {
        return (HashMap::new(), true);
    };
    if bytes.len() < 8 + 4 + 32 + 4 + 8 {
        return (HashMap::new(), true);
    }
    let payload_end = bytes.len() - 8;
    let payload = &bytes[..payload_end];
    let checksum = &bytes[payload_end..];
    let digest = Sha256::digest(payload);
    if &digest[..8] != checksum {
        return (HashMap::new(), true);
    }

    let Some((cached_tz_sig, entries)) = decode_project_binary_payload(payload) else {
        return (HashMap::new(), true);
    };
    if &cached_tz_sig != expected_tz_sig {
        return (HashMap::new(), true);
    }

    let mut map = HashMap::with_capacity(entries.len());
    for e in entries {
        map.insert((e.scope.clone(), e.file_name.clone()), e);
    }
    (map, false)
}

fn decode_project_binary_payload(
    payload: &[u8],
) -> Option<([u8; 32], Vec<CachedProjectFileEntry>)> {
    let mut cur = BinCursor::new(payload);
    if cur.read_bytes(8)? != PROJECT_CACHE_MAGIC {
        return None;
    }
    if cur.read_u32()? != PROJECT_CACHE_VERSION {
        return None;
    }
    let tz_sig_slice = cur.read_bytes(32)?;
    let tz_sig: [u8; 32] = tz_sig_slice.try_into().ok()?;
    let count = cur.read_u32()? as usize;
    let mut out = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        let scope = cur.read_str()?;
        let file_name = cur.read_str()?;
        let mtime_ns = cur.read_i128()?;
        let file_size = cur.read_u64()?;
        let flags = cur.read_u8()?;
        let unreadable = (flags & 0x01) != 0;

        let mut doc_id = String::new();
        let mut source = String::new();
        let mut project_name = String::new();
        let mut note = String::new();
        let mut days = Vec::new();

        if !unreadable {
            doc_id = cur.read_str()?;
            source = cur.read_str()?;
            project_name = cur.read_str()?;
            note = cur.read_str()?;
            let day_count = cur.read_u32()? as usize;
            days.reserve(day_count.min(1024));
            for _ in 0..day_count {
                let date = cur.read_str()?;
                if date.is_empty() || date.len() > 32 {
                    return None;
                }
                let uncached = cur.read_i64()?;
                let cache_read = cur.read_i64()?;
                let cache_write = cur.read_i64()?;
                let output = cur.read_i64()?;
                let requests = cur.read_i64()?;
                let max_at = cur.read_i64()?;
                if uncached < 0
                    || cache_read < 0
                    || cache_write < 0
                    || output < 0
                    || requests < 0
                    || !(0..=MAX_SAFE_INT).contains(&max_at)
                {
                    return None;
                }
                days.push(ProjectDayBucket {
                    date,
                    uncached,
                    cache_read,
                    cache_write,
                    output,
                    requests,
                    max_at,
                });
            }
        }
        out.push(CachedProjectFileEntry {
            scope,
            file_name,
            mtime_ns,
            file_size,
            unreadable,
            doc_id,
            source,
            project_name,
            note,
            days,
        });
    }
    if cur.pos != payload.len() {
        return None;
    }
    Some((tz_sig, out))
}

fn encode_project_binary_cache(
    tz_signature: &[u8; 32],
    entries: &[&CachedProjectFileEntry],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(entries.len() * 192 + 64);
    buf.extend_from_slice(PROJECT_CACHE_MAGIC);
    buf.extend_from_slice(&PROJECT_CACHE_VERSION.to_le_bytes());
    buf.extend_from_slice(tz_signature);
    buf.extend_from_slice(&(entries.len() as u32).to_le_bytes());

    for e in entries {
        write_str(&mut buf, &e.scope);
        write_str(&mut buf, &e.file_name);
        buf.extend_from_slice(&e.mtime_ns.to_le_bytes());
        buf.extend_from_slice(&e.file_size.to_le_bytes());
        let flags: u8 = if e.unreadable { 0x01 } else { 0 };
        buf.push(flags);
        if !e.unreadable {
            write_str(&mut buf, &e.doc_id);
            write_str(&mut buf, &e.source);
            write_str(&mut buf, &e.project_name);
            write_str(&mut buf, &e.note);
            buf.extend_from_slice(&(e.days.len() as u32).to_le_bytes());
            for d in &e.days {
                write_str(&mut buf, &d.date);
                buf.extend_from_slice(&d.uncached.to_le_bytes());
                buf.extend_from_slice(&d.cache_read.to_le_bytes());
                buf.extend_from_slice(&d.cache_write.to_le_bytes());
                buf.extend_from_slice(&d.output.to_le_bytes());
                buf.extend_from_slice(&d.requests.to_le_bytes());
                buf.extend_from_slice(&d.max_at.to_le_bytes());
            }
        }
    }

    let digest = Sha256::digest(&buf);
    buf.extend_from_slice(&digest[..8]);
    buf
}

fn persist_project_cache(
    dir: &Path,
    tz_signature: &[u8; 32],
    entries: &HashMap<(String, String), CachedProjectFileEntry>,
) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let cache_path = dir.join(PROJECT_CACHE_FILE);
    if entries.is_empty() && !cache_path.exists() {
        return true;
    }
    let mut sorted: Vec<&CachedProjectFileEntry> = entries.values().collect();
    sorted.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
    let encoded = encode_project_binary_cache(tz_signature, &sorted);
    atomic_write_cache_file(dir, PROJECT_CACHE_FILE, &encoded)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDayBucketOut<'a> {
    date: &'a str,
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    requests: i64,
    max_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFileSummaryOut<'a> {
    file_hash: &'a str,
    doc_id: &'a str,
    source: &'a str,
    project_name: &'a str,
    note: &'a str,
    days: Vec<ProjectDayBucketOut<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummariesOut<'a> {
    scope: &'a str,
    time_zone: &'a str,
    files: Vec<ProjectFileSummaryOut<'a>>,
}

struct ProjectDirtyTask {
    name: String,
    path: PathBuf,
    mtime_ns: i128,
    file_size: u64,
}

pub fn read_ledger_project_summaries_json(query_json: &str) -> Option<String> {
    let query: LedgerProjectQuery = serde_json::from_str(query_json).ok()?;
    if query.directory.is_empty() || !is_hex64(&query.scope) || query.zero_at_date.is_empty() {
        return None;
    }

    let tz_signature = compute_tz_signature(&query);
    let dir = Path::new(&query.directory);
    let cache_path = dir.join(PROJECT_CACHE_FILE);
    let (bin_mtime_ns, bin_size) = read_cache_file_stamp(&cache_path);

    let mem_hit = if bin_size.is_none() || bin_mtime_ns.is_some() {
        let guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().and_then(|c| {
            if c.directory == query.directory
                && c.bin_mtime_ns == bin_mtime_ns
                && c.bin_size == bin_size
                && c.tz_signature == tz_signature
            {
                Some(Arc::clone(&c.entries))
            } else {
                None
            }
        })
    } else {
        None
    };

    let was_mem_hit = mem_hit.is_some();
    let (mut cache_arc, mut cache_dirty) = match mem_hit {
        Some(arc) => (arc, false),
        None => {
            let (map, dirty) = load_project_binary_cache(&cache_path, &tz_signature);
            (Arc::new(map), dirty)
        }
    };

    let dirty_set: HashSet<String> = query
        .dirty_rel_paths
        .iter()
        .map(|p| p.replace('\\', "/"))
        .collect();

    let scope_dir = dir.join(&query.scope);
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

    let has_removed = cache_arc
        .keys()
        .any(|(cs, cname)| cs == &query.scope && !valid_set.contains(cname.as_str()));
    if has_removed {
        let keys_to_remove: Vec<(String, String)> = cache_arc
            .keys()
            .filter(|(cs, cname)| cs == &query.scope && !valid_set.contains(cname.as_str()))
            .cloned()
            .collect();
        let cache_map = Arc::make_mut(&mut cache_arc);
        for k in keys_to_remove {
            cache_map.remove(&k);
            cache_dirty = true;
        }
    }

    let mut existing_files = Vec::with_capacity(valid_files.len());
    let mut dirty_tasks: Vec<ProjectDirtyTask> = Vec::new();

    for name in valid_files {
        let full_path = scope_dir.join(&name);
        let file_meta = match fs::metadata(&full_path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = (query.scope.clone(), name);
                if cache_arc.contains_key(&key) {
                    Arc::make_mut(&mut cache_arc).remove(&key);
                    cache_dirty = true;
                }
                continue;
            }
            Err(_) => return None,
        };
        let mtime_ns = mtime_ns_from_metadata(&file_meta)?;
        let file_size = file_meta.len();
        let rel_path = format!("{}/{name}", query.scope);
        let is_dirty = dirty_set.contains(&rel_path);
        let cache_hit = !is_dirty
            && cache_arc
                .get(&(query.scope.clone(), name.clone()))
                .is_some_and(|e| e.mtime_ns == mtime_ns && e.file_size == file_size);
        if !cache_hit {
            dirty_tasks.push(ProjectDirtyTask {
                name: name.clone(),
                path: full_path,
                mtime_ns,
                file_size,
            });
        }
        existing_files.push(name);
    }

    if !dirty_tasks.is_empty() {
        let mut results: Vec<Option<ParseProjectFileStatus>> =
            (0..dirty_tasks.len()).map(|_| None).collect();
        let abort_flag = AtomicBool::new(false);
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
                            if abort_flag.load(Ordering::Relaxed) {
                                break;
                            }
                            let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                            if idx >= dirty_tasks.len() {
                                break;
                            }
                            let task = &dirty_tasks[idx];
                            let status = parse_project_ledger_file(
                                &query,
                                &task.name,
                                &task.path,
                                task.mtime_ns,
                                task.file_size,
                            );
                            if matches!(
                                status,
                                ParseProjectFileStatus::TransientError
                                    | ParseProjectFileStatus::TzOutOfBounds
                            ) {
                                abort_flag.store(true, Ordering::Relaxed);
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
                let status = parse_project_ledger_file(
                    &query,
                    &task.name,
                    &task.path,
                    task.mtime_ns,
                    task.file_size,
                );
                if matches!(
                    status,
                    ParseProjectFileStatus::TransientError
                        | ParseProjectFileStatus::TzOutOfBounds
                ) {
                    abort_flag.store(true, Ordering::Relaxed);
                    break;
                }
                results[idx] = Some(status);
            }
        }
        if abort_flag.load(Ordering::Relaxed) {
            return None;
        }
        let cache_map = Arc::make_mut(&mut cache_arc);
        for (idx, task) in dirty_tasks.into_iter().enumerate() {
            match results[idx].take()? {
                ParseProjectFileStatus::Parsed(entry) => {
                    cache_map.insert((query.scope.clone(), task.name), entry);
                    cache_dirty = true;
                }
                ParseProjectFileStatus::Missing => {
                    if cache_map
                        .remove(&(query.scope.clone(), task.name))
                        .is_some()
                    {
                        cache_dirty = true;
                    }
                }
                ParseProjectFileStatus::TransientError
                | ParseProjectFileStatus::TzOutOfBounds => return None,
            }
        }
    }

    if cache_dirty {
        let persisted = persist_project_cache(dir, &tz_signature, &cache_arc);
        let (new_mtime_ns, new_size) = read_cache_file_stamp(&cache_path);
        let mut guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if persisted && (new_size.is_none() || new_mtime_ns.is_some()) {
            *guard = Some(InMemProjectCache {
                directory: query.directory.clone(),
                bin_mtime_ns: new_mtime_ns,
                bin_size: new_size,
                tz_signature,
                entries: Arc::clone(&cache_arc),
            });
        } else if guard
            .as_ref()
            .is_some_and(|c| c.directory == query.directory)
        {
            *guard = None;
        }
    } else if !was_mem_hit && (bin_size.is_none() || bin_mtime_ns.is_some()) {
        let mut guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(InMemProjectCache {
            directory: query.directory.clone(),
            bin_mtime_ns,
            bin_size,
            tz_signature,
            entries: Arc::clone(&cache_arc),
        });
    }

    let mut files_out = Vec::with_capacity(existing_files.len());
    for name in &existing_files {
        let Some(entry) = cache_arc.get(&(query.scope.clone(), name.clone())) else {
            continue;
        };
        if entry.unreadable {
            continue;
        }
        let days = entry
            .days
            .iter()
            .map(|d| ProjectDayBucketOut {
                date: &d.date,
                uncached: d.uncached,
                cache_read: d.cache_read,
                cache_write: d.cache_write,
                output: d.output,
                requests: d.requests,
                max_at: d.max_at,
            })
            .collect();
        files_out.push(ProjectFileSummaryOut {
            file_hash: name.strip_suffix(".json").unwrap_or(name),
            doc_id: &entry.doc_id,
            source: &entry.source,
            project_name: &entry.project_name,
            note: &entry.note,
            days,
        });
    }

    let out = ProjectSummariesOut {
        scope: &query.scope,
        time_zone: &query.time_zone,
        files: files_out,
    };
    serde_json::to_string(&out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        static TEST_SEQ: AtomicU64 = AtomicU64::new(0);
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "pulse-accel-proj-ledger-{label}-{}-{ts}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hex64(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn write_raw_doc(dir: &Path, scope: &str, file_hash: &str, doc: Value) -> PathBuf {
        let scope_dir = dir.join(scope);
        fs::create_dir_all(&scope_dir).unwrap();
        let file_path = scope_dir.join(format!("{file_hash}.json"));
        fs::write(&file_path, serde_json::to_vec(&doc).unwrap()).unwrap();
        file_path
    }

    #[test]
    fn test_project_ledger_cold_warm_dirty_corrupt_and_delete() {
        let dir = temp_dir("cache");
        let scope_a = hex64('a');
        let fhash1 = hex64('b');
        let fhash2 = hex64('c');
        let fhash_bad = hex64('d');
        let fhash_norec = hex64('e');
        let rid1 = hex64('1');

        let f1 = write_raw_doc(
            &dir,
            &scope_a,
            &fhash1,
            serde_json::json!({
                "schema": 99,
                "account": "unrelated-account",
                "id": "conv-1",
                "metadata": {
                    "source": "remote-manual",
                    "projectName": "AlphaProj",
                    "note": "Initial note"
                },
                "records": [{
                    "id": rid1,
                    "at": 1791684000000i64,
                    "model": "Gemini 3.8",
                    "uncached": 100,
                    "cacheRead": 900,
                    "cacheWrite": 20,
                    "output": 80
                }]
            }),
        );
        let f2 = write_raw_doc(
            &dir,
            &scope_a,
            &fhash2,
            serde_json::json!({
                "records": [{
                    "id": hex64('2'),
                    "at": null,
                    "model": "Gemini 3.8",
                    "uncached": 50,
                    "cacheRead": null,
                    "cacheWrite": 0,
                    "output": 25
                }]
            }),
        );
        // Unreadable files: broken JSON and missing records array
        let scope_dir = dir.join(&scope_a);
        fs::write(scope_dir.join(format!("{fhash_bad}.json")), b"{broken").unwrap();
        write_raw_doc(&dir, &scope_a, &fhash_norec, serde_json::json!({ "id": "x" }));

        let base_query = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "Asia/Shanghai",
            "fixedOffsetSecs": 28800,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });

        let out1: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out1["scope"], scope_a);
        assert_eq!(out1["timeZone"], "Asia/Shanghai");
        let files1 = out1["files"].as_array().unwrap();
        assert_eq!(files1.len(), 2);

        let f1_out = files1.iter().find(|f| f["fileHash"] == fhash1).unwrap();
        assert_eq!(f1_out["docId"], "conv-1");
        assert_eq!(f1_out["source"], "remote-manual");
        assert_eq!(f1_out["projectName"], "AlphaProj");
        assert_eq!(f1_out["note"], "Initial note");
        assert_eq!(f1_out["days"][0]["date"], "2026-10-11");
        assert_eq!(f1_out["days"][0]["uncached"], 100);
        assert_eq!(f1_out["days"][0]["cacheRead"], 900);
        assert_eq!(f1_out["days"][0]["cacheWrite"], 20);
        assert_eq!(f1_out["days"][0]["output"], 80);
        assert_eq!(f1_out["days"][0]["requests"], 1);
        assert_eq!(f1_out["days"][0]["maxAt"], 1791684000000i64);

        let f2_out = files1.iter().find(|f| f["fileHash"] == fhash2).unwrap();
        assert_eq!(f2_out["docId"], "");
        assert_eq!(f2_out["source"], "");
        assert_eq!(f2_out["days"][0]["date"], "1970-01-01");
        assert_eq!(f2_out["days"][0]["maxAt"], 0);
        assert_eq!(f2_out["days"][0]["uncached"], 50);
        assert_eq!(f2_out["days"][0]["output"], 25);

        let cache_path = dir.join(PROJECT_CACHE_FILE);
        assert!(cache_path.exists());
        assert!(!dir.join("ledger-compact-v1.bin").exists());
        let bin_bytes = fs::read(&cache_path).unwrap();
        assert_eq!(&bin_bytes[..8], PROJECT_CACHE_MAGIC);
        let stamp1 = read_cache_file_stamp(&cache_path);

        // Warm hit: binary stamp unchanged
        let out_warm: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_warm, out1);
        assert_eq!(read_cache_file_stamp(&cache_path), stamp1);

        // Corrupt binary sidecar -> rebuilds gracefully
        fs::write(&cache_path, b"BADMAGIC").unwrap();
        let out_rebuilt: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_rebuilt, out1);

        // Delete binary sidecar -> recreated
        fs::remove_file(&cache_path).unwrap();
        let out_recreated: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_recreated, out1);
        assert!(cache_path.exists());

        // Same-size overwrite with dirtyRelPaths -> forces re-parse
        write_raw_doc(
            &dir,
            &scope_a,
            &fhash1,
            serde_json::json!({
                "schema": 99,
                "account": "unrelated-account",
                "id": "conv-1",
                "metadata": {
                    "source": "remote-manual",
                    "projectName": "AlphaProj",
                    "note": "Initial note"
                },
                "records": [{
                    "id": rid1,
                    "at": 1791684000000i64,
                    "model": "Gemini 3.8",
                    "uncached": 200,
                    "cacheRead": 800,
                    "cacheWrite": 20,
                    "output": 90
                }]
            }),
        );
        let mut dirty_query = base_query.clone();
        dirty_query["dirtyRelPaths"] = serde_json::json!([format!("{scope_a}/{fhash1}.json")]);
        let out_dirty: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&dirty_query.to_string()).unwrap(),
        )
        .unwrap();
        let f1_dirty = out_dirty["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["fileHash"] == fhash1)
            .unwrap();
        assert_eq!(f1_dirty["days"][0]["uncached"], 200);
        assert_eq!(f1_dirty["days"][0]["output"], 90);

        // Delete f2 and break f1 -> files drops f1 and f2
        fs::remove_file(&f2).unwrap();
        fs::write(&f1, b"{broken").unwrap();
        let mut dirty_query2 = base_query.clone();
        dirty_query2["dirtyRelPaths"] = serde_json::json!([format!("{scope_a}/{fhash1}.json")]);
        let out_after_del: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&dirty_query2.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_after_del["files"].as_array().unwrap().len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_project_ledger_valid_row_filtering_and_at_edge_cases() {
        let dir = temp_dir("rows");
        let scope_a = hex64('a');
        let fhash = hex64('b');
        let emoji_61: String = std::iter::repeat_n('😀', 61).collect(); // 61 chars = 122 UTF-16 units (> 120!)
        let emoji_60: String = std::iter::repeat_n('😀', 60).collect(); // 60 chars = 120 UTF-16 units (<= 120)

        write_raw_doc(
            &dir,
            &scope_a,
            &fhash,
            serde_json::json!({
                "id": 12345, // non-string -> ""
                "metadata": { "source": null, "projectName": "P", "note": 42 },
                "records": [
                    null,
                    "not-an-object",
                    [1, 2],
                    { "id": "short", "at": 1791684000000i64, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('1'), "at": 1791684000000i64, "model": emoji_61, "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('2'), "at": -1, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('3'), "at": 1.5, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('4'), "at": 9007199254740992i64, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('5'), "at": 0, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0 }, // missing output
                    // Valid rows:
                    { "id": hex64('6'), "at": null, "model": emoji_60, "uncached": 30, "cacheRead": null, "cacheWrite": 5, "output": 10 },
                    { "id": hex64('7'), "at": 0, "model": "m", "uncached": 20, "cacheRead": 1, "cacheWrite": 0, "output": 4 },
                    { "id": hex64('8'), "at": 1791684000000i64, "model": "m", "uncached": 100.0, "cacheRead": 0, "cacheWrite": 0, "output": 50 },
                    { "id": hex64('9'), "at": 1791684005000i64, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 5 }
                ]
            }),
        );

        let query = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "UTC",
            "fixedOffsetSecs": 0,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });

        let out: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&query.to_string()).unwrap(),
        )
        .unwrap();
        let file = &out["files"][0];
        assert_eq!(file["docId"], "");
        assert_eq!(file["source"], "");
        assert_eq!(file["projectName"], "P");
        assert_eq!(file["note"], "");

        let days = file["days"].as_array().unwrap();
        assert_eq!(days.len(), 2);
        assert_eq!(days[0]["date"], "1970-01-01");
        assert_eq!(days[0]["uncached"], 50);
        assert_eq!(days[0]["cacheRead"], 1);
        assert_eq!(days[0]["cacheWrite"], 5);
        assert_eq!(days[0]["output"], 14);
        assert_eq!(days[0]["requests"], 2);
        assert_eq!(days[0]["maxAt"], 0);

        assert_eq!(days[1]["date"], "2026-10-11");
        assert_eq!(days[1]["uncached"], 110);
        assert_eq!(days[1]["output"], 55);
        assert_eq!(days[1]["requests"], 2);
        assert_eq!(days[1]["maxAt"], 1791684005000i64);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_project_ledger_cross_scope_tz_change_and_parallel() {
        let dir = temp_dir("cross-tz");
        let scope_a = hex64('a');
        let scope_b = hex64('b');
        // 2026-10-10T20:00:00Z -> UTC: 2026-10-10, Asia/Shanghai (+8h): 2026-10-11, NY (-4h EDT): 2026-10-10
        let at_ms: i64 = 1791662400000;

        // 12 files in scope_a (> PARALLEL_DIRTY_THRESHOLD)
        for i in 0..12u8 {
            let h = format!("{:064x}", i + 1);
            write_raw_doc(
                &dir,
                &scope_a,
                &h,
                serde_json::json!({
                    "id": format!("conv-a-{i}"),
                    "records": [{
                        "id": format!("{:064x}", i + 100),
                        "at": at_ms,
                        "model": "m",
                        "uncached": 10,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "output": 5
                    }]
                }),
            );
        }
        // 1 file in scope_b
        write_raw_doc(
            &dir,
            &scope_b,
            &hex64('f'),
            serde_json::json!({
                "id": "conv-b-0",
                "records": [{
                    "id": hex64('9'),
                    "at": at_ms,
                    "model": "m",
                    "uncached": 40,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "output": 10
                }]
            }),
        );

        let q_a_utc = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "UTC",
            "fixedOffsetSecs": 0,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });
        let out_a_utc: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&q_a_utc.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_a_utc["files"].as_array().unwrap().len(), 12);
        assert_eq!(out_a_utc["files"][0]["days"][0]["date"], "2026-10-10");

        let q_b_utc = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_b,
            "timeZone": "UTC",
            "fixedOffsetSecs": 0,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });
        let out_b_utc: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&q_b_utc.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_b_utc["files"].as_array().unwrap().len(), 1);
        assert_eq!(out_b_utc["files"][0]["docId"], "conv-b-0");

        // Verify both scopes are preserved in project-ledger-v1.bin
        let payload = fs::read(dir.join(PROJECT_CACHE_FILE)).unwrap();
        let (_sig, entries) =
            decode_project_binary_payload(&payload[..payload.len() - 8]).unwrap();
        assert_eq!(entries.len(), 13);

        // Switch timezone -> invalidates & rebuilds cleanly
        let q_a_sh = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "Asia/Shanghai",
            "fixedOffsetSecs": 28800,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });
        let out_a_sh: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&q_a_sh.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_a_sh["files"].as_array().unwrap().len(), 12);
        assert_eq!(out_a_sh["files"][0]["days"][0]["date"], "2026-10-11");

        // Out-of-bounds tzMinMs/tzMaxMs -> returns None cleanly for TS fallback
        let q_oob = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "America/New_York",
            "tzMinMs": 1798761600000i64,
            "tzMaxMs": 1830297600000i64,
            "tzTransitions": [{ "atMs": 1798761600000i64, "offsetSecs": -18000 }],
            "zeroAtDate": "1969-12-31",
            "dirtyRelPaths": []
        });
        assert!(read_ledger_project_summaries_json(&q_oob.to_string()).is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
