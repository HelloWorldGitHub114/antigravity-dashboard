use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CHUNK_SIZE: usize = 64 * 1024;
const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;
const DEFAULT_MAX_LINES: usize = 8192;
const DEFAULT_TAIL_BYTES: usize = 512 * 1024;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTranscriptInput {
    pub file_path: String,
    pub offset: Option<u64>,
    pub max_bytes: Option<u64>,
    pub max_lines: Option<usize>,
    pub tail_bytes: Option<usize>,
    pub max_rows: Option<usize>,
    pub include_all_rows: Option<bool>,
    pub known_indices: Option<Vec<u64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanAnchor {
    pub offset: u64,
    pub length: usize,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedTranscriptRow {
    pub index: u64,
    #[serde(rename = "type")]
    pub step_type: String,
    pub source: Option<String>,
    pub status: Option<String>,
    pub created_at: Option<String>,
    pub user_tokens: u64,
    pub assistant_tokens: u64,
    pub tool_tokens: u64,
    pub system_tokens: u64,
    pub compaction: u8,
    pub image: u8,
    pub unknown: bool,
    pub tool_names: Vec<String>,
    pub model: Option<String>,
    pub media_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTranscriptOutput {
    pub version: u32,
    pub file_size: u64,
    pub offset: u64,
    pub bytes_scanned: u64,
    pub next_offset: u64,
    pub eof: bool,
    pub needs_chunked_fallback: bool,
    pub incomplete_trailing_line: bool,
    pub invalid: bool,
    pub limit: bool,
    pub total_lines: usize,
    pub valid_lines: usize,
    pub invalid_lines: usize,
    pub user_tokens: u64,
    pub assistant_tokens: u64,
    pub tool_tokens: u64,
    pub system_tokens: u64,
    pub total_tokens: u64,
    pub compaction_markers: usize,
    pub image_steps: usize,
    pub media_count: usize,
    pub tool_names: Vec<String>,
    pub models: Vec<String>,
    pub anchors: Vec<ScanAnchor>,
    pub rows: Vec<ScannedTranscriptRow>,
}

struct TextEstimate {
    tokens: u64,
    prefix: String,
}

fn estimate_str_tokens(s: &str, capture_prefix: bool) -> TextEstimate {
    let mut ascii: u64 = 0;
    let mut other: u64 = 0;
    let mut prefix = String::new();
    let mut prefix_utf16: usize = 0;
    for ch in s.chars() {
        let u16_len = ch.len_utf16();
        if ch.is_ascii() {
            ascii += 1;
        } else {
            other += u16_len as u64;
        }
        if capture_prefix && prefix_utf16 < 256 {
            prefix.push(ch);
            prefix_utf16 += u16_len;
        }
    }
    let tokens = ((ascii as f64) / 4.0 + (other as f64) / 1.5).ceil() as u64;
    TextEstimate { tokens, prefix }
}

struct TextEstimateSeed {
    capture_prefix: bool,
}

impl<'de> DeserializeSeed<'de> for TextEstimateSeed {
    type Value = Option<TextEstimate>;

    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        de.deserialize_any(TextEstimateVisitor {
            capture_prefix: self.capture_prefix,
        })
    }
}

struct TextEstimateVisitor {
    capture_prefix: bool,
}

impl<'de> Visitor<'de> for TextEstimateVisitor {
    type Value = Option<TextEstimate>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("string or ignored JSON value")
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(Some(estimate_str_tokens(v, self.capture_prefix)))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(Some(estimate_str_tokens(&v, self.capture_prefix)))
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

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
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

struct OptSafeIndex;
impl<'de> DeserializeSeed<'de> for OptSafeIndex {
    type Value = Option<u64>;

    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Option<u64>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("step_index")
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok((v <= MAX_SAFE_INT).then_some(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok((v >= 0 && (v as u64) <= MAX_SAFE_INT).then_some(v as u64))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v <= MAX_SAFE_INT as f64 {
                    Ok(Some(v as u64))
                } else {
                    Ok(None)
                }
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
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
        de.deserialize_any(V)
    }
}

struct OptCappedStr(usize);
impl<'de> DeserializeSeed<'de> for OptCappedStr {
    type Value = Option<String>;

    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        struct V(usize);
        impl<'de> Visitor<'de> for V {
            type Value = Option<String>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("string or ignored")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                let utf16: usize = v.chars().map(|c| c.len_utf16()).sum();
                if utf16 <= self.0 {
                    Ok(Some(v.to_string()))
                } else {
                    Ok(None)
                }
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
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
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
        de.deserialize_any(V(self.0))
    }
}

struct ToolNamesVisitor;
impl<'de> Visitor<'de> for ToolNamesVisitor {
    type Value = Vec<String>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("tool_calls array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        struct ItemSeed;
        impl<'de> DeserializeSeed<'de> for ItemSeed {
            type Value = Option<String>;
            fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
                struct ItemV;
                impl<'de> Visitor<'de> for ItemV {
                    type Value = Option<String>;
                    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                        f.write_str("tool call object")
                    }
                    fn visit_map<M: MapAccess<'de>>(self, mut m: M) -> Result<Self::Value, M::Error> {
                        let mut name = None;
                        while let Some(k) = m.next_key::<String>()? {
                            if k == "name" {
                                name = m.next_value_seed(OptCappedStr(128))?;
                            } else {
                                let _ = m.next_value::<IgnoredAny>()?;
                            }
                        }
                        Ok(name)
                    }
                    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_seq<S: SeqAccess<'de>>(self, mut s: S) -> Result<Self::Value, S::Error> {
                        while s.next_element::<IgnoredAny>()?.is_some() {}
                        Ok(None)
                    }
                }
                de.deserialize_any(ItemV)
            }
        }
        let mut names = Vec::new();
        while let Some(opt) = seq.next_element_seed(ItemSeed)? {
            if let Some(n) = opt {
                if !n.is_empty() && names.len() < 64 {
                    names.push(n);
                }
            }
        }
        Ok(names)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(Vec::new()) }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(Vec::new()) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(Vec::new()) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(Vec::new()) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(Vec::new()) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(Vec::new()) }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Vec::new())
    }
}

struct ToolNamesSeed;
impl<'de> DeserializeSeed<'de> for ToolNamesSeed {
    type Value = Vec<String>;
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        de.deserialize_any(ToolNamesVisitor)
    }
}

struct MediaCountSeed;
impl<'de> DeserializeSeed<'de> for MediaCountSeed {
    type Value = usize;
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = usize;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("media array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut count = 0usize;
                while seq.next_element::<IgnoredAny>()?.is_some() {
                    count += 1;
                }
                Ok(count)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(0)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(0) }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(0) }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(0) }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(0) }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(0) }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Self::Value, E> {
                Ok(usize::from(!s.is_empty()))
            }
        }
        de.deserialize_any(V)
    }
}

struct ExtractedRecord {
    step_index: Option<u64>,
    step_type: Option<String>,
    source: Option<String>,
    status: Option<String>,
    created_at: Option<String>,
    content: Option<TextEstimate>,
    thinking: Option<TextEstimate>,
    tool_names: Vec<String>,
    model: Option<String>,
    media_count: usize,
}

struct MetadataModelSeed;
impl<'de> DeserializeSeed<'de> for MetadataModelSeed {
    type Value = Option<String>;
    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Option<String>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("metadata object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut found: Option<String> = None;
                while let Some(k) = map.next_key::<String>()? {
                    if k == "model" || k == "generatorModel" {
                        if let Some(m) = map.next_value_seed(OptCappedStr(256))? {
                            if !m.is_empty() && (found.is_none() || k == "generatorModel") {
                                found = Some(m);
                            }
                        }
                    } else {
                        let _ = map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(found)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Self::Value, A::Error> {
                while s.next_element::<IgnoredAny>()?.is_some() {}
                Ok(None)
            }
        }
        de.deserialize_any(V)
    }
}

struct RecordSeed;
impl<'de> DeserializeSeed<'de> for RecordSeed {
    type Value = Option<ExtractedRecord>;

    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Option<ExtractedRecord>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("transcript record object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut rec = ExtractedRecord {
                    step_index: None,
                    step_type: None,
                    source: None,
                    status: None,
                    created_at: None,
                    content: None,
                    thinking: None,
                    tool_names: Vec::new(),
                    model: None,
                    media_count: 0,
                };
                while let Some(k) = map.next_key::<String>()? {
                    match k.as_str() {
                        "step_index" => rec.step_index = map.next_value_seed(OptSafeIndex)?,
                        "type" => rec.step_type = map.next_value_seed(OptCappedStr(128))?,
                        "source" => rec.source = map.next_value_seed(OptCappedStr(16_384))?,
                        "status" => rec.status = map.next_value_seed(OptCappedStr(128))?,
                        "created_at" => rec.created_at = map.next_value_seed(OptCappedStr(16_384))?,
                        "content" => {
                            rec.content = map.next_value_seed(TextEstimateSeed {
                                capture_prefix: true,
                            })?;
                        }
                        "thinking" => {
                            rec.thinking = map.next_value_seed(TextEstimateSeed {
                                capture_prefix: false,
                            })?;
                        }
                        "tool_calls" => rec.tool_names = map.next_value_seed(ToolNamesSeed)?,
                        "model" => {
                            if let Some(m) = map.next_value_seed(OptCappedStr(256))? {
                                if !m.is_empty() {
                                    rec.model = Some(m);
                                }
                            }
                        }
                        "metadata" => {
                            if let Some(m) = map.next_value_seed(MetadataModelSeed)? {
                                if rec.model.is_none() {
                                    rec.model = Some(m);
                                }
                            }
                        }
                        "media" => rec.media_count = map.next_value_seed(MediaCountSeed)?,
                        _ => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(Some(rec))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Self::Value, A::Error> {
                while s.next_element::<IgnoredAny>()?.is_some() {}
                Ok(None)
            }
        }
        de.deserialize_any(V)
    }
}

fn is_compaction_prefix(prefix: &str) -> bool {
    let trimmed = prefix.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    const PATTERNS: [&str; 10] = [
        "[context summary]",
        "[context compaction]",
        "context summary",
        "context compaction",
        "conversation summary",
        "conversation checkpoint",
        "checkpoint summary",
        "# resuming from a compaction",
        "<context_summary>",
        "[context ",
    ];
    if PATTERNS[..9].iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    if lower.starts_with("[context ") {
        let rest = &lower["[context ".len()..];
        return rest.starts_with("summary") || rest.starts_with("compaction");
    }
    false
}

fn summarize_record(rec: ExtractedRecord) -> Option<ScannedTranscriptRow> {
    let index = rec.step_index?;
    let raw_type = rec.step_type?;
    if raw_type.is_empty() {
        return None;
    }
    let step_type = raw_type
        .strip_prefix("CORTEX_STEP_TYPE_")
        .unwrap_or(&raw_type)
        .to_string();

    let (content_tokens, prefix) = match rec.content {
        Some(est) => (est.tokens, est.prefix),
        None => (0, String::new()),
    };
    let thinking_tokens = rec.thinking.map_or(0, |est| est.tokens);
    content_tokens.checked_add(thinking_tokens)?;

    let compaction = u8::from(
        step_type == "COMPACTION"
            || step_type == "CONTEXT_COMPACTION"
            || (step_type == "CHECKPOINT" && is_compaction_prefix(&prefix)),
    );
    let image = u8::from(step_type == "GENERATE_IMAGE" || step_type == "IMAGE_GENERATION");

    let mut row = ScannedTranscriptRow {
        index,
        step_type: step_type.clone(),
        source: rec.source,
        status: rec.status,
        created_at: rec.created_at,
        user_tokens: 0,
        assistant_tokens: 0,
        tool_tokens: 0,
        system_tokens: 0,
        compaction,
        image,
        unknown: false,
        tool_names: rec.tool_names,
        model: rec.model,
        media_count: rec.media_count,
    };

    if step_type == "USER_INPUT" {
        row.user_tokens = content_tokens;
    } else if step_type == "PLANNER_RESPONSE" {
        row.assistant_tokens = content_tokens + thinking_tokens;
    } else if step_type == "SYSTEM_MESSAGE" || step_type == "CHECKPOINT" || compaction == 1 {
        row.system_tokens = content_tokens;
    } else if step_type == "GENERIC" || step_type == "TOOL_RESULT" || step_type == "TOOL_OUTPUT" {
        row.tool_tokens = content_tokens;
    } else {
        row.unknown = content_tokens > 0 || thinking_tokens > 0;
    }

    Some(row)
}

struct ChunkReader {
    file: File,
    buf: Vec<u8>,
    pos: usize,
    len: usize,
    file_pos: u64,
    end_limit: u64,
    first_64k: Vec<u8>,
}

impl ChunkReader {
    fn new(mut file: File, start_offset: u64, end_limit: u64) -> io::Result<Self> {
        if start_offset > 0 {
            file.seek(SeekFrom::Start(start_offset))?;
        }
        Ok(Self {
            file,
            buf: vec![0u8; CHUNK_SIZE],
            pos: 0,
            len: 0,
            file_pos: start_offset,
            end_limit,
            first_64k: Vec::new(),
        })
    }

    fn refill(&mut self) -> io::Result<usize> {
        if self.pos < self.len {
            return Ok(self.len - self.pos);
        }
        let remaining = self.end_limit.saturating_sub(self.file_pos);
        if remaining == 0 {
            return Ok(0);
        }
        let to_read = (remaining as usize).min(CHUNK_SIZE);
        let n = self.file.read(&mut self.buf[..to_read])?;
        self.pos = 0;
        self.len = n;
        Ok(n)
    }

    fn record_committed_range(&mut self, start: usize, end: usize) {
        let slice = &self.buf[start..end];
        if self.first_64k.len() < CHUNK_SIZE {
            let take = (CHUNK_SIZE - self.first_64k.len()).min(slice.len());
            self.first_64k.extend_from_slice(&slice[..take]);
        }
        self.file_pos += slice.len() as u64;
    }

    fn current_offset(&self) -> u64 {
        self.file_pos
    }

    fn at_limit(&self) -> bool {
        self.pos == self.len && self.file_pos >= self.end_limit
    }
}

struct LineSliceReader<'a> {
    src: &'a mut ChunkReader,
    saw_newline: bool,
    hit_limit: bool,
    saw_non_ws: bool,
}

impl<'a> LineSliceReader<'a> {
    fn new(src: &'a mut ChunkReader) -> Self {
        Self {
            src,
            saw_newline: false,
            hit_limit: false,
            saw_non_ws: false,
        }
    }

    fn skip_to_line_end(&mut self) -> io::Result<()> {
        while !self.saw_newline && !self.hit_limit {
            let avail = self.src.refill()?;
            if avail == 0 {
                self.hit_limit = true;
                break;
            }
            let start = self.src.pos;
            let end = self.src.len;
            let slice = &self.src.buf[start..end];
            if let Some(nl) = slice.iter().position(|&b| b == b'\n') {
                let take = nl + 1;
                if !self.saw_non_ws && slice[..nl].iter().any(|b| !b.is_ascii_whitespace()) {
                    self.saw_non_ws = true;
                }
                self.src.pos = start + take;
                self.src.record_committed_range(start, start + take);
                self.saw_newline = true;
            } else {
                if !self.saw_non_ws && slice.iter().any(|b| !b.is_ascii_whitespace()) {
                    self.saw_non_ws = true;
                }
                self.src.pos = end;
                self.src.record_committed_range(start, end);
            }
        }
        Ok(())
    }
}

impl<'a> Read for LineSliceReader<'a> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.saw_newline || self.hit_limit || out.is_empty() {
            return Ok(0);
        }
        let avail = self.src.refill()?;
        if avail == 0 {
            self.hit_limit = true;
            return Ok(0);
        }
        let start = self.src.pos;
        let end = self.src.len;
        let slice = &self.src.buf[start..end];
        let (take, found_nl) = match slice.iter().position(|&b| b == b'\n') {
            Some(nl) => ((nl + 1).min(out.len()), nl < out.len()),
            None => (avail.min(out.len()), false),
        };
        let chunk = &slice[..take];
        if !self.saw_non_ws {
            let check_end = if found_nl && take > 0 { take - 1 } else { take };
            if chunk[..check_end].iter().any(|b| !b.is_ascii_whitespace()) {
                self.saw_non_ws = true;
            }
        }
        out[..take].copy_from_slice(chunk);
        self.src.pos = start + take;
        self.src.record_committed_range(start, start + take);
        if found_nl {
            self.saw_newline = true;
        }
        Ok(take)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{:02x}", b);
    }
    hex
}

fn approx_row_json_bytes(row: &ScannedTranscriptRow) -> usize {
    128 + row.step_type.len()
        + row.source.as_ref().map_or(0, |s| s.len())
        + row.status.as_ref().map_or(0, |s| s.len())
        + row.created_at.as_ref().map_or(0, |s| s.len())
        + row.model.as_ref().map_or(0, |s| s.len())
        + row.tool_names.iter().map(|s| s.len() + 3).sum::<usize>()
}

pub fn scan_transcript_file(input: &ScanTranscriptInput) -> Result<ScanTranscriptOutput, String> {
    let mut file = File::open(&input.file_path)
        .map_err(|e| format!("failed to open transcript {}: {e}", input.file_path))?;
    let file_size = file
        .metadata()
        .map_err(|e| format!("failed to stat transcript {}: {e}", input.file_path))?
        .len();

    let start_offset = input.offset.unwrap_or(0).min(file_size);
    let end_limit = match input.max_bytes {
        Some(mb) => start_offset.saturating_add(mb).min(file_size),
        None => file_size,
    };

    let include_all = input.include_all_rows.unwrap_or(false);
    let max_rows_limit = input.max_rows;
    let tail_max_lines = input.max_lines.unwrap_or(DEFAULT_MAX_LINES);
    let tail_max_bytes = input.tail_bytes.unwrap_or(DEFAULT_TAIL_BYTES);

    let mut seen_indices: HashSet<u64> = input
        .known_indices
        .as_ref()
        .map(|v| v.iter().copied().collect())
        .unwrap_or_default();

    let mut reader = ChunkReader::new(file.try_clone().map_err(|e| e.to_string())?, start_offset, end_limit)
        .map_err(|e| format!("failed to seek transcript: {e}"))?;

    let mut committed_offset = start_offset;
    let mut eof = start_offset == file_size;
    let mut needs_chunked_fallback = false;
    let mut incomplete_trailing_line = false;
    let mut invalid = false;
    let mut limit = false;

    let mut total_lines = 0usize;
    let mut valid_lines = 0usize;
    let mut invalid_lines = 0usize;
    let mut user_tokens = 0u64;
    let mut assistant_tokens = 0u64;
    let mut tool_tokens = 0u64;
    let mut system_tokens = 0u64;
    let mut compaction_markers = 0usize;
    let mut image_steps = 0usize;
    let mut media_count = 0usize;
    let mut all_tool_names: BTreeSet<String> = BTreeSet::new();
    let mut all_models: BTreeSet<String> = BTreeSet::new();

    let mut all_rows: Vec<ScannedTranscriptRow> = Vec::new();
    let mut row_contribs: HashMap<u64, (u64, u64, u64, u64, usize, usize, usize)> = HashMap::new();
    let mut tail_rows: VecDeque<(ScannedTranscriptRow, usize)> = VecDeque::new();
    let mut tail_bytes_used = 0usize;

    while !reader.at_limit() {
        let avail = reader.refill().map_err(|e| format!("read error: {e}"))?;
        if avail == 0 {
            break;
        }
        let line_start_offset = reader.current_offset();
        let mut line_reader = LineSliceReader::new(&mut reader);
        let (parse_res, end_res) = {
            let mut buf_line = io::BufReader::with_capacity(8192, &mut line_reader);
            let mut de = serde_json::Deserializer::from_reader(&mut buf_line);
            let res = RecordSeed.deserialize(&mut de);
            let end_res = match &res {
                Ok(_) => de.end(),
                Err(_) => Ok(()),
            };
            (res, end_res)
        };
        let _ = line_reader.skip_to_line_end();

        let saw_newline = line_reader.saw_newline;
        let saw_non_ws = line_reader.saw_non_ws;
        let line_end_offset = reader.current_offset();

        if !saw_newline {
            if end_limit < file_size {
                // Incomplete line crossed the max_bytes pass boundary.
                if committed_offset == start_offset {
                    needs_chunked_fallback = true;
                }
                break;
            }
            // Reached physical EOF without trailing '\n'.
            if saw_non_ws {
                // Leave committed_offset at line_start_offset so streaming readers
                // can resume cleanly from the partial line once more bytes arrive.
                incomplete_trailing_line = true;
                eof = false;
                match parse_res {
                    Err(ref e) if !e.is_eof() => {
                        invalid = true;
                        invalid_lines += 1;
                    }
                    Ok(_) => {
                        if let Err(ref e) = end_res {
                            if !e.is_eof() {
                                invalid = true;
                                invalid_lines += 1;
                            }
                        }
                    }
                    Err(_) => {}
                }
            } else {
                committed_offset = line_end_offset;
                eof = true;
            }
            break;
        }

        if !saw_non_ws {
            committed_offset = line_end_offset;
            if committed_offset == file_size {
                eof = true;
            }
            continue;
        }

        total_lines += 1;
        let maybe_row = match (parse_res, end_res) {
            (Ok(Some(rec)), Ok(())) => summarize_record(rec),
            _ => None,
        };

        let Some(row) = maybe_row else {
            invalid = true;
            invalid_lines += 1;
            committed_offset = line_end_offset;
            if committed_offset == file_size {
                eof = true;
            }
            continue;
        };

        if let Some(max_r) = max_rows_limit {
            if !seen_indices.contains(&row.index) && seen_indices.len() >= max_r {
                limit = true;
                committed_offset = line_start_offset;
                eof = false;
                break;
            }
            seen_indices.insert(row.index);
        }

        if let Some(prev) = row_contribs.insert(
            row.index,
            (
                row.user_tokens,
                row.assistant_tokens,
                row.tool_tokens,
                row.system_tokens,
                usize::from(row.compaction),
                usize::from(row.image),
                row.media_count,
            ),
        ) {
            user_tokens = user_tokens.saturating_sub(prev.0);
            assistant_tokens = assistant_tokens.saturating_sub(prev.1);
            tool_tokens = tool_tokens.saturating_sub(prev.2);
            system_tokens = system_tokens.saturating_sub(prev.3);
            compaction_markers = compaction_markers.saturating_sub(prev.4);
            image_steps = image_steps.saturating_sub(prev.5);
            media_count = media_count.saturating_sub(prev.6);
        } else {
            valid_lines += 1;
        }
        user_tokens = user_tokens.saturating_add(row.user_tokens);
        assistant_tokens = assistant_tokens.saturating_add(row.assistant_tokens);
        tool_tokens = tool_tokens.saturating_add(row.tool_tokens);
        system_tokens = system_tokens.saturating_add(row.system_tokens);
        compaction_markers += usize::from(row.compaction);
        image_steps += usize::from(row.image);
        media_count += row.media_count;
        for name in &row.tool_names {
            all_tool_names.insert(name.clone());
        }
        if let Some(ref m) = row.model {
            all_models.insert(m.clone());
        }

        if include_all {
            all_rows.push(row);
        } else if tail_max_lines > 0 && tail_max_bytes > 0 {
            let est_bytes = approx_row_json_bytes(&row);
            tail_rows.push_back((row, est_bytes));
            tail_bytes_used += est_bytes;
            while tail_rows.len() > tail_max_lines
                || (tail_rows.len() > 1 && tail_bytes_used > tail_max_bytes)
            {
                if let Some((_, dropped_bytes)) = tail_rows.pop_front() {
                    tail_bytes_used = tail_bytes_used.saturating_sub(dropped_bytes);
                }
            }
        }

        committed_offset = line_end_offset;
        if committed_offset == file_size {
            eof = true;
        }
    }

    if committed_offset == file_size && !limit {
        eof = true;
    }

    let mut anchors = Vec::new();
    let bytes_scanned = committed_offset.saturating_sub(start_offset);
    if bytes_scanned > 0 {
        let first_len = (bytes_scanned as usize).min(CHUNK_SIZE);
        if reader.first_64k.len() >= first_len {
            anchors.push(ScanAnchor {
                offset: start_offset,
                length: first_len,
                hash: sha256_hex(&reader.first_64k[..first_len]),
            });
        }
        if bytes_scanned > CHUNK_SIZE as u64 {
            let tail_len = ((bytes_scanned - CHUNK_SIZE as u64) as usize).min(CHUNK_SIZE);
            let tail_off = committed_offset - tail_len as u64;
            let mut tail_buf = vec![0u8; tail_len];
            file.seek(SeekFrom::Start(tail_off))
                .map_err(|e| format!("anchor seek error: {e}"))?;
            file.read_exact(&mut tail_buf)
                .map_err(|e| format!("anchor read error: {e}"))?;
            anchors.push(ScanAnchor {
                offset: tail_off,
                length: tail_len,
                hash: sha256_hex(&tail_buf),
            });
        }
    }

    let rows = if include_all {
        all_rows
    } else {
        tail_rows.into_iter().map(|(r, _)| r).collect()
    };

    let total_tokens = user_tokens
        .saturating_add(assistant_tokens)
        .saturating_add(tool_tokens)
        .saturating_add(system_tokens);

    Ok(ScanTranscriptOutput {
        version: 1,
        file_size,
        offset: start_offset,
        bytes_scanned,
        next_offset: committed_offset,
        eof,
        needs_chunked_fallback,
        incomplete_trailing_line,
        invalid,
        limit,
        total_lines,
        valid_lines,
        invalid_lines,
        user_tokens,
        assistant_tokens,
        tool_tokens,
        system_tokens,
        total_tokens,
        compaction_markers,
        image_steps,
        media_count,
        tool_names: all_tool_names.into_iter().collect(),
        models: all_models.into_iter().collect(),
        anchors,
        rows,
    })
}

/// Scans a local `transcript*.jsonl` file directly in Rust with 64 KiB buffered streaming,
/// returning a compact summary and projected rows without buffering bulky payloads in JS.
pub fn scan_transcript_file_json(input_json: &str) -> Result<String, String> {
    let input: ScanTranscriptInput =
        serde_json::from_str(input_json).map_err(|e| format!("invalid scan input: {e}"))?;
    if input.file_path.is_empty() {
        return Err("missing filePath".to_string());
    }
    let out = scan_transcript_file(&input)?;
    serde_json::to_string(&out).map_err(|e| format!("failed to serialize scan result: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pulse_transcript_{tag}_{nanos}.jsonl"))
    }

    #[test]
    fn scans_transcript_jsonl_with_malformed_trailing_line_and_empty_file() {
        let empty_path = temp_path("empty");
        File::create(&empty_path).unwrap();
        let empty_res = scan_transcript_file_json(
            &serde_json::json!({ "filePath": empty_path.to_string_lossy() }).to_string(),
        )
        .unwrap();
        let empty_val: serde_json::Value = serde_json::from_str(&empty_res).unwrap();
        assert_eq!(empty_val["eof"], true);
        assert_eq!(empty_val["totalLines"], 0);
        assert_eq!(empty_val["totalTokens"], 0);
        let _ = std::fs::remove_file(&empty_path);

        let path = temp_path("mixed");
        {
            let mut f = File::create(&path).unwrap();
            writeln!(
                f,
                r#"{{"step_index":0,"type":"CORTEX_STEP_TYPE_USER_INPUT","source":"USER_EXPLICIT","status":"DONE","created_at":"2026-10-14T00:00:00.000Z","content":"你好","media":["a","b"]}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-10-14T00:00:01.000Z","content":"abcd","thinking":"abcdefgh","model":"gemini-3.5-pro","tool_calls":[{{"name":"read_file","arguments":"HUGE_PRIVATE_ARGS"}}]}}"#
            )
            .unwrap();
            writeln!(
                f,
                r##"{{"step_index":2,"type":"CHECKPOINT","created_at":"2026-10-14T00:00:02.000Z","content":"# Resuming from a compaction\nsummary"}}"##
            )
            .unwrap();
            // Trailing partial line without newline
            write!(f, r#"{{"step_index":3,"type":"GENERIC""#).unwrap();
        }

        let res_str = scan_transcript_file_json(
            &serde_json::json!({
                "filePath": path.to_string_lossy(),
                "includeAllRows": true
            })
            .to_string(),
        )
        .unwrap();
        assert!(!res_str.contains("HUGE_PRIVATE_ARGS"));

        let val: serde_json::Value = serde_json::from_str(&res_str).unwrap();
        assert_eq!(val["eof"], false);
        assert_eq!(val["incompleteTrailingLine"], true);
        assert_eq!(val["invalid"], false);
        assert_eq!(val["validLines"], 3);
        assert_eq!(val["userTokens"], 2);
        assert_eq!(val["assistantTokens"], 3);
        assert_eq!(val["compactionMarkers"], 1);
        assert_eq!(val["mediaCount"], 2);
        assert_eq!(val["toolNames"], serde_json::json!(["read_file"]));
        assert_eq!(val["models"], serde_json::json!(["gemini-3.5-pro"]));
        assert_eq!(val["rows"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn signals_chunked_fallback_when_single_line_exceeds_max_bytes() {
        let path = temp_path("bigline");
        {
            let mut f = File::create(&path).unwrap();
            write!(f, r#"{{"step_index":0,"type":"USER_INPUT","content":""#).unwrap();
            let block = "x".repeat(100_000);
            write!(f, "{block}").unwrap();
            writeln!(f, r#""}}"#).unwrap();
        }
        let res_str = scan_transcript_file_json(
            &serde_json::json!({
                "filePath": path.to_string_lossy(),
                "offset": 0,
                "maxBytes": 65536,
                "includeAllRows": true
            })
            .to_string(),
        )
        .unwrap();
        let val: serde_json::Value = serde_json::from_str(&res_str).unwrap();
        assert_eq!(val["needsChunkedFallback"], true);
        assert_eq!(val["nextOffset"], 0);
        assert_eq!(val["eof"], false);
        let _ = std::fs::remove_file(&path);
    }
}
