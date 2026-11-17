use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::enums::{
    agent_mode_to_str, api_provider_to_str, model_enum_to_str, model_tier_to_str,
    step_status_to_str, step_type_to_str,
};
use crate::proto_wire::{
    parse_duration_string, parse_timestamp_iso, read_len_delimited, read_packed_u32,
    read_string_lossy, read_tag, read_varint, read_varint_i32, read_varint_i64, skip_field,
    MAX_PROTO_DEPTH, WIRE_LEN, WIRE_VARINT,
};

const MAX_SAFE_INT: u64 = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

#[derive(Debug, Clone, Default)]
pub struct DecodedModelUsage {
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub api_provider: Option<String>,
    pub message_id: Option<String>,
    pub thinking_output_tokens: Option<u64>,
    pub response_output_tokens: Option<u64>,
    pub response_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedSubagentSpec {
    pub conversation_id: Option<String>,
    pub type_name: Option<String>,
    pub role: Option<String>,
    pub inherit: Option<bool>,
    pub model: Option<String>,
    pub model_tier: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedTrajectoryMeta {
    pub created_at: Option<String>,
    pub parent_conversation_id: Option<String>,
    pub root_conversation_id: Option<String>,
    pub subagent_spec: Option<DecodedSubagentSpec>,
    pub nesting_depth: Option<i32>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedContextWindow {
    pub estimated_tokens_used: Option<i64>,
    pub max_context_tokens: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedChatStartMeta {
    pub created_at: Option<String>,
    pub context_window_metadata: Option<DecodedContextWindow>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedChatModel {
    pub model: Option<String>,
    pub usage: Option<DecodedModelUsage>,
    pub chat_start_metadata: Option<DecodedChatStartMeta>,
    pub time_to_first_token: Option<String>,
    pub streaming_duration: Option<String>,
    pub retry_usages: Vec<DecodedModelUsage>,
    pub response_model: Option<String>,
    pub custom_model_enum: Option<String>,
    pub model_display_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedPlannerConfig {
    pub plan_model: Option<String>,
    pub model_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedGeneratorMeta {
    pub idx: i64,
    pub chat_model: Option<DecodedChatModel>,
    pub step_indices: Vec<u32>,
    pub planner_config: Option<DecodedPlannerConfig>,
    pub execution_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedModelInfo {
    pub max_tokens: Option<i32>,
    pub model_name: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedStepMeta {
    pub created_at: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_call_name: Option<String>,
    pub has_tool_call: bool,
    pub viewable_at: Option<String>,
    pub finished_generating_at: Option<String>,
    pub completed_at: Option<String>,
    pub model_usage: Option<DecodedModelUsage>,
    pub generator_model: Option<String>,
    pub execution_id: Option<String>,
    pub requested_model: Option<String>,
    pub source_step_index: Option<u32>,
    pub tool_call_output_tokens: Option<i32>,
    pub model_info: Option<DecodedModelInfo>,
    pub started_at: Option<String>,
    pub model_api_content_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedInvokeSubagent {
    pub conversation_id: Option<String>,
    pub subagents: Vec<DecodedSubagentSpec>,
    pub result_conversation_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodedStepPayload {
    pub user_input_plan_model: Option<String>,
    pub planner_response_nonempty: Option<bool>,
    pub planner_tool_call_names: Vec<String>,
    pub task_boundary_mode: Option<String>,
    pub system_message_event_type: Option<String>,
    pub invoke_subagent: Option<DecodedInvokeSubagent>,
    pub send_message_recipient: Option<String>,
    pub exit_plan_mode: bool,
    pub enter_plan_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageRecord {
    pub id: String,
    pub at: Option<i64>,
    pub model: String,
    pub uncached: Option<i64>,
    #[serde(rename = "cacheRead")]
    pub cache_read: Option<i64>,
    #[serde(rename = "cacheWrite")]
    pub cache_write: Option<i64>,
    pub output: Option<i64>,
    pub partial: bool,
    #[serde(rename = "timeBasis")]
    pub time_basis: &'static str,
}

fn read_model_field(buf: &[u8], pos: &mut usize, wire_type: u8) -> Option<String> {
    match wire_type {
        WIRE_VARINT => {
            let v = read_varint_i32(buf, pos)?;
            model_enum_to_str(v)
        }
        WIRE_LEN => {
            let s = read_string_lossy(buf, pos)?;
            if s.trim().is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => {
            skip_field(buf, pos, wire_type);
            None
        }
    }
}

pub fn decode_model_usage(buf: &[u8]) -> DecodedModelUsage {
    let mut out = DecodedModelUsage::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, wt) => {
                if let Some(m) = read_model_field(buf, &mut pos, wt) {
                    out.model = Some(m);
                }
            }
            (2, WIRE_VARINT) => {
                out.input_tokens = read_varint(buf, &mut pos);
            }
            (3, WIRE_VARINT) => {
                out.output_tokens = read_varint(buf, &mut pos);
            }
            (4, WIRE_VARINT) => {
                out.cache_write_tokens = read_varint(buf, &mut pos);
            }
            (5, WIRE_VARINT) => {
                out.cache_read_tokens = read_varint(buf, &mut pos);
            }
            (6, WIRE_VARINT) => {
                if let Some(v) = read_varint_i32(buf, &mut pos) {
                    if v != 0 {
                        out.api_provider = Some(api_provider_to_str(v));
                    }
                }
            }
            (6, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.api_provider = Some(s);
                    }
                }
            }
            (7, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.message_id = Some(s);
                    }
                }
            }
            (9, WIRE_VARINT) => {
                out.thinking_output_tokens = read_varint(buf, &mut pos);
            }
            (10, WIRE_VARINT) => {
                out.response_output_tokens = read_varint(buf, &mut pos);
            }
            (11, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.response_id = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

pub fn decode_subagent_spec(buf: &[u8]) -> DecodedSubagentSpec {
    let mut out = DecodedSubagentSpec::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.type_name = Some(s);
                    }
                }
            }
            (2, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.role = Some(s);
                    }
                }
            }
            (4, WIRE_VARINT) => {
                if let Some(v) = read_varint(buf, &mut pos) {
                    out.inherit = Some(v != 0);
                }
            }
            (7, wt) => {
                if let Some(m) = read_model_field(buf, &mut pos, wt) {
                    out.model = Some(m);
                }
            }
            (8, WIRE_VARINT) => {
                if let Some(v) = read_varint_i32(buf, &mut pos) {
                    if let Some(t) = model_tier_to_str(v) {
                        out.model_tier = Some(t.to_string());
                    }
                }
            }
            (8, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.model_tier = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

pub fn decode_trajectory_metadata(buf: &[u8]) -> DecodedTrajectoryMeta {
    let mut out = DecodedTrajectoryMeta::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (2, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.created_at = parse_timestamp_iso(sub);
                }
            }
            (5, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.parent_conversation_id = Some(s);
                    }
                }
            }
            (6, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.root_conversation_id = Some(s);
                    }
                }
            }
            (8, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let spec = decode_subagent_spec(sub);
                    if spec.type_name.is_some()
                        || spec.role.is_some()
                        || spec.inherit.is_some()
                        || spec.model.is_some()
                        || spec.model_tier.is_some()
                    {
                        out.subagent_spec = Some(spec);
                    }
                }
            }
            (17, WIRE_VARINT) => {
                out.nesting_depth = read_varint_i32(buf, &mut pos);
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

fn decode_context_window(buf: &[u8]) -> DecodedContextWindow {
    let mut out = DecodedContextWindow::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_VARINT) => {
                out.estimated_tokens_used = read_varint_i64(buf, &mut pos);
            }
            (4, WIRE_VARINT) => {
                out.max_context_tokens = read_varint_i64(buf, &mut pos);
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

fn decode_chat_start_metadata(buf: &[u8]) -> DecodedChatStartMeta {
    let mut out = DecodedChatStartMeta::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (4, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.created_at = parse_timestamp_iso(sub);
                }
            }
            (10, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let cw = decode_context_window(sub);
                    if cw.estimated_tokens_used.is_some() || cw.max_context_tokens.is_some() {
                        out.context_window_metadata = Some(cw);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

fn decode_retry_info_usage(buf: &[u8]) -> Option<DecodedModelUsage> {
    let mut pos = 0;
    let mut usage = None;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (2, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    usage = Some(decode_model_usage(sub));
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    usage
}

fn decode_string_map_entry(buf: &[u8]) -> (Option<String>, Option<String>) {
    let mut pos = 0;
    let mut key = None;
    let mut val = None;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_LEN) => {
                key = read_string_lossy(buf, &mut pos);
            }
            (2, WIRE_LEN) => {
                val = read_string_lossy(buf, &mut pos);
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    (key, val)
}

pub fn decode_chat_model(buf: &[u8]) -> DecodedChatModel {
    let mut out = DecodedChatModel::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (3, wt) => {
                if let Some(m) = read_model_field(buf, &mut pos, wt) {
                    out.model = Some(m);
                }
            }
            (4, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.usage = Some(decode_model_usage(sub));
                }
            }
            (9, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.chat_start_metadata = Some(decode_chat_start_metadata(sub));
                }
            }
            (11, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.time_to_first_token = parse_duration_string(sub);
                }
            }
            (12, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.streaming_duration = parse_duration_string(sub);
                }
            }
            (17, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    if let Some(u) = decode_retry_info_usage(sub) {
                        out.retry_usages.push(u);
                    }
                }
            }
            (19, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.response_model = Some(s);
                    }
                }
            }
            (20, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let (k, v) = decode_string_map_entry(sub);
                    if k.as_deref() == Some("model_enum") {
                        if let Some(val) = v {
                            if !val.is_empty() {
                                out.custom_model_enum = Some(val);
                            }
                        }
                    }
                }
            }
            (21, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.model_display_name = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }

    if let Some(ref custom_enum) = out.custom_model_enum {
        let model_unresolved = out
            .model
            .as_deref()
            .map(|m| m.is_empty() || m.starts_with("MODEL_ENUM_"))
            .unwrap_or(true);
        if model_unresolved {
            out.model = Some(custom_enum.clone());
        }
        if let Some(ref mut u) = out.usage {
            let usage_unresolved = u
                .model
                .as_deref()
                .map(|m| m.is_empty() || m.starts_with("MODEL_ENUM_"))
                .unwrap_or(true);
            if usage_unresolved {
                u.model = Some(custom_enum.clone());
            }
        }
    }
    out
}

pub fn decode_planner_config(buf: &[u8]) -> DecodedPlannerConfig {
    let mut out = DecodedPlannerConfig::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, wt) => {
                if let Some(m) = read_model_field(buf, &mut pos, wt) {
                    out.plan_model = Some(m);
                }
            }
            (28, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.model_name = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

pub fn decode_generator_metadata(idx: i64, buf: &[u8]) -> DecodedGeneratorMeta {
    let mut out = DecodedGeneratorMeta {
        idx,
        ..Default::default()
    };
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.chat_model = Some(decode_chat_model(sub));
                }
            }
            (2, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    read_packed_u32(sub, &mut out.step_indices);
                }
            }
            (2, WIRE_VARINT) => {
                if let Some(v) = read_varint(buf, &mut pos) {
                    out.step_indices.push(v as u32);
                }
            }
            (3, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.planner_config = Some(decode_planner_config(sub));
                }
            }
            (4, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.execution_id = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

fn decode_chat_tool_call(buf: &[u8]) -> (Option<String>, Option<String>) {
    let mut pos = 0;
    let mut id = None;
    let mut name = None;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        id = Some(s);
                    }
                }
            }
            (2, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        name = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    (id, name)
}

fn decode_model_info(buf: &[u8]) -> DecodedModelInfo {
    let mut out = DecodedModelInfo::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (4, WIRE_VARINT) => {
                out.max_tokens = read_varint_i32(buf, &mut pos);
            }
            (8, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.model_name = Some(s);
                    }
                }
            }
            (20, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.display_name = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

pub fn decode_step_metadata(buf: &[u8]) -> DecodedStepMeta {
    let mut out = DecodedStepMeta::default();
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.created_at = parse_timestamp_iso(sub);
                }
            }
            (4, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.has_tool_call = true;
                    let (id, name) = decode_chat_tool_call(sub);
                    if id.is_some() {
                        out.tool_call_id = id;
                    }
                    if name.is_some() {
                        out.tool_call_name = name;
                    }
                }
            }
            (6, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.viewable_at = parse_timestamp_iso(sub);
                }
            }
            (7, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.finished_generating_at = parse_timestamp_iso(sub);
                }
            }
            (8, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.completed_at = parse_timestamp_iso(sub);
                }
            }
            (9, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.model_usage = Some(decode_model_usage(sub));
                }
            }
            (11, wt) => {
                if let Some(m) = read_model_field(buf, &mut pos, wt) {
                    out.generator_model = Some(m);
                }
            }
            (12, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.execution_id = Some(s);
                    }
                }
            }
            (13, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let mut sp = 0;
                    while let Some((f, wt)) = read_tag(sub, &mut sp) {
                        if f == 1 {
                            if let Some(m) = read_model_field(sub, &mut sp, wt) {
                                out.requested_model = Some(m);
                            }
                        } else if !skip_field(sub, &mut sp, wt) {
                            break;
                        }
                    }
                }
            }
            (20, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let mut sp = 0;
                    while let Some((f, wt)) = read_tag(sub, &mut sp) {
                        if f == 2 && wt == WIRE_VARINT {
                            if let Some(v) = read_varint(sub, &mut sp) {
                                out.source_step_index = Some(v as u32);
                            }
                        } else if !skip_field(sub, &mut sp, wt) {
                            break;
                        }
                    }
                }
            }
            (23, WIRE_VARINT) => {
                out.tool_call_output_tokens = read_varint_i32(buf, &mut pos);
            }
            (24, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.model_info = Some(decode_model_info(sub));
                }
            }
            (32, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    out.started_at = parse_timestamp_iso(sub);
                }
            }
            (35, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        out.model_api_content_id = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    out
}

fn decode_user_input_inner(buf: &[u8], depth: usize) -> Option<String> {
    if depth >= MAX_PROTO_DEPTH {
        return None;
    }
    let mut pos = 0;
    let mut found = None;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (19, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    if let Some(pm) = decode_user_input_inner(sub, depth + 1) {
                        found = Some(pm);
                    }
                }
            }
            (12, WIRE_LEN) => {
                if let Some(user_cfg) = read_len_delimited(buf, &mut pos) {
                    let mut upos = 0;
                    while let Some((uf, uwt)) = read_tag(user_cfg, &mut upos) {
                        if uf == 1 && uwt == WIRE_LEN {
                            if let Some(pc_buf) = read_len_delimited(user_cfg, &mut upos) {
                                let pc = decode_planner_config(pc_buf);
                                if let Some(m) = pc.plan_model.or(pc.model_name) {
                                    found = Some(m);
                                }
                            }
                        } else if !skip_field(user_cfg, &mut upos, uwt) {
                            break;
                        }
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    found
}

fn decode_planner_response_inner(buf: &[u8], out: &mut DecodedStepPayload, depth: usize) {
    if depth >= MAX_PROTO_DEPTH {
        return;
    }
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (20, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    decode_planner_response_inner(sub, out, depth + 1);
                }
            }
            (1, WIRE_LEN) => {
                if let Some(bytes) = read_len_delimited(buf, &mut pos) {
                    let has_non_ws = bytes.iter().any(|b| !b.is_ascii_whitespace());
                    out.planner_response_nonempty =
                        Some(out.planner_response_nonempty.unwrap_or(false) || has_non_ws);
                }
            }
            (7, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let (_id, name) = decode_chat_tool_call(sub);
                    if let Some(n) = name {
                        out.planner_tool_call_names.push(n);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
}

fn decode_task_boundary_inner(buf: &[u8], depth: usize) -> Option<String> {
    if depth >= MAX_PROTO_DEPTH {
        return None;
    }
    let mut pos = 0;
    let mut mode = None;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (93, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    if let Some(m) = decode_task_boundary_inner(sub, depth + 1) {
                        mode = Some(m);
                    }
                }
            }
            (5, WIRE_VARINT) => {
                if let Some(v) = read_varint_i32(buf, &mut pos) {
                    if let Some(m) = agent_mode_to_str(v) {
                        mode = Some(m.to_string());
                    }
                }
            }
            (5, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.trim().is_empty() {
                        mode = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    mode
}

fn decode_system_message_inner(buf: &[u8], depth: usize) -> Option<String> {
    if depth >= MAX_PROTO_DEPTH {
        return None;
    }
    let mut pos = 0;
    let mut event_type = None;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (114, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    if let Some(e) = decode_system_message_inner(sub, depth + 1) {
                        event_type = Some(e);
                    }
                }
            }
            (3, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.trim().is_empty() {
                        event_type = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    event_type
}

fn decode_subagent_result_cid(buf: &[u8]) -> Option<String> {
    let mut pos = 0;
    let mut cid = None;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        cid = Some(s);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
    cid
}

fn decode_invoke_subagent_inner(buf: &[u8], inv: &mut DecodedInvokeSubagent, depth: usize) {
    if depth >= MAX_PROTO_DEPTH {
        return;
    }
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (143, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    decode_invoke_subagent_inner(sub, inv, depth + 1);
                }
            }
            (5, WIRE_LEN) => {
                if let Some(s) = read_string_lossy(buf, &mut pos) {
                    if !s.is_empty() {
                        inv.conversation_id = Some(s);
                    }
                }
            }
            (1, WIRE_LEN) | (9, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let spec = decode_subagent_spec(sub);
                    if spec.type_name.is_some()
                        || spec.role.is_some()
                        || spec.inherit.is_some()
                        || spec.model.is_some()
                        || spec.model_tier.is_some()
                    {
                        inv.subagents.push(spec);
                    }
                }
            }
            (2, WIRE_LEN) | (10, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    if let Some(cid) = decode_subagent_result_cid(sub) {
                        inv.result_conversation_ids.push(cid);
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
}

fn decode_generic_step_inner(
    buf: &[u8],
    args: &mut HashMap<String, String>,
    any_values: &mut Vec<Vec<u8>>,
    collect_any: bool,
    depth: usize,
) {
    if depth >= MAX_PROTO_DEPTH {
        return;
    }
    let mut pos = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (140, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    decode_generic_step_inner(sub, args, any_values, collect_any, depth + 1);
                }
            }
            (1, WIRE_LEN) => {
                if let Some(sub) = read_len_delimited(buf, &mut pos) {
                    let (k, v) = decode_string_map_entry(sub);
                    if let (Some(key), Some(val)) = (k, v) {
                        args.insert(key, val);
                    }
                }
            }
            (2, WIRE_LEN) if collect_any => {
                if let Some(res_buf) = read_len_delimited(buf, &mut pos) {
                    let mut rpos = 0;
                    while let Some((rf, rwt)) = read_tag(res_buf, &mut rpos) {
                        if rf == 6 && rwt == WIRE_LEN {
                            if let Some(any_buf) = read_len_delimited(res_buf, &mut rpos) {
                                let mut apos = 0;
                                while let Some((af, awt)) = read_tag(any_buf, &mut apos) {
                                    if af == 2 && awt == WIRE_LEN {
                                        if let Some(val_bytes) =
                                            read_len_delimited(any_buf, &mut apos)
                                        {
                                            any_values.push(val_bytes.to_vec());
                                        }
                                    } else if !skip_field(any_buf, &mut apos, awt) {
                                        break;
                                    }
                                }
                            }
                        } else if !skip_field(res_buf, &mut rpos, rwt) {
                            break;
                        }
                    }
                }
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    break;
                }
            }
        }
    }
}

pub fn decode_step_payload(
    step_type: i32,
    tool_call_name: Option<&str>,
    buf: &[u8],
) -> DecodedStepPayload {
    let mut out = DecodedStepPayload::default();
    match step_type {
        14 => {
            out.user_input_plan_model = decode_user_input_inner(buf, 0);
        }
        15 => {
            out.planner_response_nonempty = Some(false);
            decode_planner_response_inner(buf, &mut out, 0);
        }
        81 => {
            out.task_boundary_mode = decode_task_boundary_inner(buf, 0);
        }
        101 => {
            out.system_message_event_type = decode_system_message_inner(buf, 0);
        }
        127 => {
            let mut inv = DecodedInvokeSubagent::default();
            decode_invoke_subagent_inner(buf, &mut inv, 0);
            if inv.conversation_id.is_none() && inv.result_conversation_ids.len() == 1 {
                inv.conversation_id = Some(inv.result_conversation_ids[0].clone());
            }
            out.invoke_subagent = Some(inv);
        }
        132 => {
            let mut args = HashMap::new();
            let mut any_values = Vec::new();
            let collect_any = matches!(tool_call_name, Some("invoke_subagent") | Some("send_message"));
            decode_generic_step_inner(buf, &mut args, &mut any_values, collect_any, 0);
            match tool_call_name {
                Some("invoke_subagent") => {
                    let mut inv = DecodedInvokeSubagent::default();
                    for av in &any_values {
                        decode_invoke_subagent_inner(av, &mut inv, 0);
                    }
                    let arg_cid = args
                        .get("ConversationId")
                        .or_else(|| args.get("conversationId"))
                        .or_else(|| args.get("conversation_id"))
                        .cloned();
                    let arg_role = args.get("Role").or_else(|| args.get("role")).cloned();
                    let arg_type = args
                        .get("TypeName")
                        .or_else(|| args.get("typeName"))
                        .or_else(|| args.get("type_name"))
                        .cloned();
                    if inv.conversation_id.is_none() {
                        inv.conversation_id = arg_cid.clone();
                    }
                    if inv.conversation_id.is_none() && inv.result_conversation_ids.len() == 1 {
                        inv.conversation_id = Some(inv.result_conversation_ids[0].clone());
                    }
                    if inv.subagents.is_empty()
                        && (arg_role.is_some() || arg_type.is_some() || arg_cid.is_some())
                    {
                        inv.subagents.push(DecodedSubagentSpec {
                            conversation_id: arg_cid,
                            type_name: arg_type,
                            role: arg_role,
                            ..Default::default()
                        });
                    } else if inv.subagents.len() == 1 && inv.result_conversation_ids.len() == 1 {
                        if inv.subagents[0].conversation_id.is_none() {
                            inv.subagents[0].conversation_id =
                                Some(inv.result_conversation_ids[0].clone());
                        }
                    }
                    out.invoke_subagent = Some(inv);
                }
                Some("send_message") => {
                    let mut recipient = args
                        .get("Recipient")
                        .or_else(|| args.get("recipient"))
                        .or_else(|| args.get("conversationId"))
                        .or_else(|| args.get("ConversationId"))
                        .cloned();
                    if recipient.is_none() {
                        for av in &any_values {
                            if let Some(cid) = decode_subagent_result_cid(av) {
                                recipient = Some(cid);
                                break;
                            }
                        }
                    }
                    out.send_message_recipient = recipient;
                }
                Some("task_boundary") => {
                    out.task_boundary_mode = args
                        .get("Mode")
                        .or_else(|| args.get("mode"))
                        .cloned()
                        .filter(|s| !s.trim().is_empty());
                }
                Some("exit_plan_mode") => {
                    out.exit_plan_mode = true;
                }
                Some("enter_plan_mode") => {
                    out.enter_plan_mode = true;
                }
                _ => {}
            }
        }
        _ => {}
    }
    out
}

fn open_readonly_db(db_path: &str) -> Option<Connection> {
    let p = Path::new(db_path);
    if !p.is_file() {
        return None;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(p, flags).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(500));
    Some(conn)
}

pub fn parse_iso_to_epoch_ns(iso: &str) -> Option<i128> {
    let bytes = iso.as_bytes();
    if bytes.len() < 20
        || &bytes[0..2] != b"20"
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: u32 = iso.get(5..7)?.parse().ok()?;
    let day: u32 = iso.get(8..10)?.parse().ok()?;
    let hour: u32 = iso.get(11..13)?.parse().ok()?;
    let minute: u32 = iso.get(14..16)?.parse().ok()?;
    let second: u32 = iso.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let mut nanos_sub: i128 = 0;
    if bytes[19] == b'.' {
        let rest = &bytes[20..];
        let mut digits = 0u32;
        for &b in rest {
            if b.is_ascii_digit() {
                if digits < 9 {
                    nanos_sub = nanos_sub * 10 + (b - b'0') as i128;
                    digits += 1;
                }
            } else {
                break;
            }
        }
        while digits > 0 && digits < 9 {
            nanos_sub *= 10;
            digits += 1;
        }
    }

    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + (doe as i64) - 719468;
    let total_secs = days * 86400 + (hour * 3600 + minute * 60 + second) as i64;
    let epoch_ns = (total_secs as i128) * 1_000_000_000 + nanos_sub;
    if epoch_ns >= 0 {
        Some(epoch_ns)
    } else {
        None
    }
}

pub fn parse_iso_to_epoch_ms(iso: &str) -> Option<i64> {
    parse_iso_to_epoch_ns(iso).map(|ns| (ns / 1_000_000) as i64)
}

fn format_duration_ns(ns: i128) -> String {
    let whole = ns / 1_000_000_000;
    let sub = (ns % 1_000_000_000) as u32;
    if sub == 0 {
        format!("{}s", whole)
    } else {
        let frac = format!("{:09}", sub);
        let trimmed = frac.trim_end_matches('0');
        format!("{}.{}s", whole, trimmed)
    }
}

fn iso_diff_duration(start_iso: Option<&str>, end_iso: Option<&str>) -> Option<(i128, String)> {
    let a = parse_iso_to_epoch_ns(start_iso?)?;
    let b = parse_iso_to_epoch_ns(end_iso?)?;
    let diff = b - a;
    if diff >= 0 {
        Some((diff, format_duration_ns(diff)))
    } else {
        None
    }
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}

fn clean_model_name(candidates: &[Option<&str>]) -> String {
    let raw = candidates
        .iter()
        .flatten()
        .copied()
        .find(|s| !s.is_empty())
        .unwrap_or("Unknown");
    let cleaned: String = raw
        .chars()
        .filter(|&c| (c as u32) > 0x1F && (c as u32) != 0x7F)
        .take(120)
        .collect();
    if cleaned.is_empty() {
        "Unknown".to_string()
    } else {
        cleaned
    }
}

fn normalize_guid(val: &str) -> Option<String> {
    let b = val.as_bytes();
    if b.len() != 36 {
        return None;
    }
    for (i, &ch) in b.iter().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            if ch != b'-' {
                return None;
            }
        } else if !ch.is_ascii_hexdigit() {
            return None;
        }
    }
    Some(val.to_ascii_lowercase())
}

fn infer_api_provider(
    explicit: Option<&str>,
    step_meta: &DecodedStepMeta,
    raw_model_name: &str,
) -> Option<String> {
    if let Some(p) = explicit {
        if !p.is_empty() {
            return Some(p.to_string());
        }
    }
    let mut hint = String::new();
    for part in [
        step_meta.generator_model.as_deref(),
        step_meta.requested_model.as_deref(),
        step_meta
            .model_info
            .as_ref()
            .and_then(|m| m.model_name.as_deref()),
        step_meta
            .model_info
            .as_ref()
            .and_then(|m| m.display_name.as_deref()),
        Some(raw_model_name),
    ]
    .into_iter()
    .flatten()
    {
        hint.push_str(part);
        hint.push(' ');
    }
    let upper = hint.to_ascii_uppercase();
    if upper.contains("GEMINI") || upper.contains("GOOGLE") {
        Some("API_PROVIDER_GOOGLE_GEMINI".to_string())
    } else if upper.contains("ANTHROPIC") || upper.contains("CLAUDE") {
        Some("API_PROVIDER_ANTHROPIC".to_string())
    } else if upper.contains("OPENAI") || upper.contains("GPT") {
        Some("API_PROVIDER_OPENAI".to_string())
    } else {
        None
    }
}

fn is_valid_cache_provider(provider: Option<&str>) -> bool {
    let Some(p) = provider else {
        return false;
    };
    let core = p.strip_prefix("API_PROVIDER_").unwrap_or(p);
    matches!(
        core,
        "GOOGLE_GEMINI"
            | "GOOGLE_VERTEX"
            | "GOOGLE_EVERGREEN"
            | "OPENAI"
            | "OPENAI_VERTEX"
            | "OPENAI_RESPONSES_VERTEX"
            | "ANTHROPIC"
            | "ANTHROPIC_VERTEX"
            | "INTERNAL"
    )
}

fn read_trajectory_meta_row(conn: &Connection) -> rusqlite::Result<DecodedTrajectoryMeta> {
    let mut stmt =
        conn.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")?;
    match stmt.query_row([], |row| row.get::<_, Vec<u8>>(0)) {
        Ok(b) => Ok(decode_trajectory_metadata(&b)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(DecodedTrajectoryMeta::default()),
        Err(e) => Err(e),
    }
}

fn read_gen_metadata_rows(conn: &Connection) -> rusqlite::Result<Vec<DecodedGeneratorMeta>> {
    let mut stmt = conn.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC")?;
    let rows = stmt.query_map([], |row| {
        let idx: i64 = row.get(0)?;
        let data: Vec<u8> = row.get(1)?;
        Ok(decode_generator_metadata(idx, &data))
    })?;
    rows.collect()
}

fn safe_token_opt(v: Option<u64>) -> Option<i64> {
    v.and_then(|n| if n <= MAX_SAFE_INT { Some(n as i64) } else { None })
}

fn synthesize_generators_from_steps(
    steps: &[(i64, i32, i32, DecodedStepMeta)],
    existing_gens: &[DecodedGeneratorMeta],
) -> Vec<DecodedGeneratorMeta> {
    let mut gen_by_step: HashMap<u32, &DecodedGeneratorMeta> = HashMap::new();
    for g in existing_gens {
        for &si in &g.step_indices {
            gen_by_step.entry(si).or_insert(g);
        }
    }
    let last_usage_local_idx = steps
        .iter()
        .enumerate()
        .rev()
        .find(|(_, (_, _, _, meta))| meta.model_usage.is_some())
        .map(|(i, _)| i);
    let mut synthesized_context: Option<DecodedContextWindow> = None;
    if let Some(last_i) = last_usage_local_idx {
        let (_, _, _, ref lm) = steps[last_i];
        if let Some(ref lu) = lm.model_usage {
            if let Some(in_tok) = safe_token_opt(lu.input_tokens) {
                let rd = safe_token_opt(lu.cache_read_tokens).unwrap_or(0);
                let wr = safe_token_opt(lu.cache_write_tokens).unwrap_or(0);
                let out = safe_token_opt(lu.output_tokens).unwrap_or(0);
                let used = in_tok.saturating_add(rd).saturating_add(wr).saturating_add(out);
                let max_ctx = lm
                    .model_info
                    .as_ref()
                    .and_then(|mi| mi.max_tokens)
                    .filter(|&m| m > 0)
                    .map(|m| m as i64);
                synthesized_context = Some(DecodedContextWindow {
                    estimated_tokens_used: Some(used),
                    max_context_tokens: max_ctx,
                });
            }
        }
    }
    let mut synthesized = Vec::new();
    for (local_pos, (_idx, _stype, _status, meta)) in steps.iter().enumerate() {
        let Some(ref u) = meta.model_usage else {
            continue;
        };
        let global_idx = meta.source_step_index.unwrap_or(local_pos as u32);
        let matched_gen = gen_by_step
            .get(&global_idx)
            .or_else(|| gen_by_step.get(&(local_pos as u32)))
            .copied();
        let raw_model_name = meta
            .model_info
            .as_ref()
            .and_then(|mi| mi.display_name.as_deref().or(mi.model_name.as_deref()))
            .or_else(|| {
                matched_gen
                    .and_then(|g| g.planner_config.as_ref())
                    .and_then(|pc| pc.model_name.as_deref().or(pc.plan_model.as_deref()))
            })
            .or(u.model.as_deref())
            .or(meta.requested_model.as_deref())
            .or(meta.generator_model.as_deref())
            .unwrap_or("");
        let api_provider = infer_api_provider(u.api_provider.as_deref(), meta, raw_model_name);
        let response_id = u
            .response_id
            .clone()
            .or_else(|| meta.model_api_content_id.clone());
        let model_str = u.model.clone().or_else(|| {
            if raw_model_name.is_empty() {
                None
            } else {
                Some(raw_model_name.to_string())
            }
        });
        let mut usage = u.clone();
        if api_provider.is_some() {
            usage.api_provider = api_provider;
        }
        if response_id.is_some() {
            usage.response_id = response_id;
        }
        if model_str.is_some() {
            usage.model = model_str;
        }
        let ttft = iso_diff_duration(meta.created_at.as_deref(), meta.viewable_at.as_deref())
            .map(|(_, dur)| dur);
        let stream_dur = iso_diff_duration(
            meta.viewable_at.as_deref(),
            meta.finished_generating_at.as_deref(),
        )
        .and_then(|(ns, dur)| if ns > 0 { Some(dur) } else { None });
        let is_last = Some(local_pos) == last_usage_local_idx;
        synthesized.push(DecodedGeneratorMeta {
            idx: local_pos as i64,
            step_indices: vec![global_idx],
            chat_model: Some(DecodedChatModel {
                model: if raw_model_name.is_empty() {
                    None
                } else {
                    Some(raw_model_name.to_string())
                },
                response_model: if raw_model_name.is_empty() {
                    None
                } else {
                    Some(raw_model_name.to_string())
                },
                model_display_name: meta
                    .model_info
                    .as_ref()
                    .and_then(|mi| mi.display_name.clone()),
                usage: Some(usage),
                time_to_first_token: ttft,
                streaming_duration: stream_dur,
                chat_start_metadata: Some(DecodedChatStartMeta {
                    created_at: meta.created_at.clone(),
                    context_window_metadata: if is_last {
                        synthesized_context.clone()
                    } else {
                        None
                    },
                }),
                ..Default::default()
            }),
            planner_config: None,
            execution_id: meta.execution_id.clone(),
        });
    }
    synthesized
}

pub fn extract_sqlite_usage_records_from_conn(
    conn: &Connection,
    conversation_id: &str,
) -> Option<Vec<UsageRecord>> {
    let _tx = conn.unchecked_transaction().ok()?;
    let mut step_stmt = conn
        .prepare("SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC")
        .ok()?;
    let step_rows = step_stmt
        .query_map([], |row| {
            let idx: i64 = row.get(0)?;
            let step_type: i32 = row.get(1)?;
            let status: i32 = row.get(2)?;
            let meta_bytes: Option<Vec<u8>> = row.get(3)?;
            let meta = meta_bytes
                .map(|b| decode_step_metadata(&b))
                .unwrap_or_default();
            Ok((idx, step_type, status, meta))
        })
        .ok()?;
    let steps: Vec<(i64, i32, i32, DecodedStepMeta)> =
        step_rows.collect::<rusqlite::Result<Vec<_>>>().ok()?;

    let raw_gens = read_gen_metadata_rows(conn).ok()?;
    let has_native_usage = raw_gens
        .iter()
        .any(|g| g.chat_model.as_ref().and_then(|c| c.usage.as_ref()).is_some());
    let effective_gens = if has_native_usage {
        raw_gens
    } else {
        synthesize_generators_from_steps(&steps, &raw_gens)
    };

    let mut ordered_ids: Vec<String> = Vec::new();
    let mut records_map: HashMap<String, UsageRecord> = HashMap::new();

    for (index, g) in effective_gens.iter().enumerate() {
        let Some(ref chat) = g.chat_model else {
            continue;
        };
        let Some(ref u) = chat.usage else {
            continue;
        };

        let uncached_opt = safe_token_opt(u.input_tokens);
        let read_opt = match u.cache_read_tokens {
            Some(v) => safe_token_opt(Some(v)),
            None => Some(0),
        };
        let write_opt = match u.cache_write_tokens {
            Some(v) => safe_token_opt(Some(v)),
            None => Some(0),
        };
        let output_opt = safe_token_opt(u.output_tokens);

        if uncached_opt.unwrap_or(0) == 0
            && read_opt.unwrap_or(0) == 0
            && write_opt.unwrap_or(0) == 0
            && output_opt.unwrap_or(0) == 0
        {
            continue;
        }

        let has_valid_cache = match (uncached_opt, read_opt, write_opt) {
            (Some(unc), Some(rd), Some(wr)) => {
                let total = unc.saturating_add(rd).saturating_add(wr);
                total == 0 || is_valid_cache_provider(u.api_provider.as_deref())
            }
            _ => false,
        };
        let partial = uncached_opt.is_none()
            || read_opt.is_none()
            || write_opt.is_none()
            || output_opt.is_none()
            || (!has_valid_cache && uncached_opt.unwrap_or(0) > 0);

        let request_start = chat
            .chat_start_metadata
            .as_ref()
            .and_then(|csm| csm.created_at.as_deref())
            .and_then(parse_iso_to_epoch_ms);

        let mut planner_earliest: Option<i64> = None;
        if !g.step_indices.is_empty() && !steps.is_empty() {
            for &si in &g.step_indices {
                if let Some((_idx, stype, _st, smeta)) = steps.get(si as usize) {
                    if *stype == 15 {
                        if let Some(ts) =
                            smeta.created_at.as_deref().and_then(parse_iso_to_epoch_ms)
                        {
                            planner_earliest = Some(match planner_earliest {
                                Some(prev) => prev.min(ts),
                                None => ts,
                            });
                        }
                    }
                }
            }
        }

        let at = request_start.or(planner_earliest);
        let time_basis = if request_start.is_some() {
            "request-start"
        } else if at.is_some() {
            "planner-created"
        } else {
            "unknown"
        };

        let api_provider = u.api_provider.as_deref().unwrap_or("");
        let response_id = u.response_id.as_deref().unwrap_or("");
        let message_id = u.message_id.as_deref().unwrap_or("");

        let key = if !response_id.is_empty() {
            format!("response:{}:{}", api_provider, response_id)
        } else if !message_id.is_empty() {
            format!("message:{}:{}", api_provider, message_id)
        } else {
            let indices_part = if g.step_indices.is_empty() {
                format!("[{}]", index)
            } else {
                let parts: Vec<String> = g.step_indices.iter().map(|v| v.to_string()).collect();
                format!("[{}]", parts.join(","))
            };
            let at_str = at
                .map(|v| v.to_string())
                .unwrap_or_else(|| "undated".to_string());
            format!("fallback:{}:{}:{}", conversation_id, indices_part, at_str)
        };

        let id = sha256_hex(&key);
        let model = clean_model_name(&[
            chat.model_display_name.as_deref(),
            chat.response_model.as_deref(),
            u.model.as_deref(),
            chat.model.as_deref(),
        ]);

        let row = UsageRecord {
            id: id.clone(),
            at,
            model,
            uncached: uncached_opt,
            cache_read: read_opt,
            cache_write: write_opt,
            output: output_opt,
            partial,
            time_basis,
        };

        let row_sum = row
            .uncached
            .unwrap_or(0)
            .saturating_add(row.cache_read.unwrap_or(0))
            .saturating_add(row.cache_write.unwrap_or(0))
            .saturating_add(row.output.unwrap_or(0));
        if let Some(old) = records_map.get_mut(&id) {
            let old_sum = old
                .uncached
                .unwrap_or(0)
                .saturating_add(old.cache_read.unwrap_or(0))
                .saturating_add(old.cache_write.unwrap_or(0))
                .saturating_add(old.output.unwrap_or(0));
            if row_sum > old_sum {
                *old = row;
            }
        } else {
            ordered_ids.push(id.clone());
            records_map.insert(id, row);
        }
    }

    let out: Vec<UsageRecord> = ordered_ids
        .into_iter()
        .filter_map(|id| records_map.remove(&id))
        .collect();
    Some(out)
}

pub fn extract_sqlite_usage_records_json(
    db_path: &str,
    conversation_id: &str,
) -> Option<String> {
    if let Some(cached) = crate::shared_cache::lookup_cached_usage(db_path) {
        return Some(cached);
    }
    let stamp_before = crate::shared_cache::stat_trajectory_files(Path::new(db_path));
    let conn = open_readonly_db(db_path)?;
    let records = extract_sqlite_usage_records_from_conn(&conn, conversation_id)?;
    let json = serde_json::to_string(&records).ok()?;
    if let Some(stamp) = stamp_before {
        let _ = crate::shared_cache::store_cached_usage_with_stamp(db_path, &stamp, &json);
    }
    Some(json)
}

fn usage_to_json(u: &DecodedModelUsage) -> Value {
    let mut m = Map::new();
    if let Some(v) = u.input_tokens {
        m.insert("inputTokens".to_string(), json!(v));
    }
    if let Some(v) = u.output_tokens {
        m.insert("outputTokens".to_string(), json!(v));
    }
    if let Some(v) = u.response_output_tokens {
        m.insert("responseOutputTokens".to_string(), json!(v));
    }
    if let Some(v) = u.thinking_output_tokens {
        m.insert("thinkingOutputTokens".to_string(), json!(v));
    }
    if let Some(v) = u.cache_read_tokens {
        m.insert("cacheReadTokens".to_string(), json!(v));
    }
    if let Some(v) = u.cache_write_tokens {
        m.insert("cacheWriteTokens".to_string(), json!(v));
    }
    if let Some(ref p) = u.api_provider {
        m.insert("apiProvider".to_string(), json!(p));
    }
    if let Some(ref r) = u.response_id {
        m.insert("responseId".to_string(), json!(r));
    }
    if let Some(ref mid) = u.message_id {
        m.insert("messageId".to_string(), json!(mid));
    }
    if let Some(ref model) = u.model {
        m.insert("model".to_string(), json!(model));
    }
    Value::Object(m)
}

fn subagent_spec_to_json(spec: &DecodedSubagentSpec, include_extended: bool) -> Option<Value> {
    let mut m = Map::new();
    if let Some(ref cid) = spec.conversation_id {
        if let Some(norm) = normalize_guid(cid) {
            m.insert("conversationId".to_string(), json!(norm));
        }
    }
    if let Some(ref r) = spec.role {
        m.insert("role".to_string(), json!(r));
    }
    if let Some(ref t) = spec.type_name {
        m.insert("typeName".to_string(), json!(t));
    }
    if include_extended {
        if let Some(inh) = spec.inherit {
            m.insert("inherit".to_string(), json!(inh));
        }
        if let Some(ref model) = spec.model {
            m.insert("model".to_string(), json!(model));
        }
        if let Some(ref tier) = spec.model_tier {
            m.insert("modelTier".to_string(), json!(tier));
        }
    }
    if m.is_empty() {
        None
    } else {
        Some(Value::Object(m))
    }
}

fn trajectory_meta_to_json(meta: &DecodedTrajectoryMeta) -> Value {
    let mut m = Map::new();
    if let Some(ref c) = meta.created_at {
        m.insert("createdAt".to_string(), json!(c));
    }
    if let Some(ref p) = meta.parent_conversation_id {
        if let Some(norm) = normalize_guid(p) {
            m.insert("parentConversationId".to_string(), json!(norm));
        }
    }
    if let Some(ref r) = meta.root_conversation_id {
        if let Some(norm) = normalize_guid(r) {
            m.insert("rootConversationId".to_string(), json!(norm));
        }
    }
    if let Some(d) = meta.nesting_depth {
        m.insert("nestingDepth".to_string(), json!(d));
    }
    if let Some(ref spec) = meta.subagent_spec {
        if let Some(spec_val) = subagent_spec_to_json(spec, true) {
            m.insert("subagentSpec".to_string(), spec_val);
        }
    }
    Value::Object(m)
}

pub fn read_sqlite_trajectory_from_conn(
    conn: &Connection,
    conversation_id: &str,
    model_timeline_enabled: bool,
) -> Option<Value> {
    read_sqlite_trajectory_from_conn_budgeted(conn, conversation_id, model_timeline_enabled, None)
}

pub fn read_sqlite_trajectory_from_conn_budgeted(
    conn: &Connection,
    conversation_id: &str,
    model_timeline_enabled: bool,
    max_output_bytes: Option<usize>,
) -> Option<Value> {
    let _tx = conn.unchecked_transaction().ok()?;
    let traj_meta = read_trajectory_meta_row(conn).ok()?;

    let sql = "SELECT idx, step_type, status, metadata,
      CASE
        WHEN step_type IN (14, 15, 81, 101, 127) THEN step_payload
        WHEN step_type = 132 AND (
          instr(CAST(metadata AS BLOB), CAST('invoke_subagent' AS BLOB)) > 0 OR
          instr(CAST(metadata AS BLOB), CAST('send_message' AS BLOB)) > 0 OR
          instr(CAST(metadata AS BLOB), CAST('task_boundary' AS BLOB)) > 0 OR
          instr(CAST(metadata AS BLOB), CAST('exit_plan_mode' AS BLOB)) > 0 OR
          instr(CAST(metadata AS BLOB), CAST('enter_plan_mode' AS BLOB)) > 0
        ) THEN step_payload
        ELSE NULL
      END AS payload
    FROM steps ORDER BY idx ASC";

    let mut stmt = conn.prepare(sql).ok()?;
    let rows = stmt
        .query_map([], |row| {
            let idx: i64 = row.get(0)?;
            let step_type: i32 = row.get(1)?;
            let status: i32 = row.get(2)?;
            let meta_bytes: Option<Vec<u8>> = row.get(3)?;
            let payload_bytes: Option<Vec<u8>> = row.get(4)?;
            let meta = meta_bytes
                .map(|b| decode_step_metadata(&b))
                .unwrap_or_default();
            let payload = payload_bytes.map(|b| {
                decode_step_payload(step_type, meta.tool_call_name.as_deref(), &b)
            });
            Ok((idx, step_type, status, meta, payload))
        })
        .ok()?;

    let decoded_steps: Vec<_> = rows.collect::<rusqlite::Result<Vec<_>>>().ok()?;
    let mut approx_bytes: usize = 256;

    let mut captured_plan_model: Option<String> = None;
    let mut projected_steps: Vec<Value> = Vec::with_capacity(decoded_steps.len());
    let mut last_status_str: Option<&'static str> = None;

    for (idx, step_type, status, ref meta, ref payload_opt) in &decoded_steps {
        let status_str = step_status_to_str(*status);
        last_status_str = Some(status_str);
        let type_str = step_type_to_str(*step_type, meta.tool_call_name.as_deref());

        let mut step_obj = Map::new();
        if model_timeline_enabled {
            step_obj.insert("i".to_string(), json!(idx));
            step_obj.insert("status".to_string(), json!(status_str));
        }
        step_obj.insert("type".to_string(), json!(type_str));

        let mut meta_obj = Map::new();
        if let Some(ref c) = meta.created_at {
            meta_obj.insert("createdAt".to_string(), json!(c));
        }
        if let Some(ref s) = meta.started_at {
            meta_obj.insert("startedAt".to_string(), json!(s));
        }
        if let Some(ref comp) = meta.completed_at {
            meta_obj.insert("completedAt".to_string(), json!(comp));
        }
        if model_timeline_enabled {
            if let Some(ref gm) = meta.generator_model {
                meta_obj.insert("generatorModel".to_string(), json!(gm));
            }
            if let Some(ref tc_name) = meta.tool_call_name {
                meta_obj.insert("toolCall".to_string(), json!({ "name": tc_name }));
            } else if meta.has_tool_call {
                meta_obj.insert("toolCall".to_string(), json!({}));
            }
        } else if meta.has_tool_call || meta.tool_call_name.is_some() {
            meta_obj.insert("toolCall".to_string(), json!(true));
        }
        step_obj.insert("metadata".to_string(), Value::Object(meta_obj));

        if let Some(ref payload) = payload_opt {
            if let Some(ref pm) = payload.user_input_plan_model {
                let trimmed = pm.trim();
                if !trimmed.is_empty() {
                    captured_plan_model = Some(trimmed.chars().take(256).collect());
                    if model_timeline_enabled {
                        step_obj.insert(
                            "userInput".to_string(),
                            json!({
                                "userConfig": {
                                    "plannerConfig": {
                                        "planModel": captured_plan_model,
                                        "requestedModel": { "model": captured_plan_model }
                                    }
                                }
                            }),
                        );
                    }
                }
            }
            if *step_type == 15 || payload.planner_response_nonempty.is_some() {
                let mut pr_obj = Map::new();
                let resp_str = if payload.planner_response_nonempty == Some(true) {
                    "1"
                } else {
                    ""
                };
                pr_obj.insert("response".to_string(), json!(resp_str));
                if !payload.planner_tool_call_names.is_empty() {
                    if model_timeline_enabled {
                        let calls: Vec<Value> = payload
                            .planner_tool_call_names
                            .iter()
                            .map(|n| json!({ "name": n }))
                            .collect();
                        pr_obj.insert("toolCalls".to_string(), Value::Array(calls));
                    } else {
                        pr_obj.insert("toolCalls".to_string(), json!([{}]));
                    }
                }
                step_obj.insert("plannerResponse".to_string(), Value::Object(pr_obj));
            }
            if model_timeline_enabled {
                if let Some(ref tb_mode) = payload.task_boundary_mode {
                    step_obj.insert("taskBoundary".to_string(), json!({ "mode": tb_mode }));
                }
                if let Some(ref ev_type) = payload.system_message_event_type {
                    step_obj.insert("systemMessage".to_string(), json!({ "eventType": ev_type }));
                }
                if payload.exit_plan_mode {
                    step_obj.insert("exitPlanMode".to_string(), json!(true));
                }
                if payload.enter_plan_mode {
                    step_obj.insert("enterPlanMode".to_string(), json!(true));
                }
            }
            if let Some(ref inv) = payload.invoke_subagent {
                let mut inv_obj = Map::new();
                if let Some(ref cid) = inv.conversation_id {
                    if let Some(norm) = normalize_guid(cid) {
                        inv_obj.insert("conversationId".to_string(), json!(norm));
                    }
                }
                let subs: Vec<Value> = inv
                    .subagents
                    .iter()
                    .filter_map(|s| subagent_spec_to_json(s, false))
                    .collect();
                if !subs.is_empty() {
                    inv_obj.insert("subagents".to_string(), Value::Array(subs));
                }
                let results: Vec<Value> = inv
                    .result_conversation_ids
                    .iter()
                    .filter_map(|cid| normalize_guid(cid).map(|norm| json!({ "conversationId": norm })))
                    .collect();
                if !results.is_empty() {
                    inv_obj.insert("results".to_string(), Value::Array(results));
                }
                if !inv_obj.is_empty() {
                    if *step_type == 132 {
                        let first_sub = inv.subagents.first();
                        let mut sub_flat = Map::new();
                        if let Some(cid_val) = inv_obj.get("conversationId") {
                            sub_flat.insert("conversationId".to_string(), cid_val.clone());
                        }
                        if let Some(s) = first_sub {
                            if let Some(ref tn) = s.type_name {
                                sub_flat.insert("typeName".to_string(), json!(tn));
                            }
                            if let Some(ref r) = s.role {
                                sub_flat.insert("role".to_string(), json!(r));
                            }
                        }
                        if !sub_flat.is_empty() {
                            step_obj.insert("subagent".to_string(), Value::Object(sub_flat));
                        }
                    }
                    step_obj.insert("invokeSubagent".to_string(), Value::Object(inv_obj));
                }
            }
            if let Some(ref recipient) = payload.send_message_recipient {
                let norm_self = conversation_id.to_ascii_lowercase();
                let is_child_session = traj_meta.parent_conversation_id.is_some()
                    || traj_meta.nesting_depth.unwrap_or(0) > 0
                    || traj_meta
                        .root_conversation_id
                        .as_deref()
                        .and_then(normalize_guid)
                        .map(|r| r != norm_self)
                        .unwrap_or(false);
                if !is_child_session {
                    let norm = normalize_guid(recipient).unwrap_or_else(|| recipient.clone());
                    if norm != norm_self {
                        step_obj.insert(
                            "sendMessage".to_string(),
                            json!({ "conversationId": norm }),
                        );
                    }
                }
            }
        } else if *step_type == 15 {
            step_obj.insert("plannerResponse".to_string(), json!({ "response": "" }));
        }

        approx_bytes = approx_bytes.saturating_add(48 + type_str.len());
        if let Some(limit) = max_output_bytes {
            if limit > 0 && approx_bytes > limit.saturating_mul(2) {
                return Some(json!({ "__budgetExceeded": true }));
            }
        }
        projected_steps.push(Value::Object(step_obj));
    }

    let raw_gens = read_gen_metadata_rows(conn).ok()?;
    let has_native_usage = raw_gens
        .iter()
        .any(|g| g.chat_model.as_ref().and_then(|c| c.usage.as_ref()).is_some());
    let effective_gens = if has_native_usage {
        raw_gens
    } else {
        let bare_steps: Vec<(i64, i32, i32, DecodedStepMeta)> = decoded_steps
            .iter()
            .map(|(i, t, s, m, _)| (*i, *t, *s, m.clone()))
            .collect();
        synthesize_generators_from_steps(&bare_steps, &raw_gens)
    };

    let mut projected_gens: Vec<Value> = Vec::with_capacity(effective_gens.len());
    for g in &effective_gens {
        let mut g_obj = Map::new();
        if !g.step_indices.is_empty() {
            g_obj.insert("stepIndices".to_string(), json!(g.step_indices));
        }
        if let Some(ref pc) = g.planner_config {
            let pm = pc.plan_model.as_ref().or(pc.model_name.as_ref());
            if let Some(pm_str) = pm {
                if captured_plan_model.is_none() {
                    captured_plan_model = Some(pm_str.clone());
                }
                if model_timeline_enabled {
                    g_obj.insert("plannerConfig".to_string(), json!({ "planModel": pm_str }));
                }
            }
        }
        if let Some(ref chat) = g.chat_model {
            let mut cm_obj = Map::new();
            if let Some(ref u) = chat.usage {
                cm_obj.insert("usage".to_string(), usage_to_json(u));
            }
            if let Some(ref m) = chat.model {
                cm_obj.insert("model".to_string(), json!(m));
            }
            if let Some(ref mdn) = chat.model_display_name {
                cm_obj.insert("modelDisplayName".to_string(), json!(mdn));
            }
            if let Some(ref rm) = chat.response_model {
                cm_obj.insert("responseModel".to_string(), json!(rm));
            }
            if let Some(ref sd) = chat.streaming_duration {
                cm_obj.insert("streamingDuration".to_string(), json!(sd));
            }
            if let Some(ref ttft) = chat.time_to_first_token {
                cm_obj.insert("timeToFirstToken".to_string(), json!(ttft));
            }
            if !chat.retry_usages.is_empty() {
                let retries: Vec<Value> = chat
                    .retry_usages
                    .iter()
                    .map(|ru| json!({ "usage": usage_to_json(ru) }))
                    .collect();
                cm_obj.insert("retryInfos".to_string(), Value::Array(retries));
            }
            if let Some(ref csm) = chat.chat_start_metadata {
                let mut csm_obj = Map::new();
                if let Some(ref ca) = csm.created_at {
                    csm_obj.insert("createdAt".to_string(), json!(ca));
                }
                if let Some(ref cw) = csm.context_window_metadata {
                    let mut cw_obj = Map::new();
                    if let Some(est) = cw.estimated_tokens_used {
                        cw_obj.insert("estimatedTokensUsed".to_string(), json!(est));
                    }
                    if let Some(max) = cw.max_context_tokens {
                        cw_obj.insert("maxContextTokens".to_string(), json!(max));
                    }
                    if !cw_obj.is_empty() {
                        csm_obj.insert(
                            "contextWindowMetadata".to_string(),
                            Value::Object(cw_obj),
                        );
                    }
                }
                if !csm_obj.is_empty() {
                    cm_obj.insert("chatStartMetadata".to_string(), Value::Object(csm_obj));
                }
            }
            if !cm_obj.is_empty() {
                g_obj.insert("chatModel".to_string(), Value::Object(cm_obj));
            }
        }
        approx_bytes = approx_bytes.saturating_add(64);
        if let Some(limit) = max_output_bytes {
            if limit > 0 && approx_bytes > limit.saturating_mul(2) {
                return Some(json!({ "__budgetExceeded": true }));
            }
        }
        projected_gens.push(Value::Object(g_obj));
    }

    let num_steps = projected_steps.len();
    let num_gens = projected_gens.len();

    let mut traj_obj = Map::new();
    traj_obj.insert("trajectoryId".to_string(), json!(conversation_id));
    traj_obj.insert("cascadeId".to_string(), json!(conversation_id));
    if let Some(ref pm) = captured_plan_model {
        traj_obj.insert("planModel".to_string(), json!(pm));
    }
    traj_obj.insert("steps".to_string(), Value::Array(projected_steps));
    traj_obj.insert("generatorMetadata".to_string(), Value::Array(projected_gens));
    traj_obj.insert("metadata".to_string(), trajectory_meta_to_json(&traj_meta));

    let mut root = Map::new();
    root.insert("trajectory".to_string(), Value::Object(traj_obj));
    root.insert("numTotalSteps".to_string(), json!(num_steps));
    root.insert("numTotalGeneratorMetadata".to_string(), json!(num_gens));
    if let Some(st) = last_status_str {
        root.insert("status".to_string(), json!(st));
    }
    Some(Value::Object(root))
}

pub fn read_sqlite_trajectory_json(
    db_path: &str,
    conversation_id: &str,
    model_timeline_enabled: bool,
) -> Option<String> {
    read_sqlite_trajectory_json_budgeted(db_path, conversation_id, model_timeline_enabled, None)
}

pub fn read_sqlite_trajectory_json_budgeted(
    db_path: &str,
    conversation_id: &str,
    model_timeline_enabled: bool,
    max_output_bytes: Option<usize>,
) -> Option<String> {
    let conn = open_readonly_db(db_path)?;
    let val = read_sqlite_trajectory_from_conn_budgeted(
        &conn,
        conversation_id,
        model_timeline_enabled,
        max_output_bytes,
    )?;
    if val.get("__budgetExceeded").and_then(|v| v.as_bool()) == Some(true) {
        return Some("{\"__budgetExceeded\":true}".to_string());
    }
    let json = serde_json::to_string(&val).ok()?;
    if let Some(limit) = max_output_bytes {
        if limit > 0 && json.len() > limit {
            return Some("{\"__budgetExceeded\":true}".to_string());
        }
    }
    Some(json)
}

pub fn read_sqlite_conversation_meta_from_conn(
    conn: &Connection,
    conversation_id: &str,
) -> Option<Value> {
    let _tx = conn.unchecked_transaction().ok()?;
    let traj_meta = read_trajectory_meta_row(conn).ok()?;
    let step_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM steps", [], |r| r.get(0))
        .ok()?;
    let max_idx: Option<i64> = match conn.query_row("SELECT MAX(idx) FROM steps", [], |r| r.get(0))
    {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(_) => return None,
    };

    let Value::Object(mut m) = trajectory_meta_to_json(&traj_meta) else {
        return None;
    };
    m.insert("conversationId".to_string(), json!(conversation_id));
    m.insert("stepCount".to_string(), json!(step_count));
    if let Some(mx) = max_idx {
        m.insert("maxStepIdx".to_string(), json!(mx));
    }
    Some(Value::Object(m))
}

pub fn read_sqlite_conversation_meta_json(
    db_path: &str,
    conversation_id: &str,
) -> Option<String> {
    let conn = open_readonly_db(db_path)?;
    let val = read_sqlite_conversation_meta_from_conn(&conn, conversation_id)?;
    serde_json::to_string(&val).ok()
}

fn parse_sqlite_modified_ms(val: rusqlite::types::ValueRef<'_>) -> i64 {
    match val {
        rusqlite::types::ValueRef::Integer(n) => n.max(0),
        rusqlite::types::ValueRef::Real(f) => {
            if f.is_finite() && f > 0.0 {
                f as i64
            } else {
                0
            }
        }
        rusqlite::types::ValueRef::Text(bytes) => {
            let Ok(raw) = std::str::from_utf8(bytes) else {
                return 0;
            };
            let s = raw.trim();
            if s.is_empty() {
                return 0;
            }
            if let Ok(n) = s.parse::<i64>() {
                return n.max(0);
            }
            let b = s.as_bytes();
            let normalized = if b.len() >= 19 && (b[10] == b'T' || b[10] == b' ') {
                let mut tmp = String::with_capacity(s.len() + 1);
                tmp.push_str(&s[..10]);
                tmp.push('T');
                tmp.push_str(&s[11..]);
                if b.len() == 19 {
                    tmp.push('Z');
                }
                tmp
            } else {
                s.to_string()
            };
            parse_iso_to_epoch_ns(&normalized)
                .and_then(|ns| i64::try_from(ns / 1_000_000).ok())
                .filter(|&ms| ms > 0)
                .unwrap_or(0)
        }
        _ => 0,
    }
}

pub fn read_sqlite_conversation_summaries_json(db_path: &str) -> Option<String> {
    let conn = open_readonly_db(db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT conversation_id, COALESCE(title, ''), COALESCE(preview, ''), \
             COALESCE(last_modified_time, 0), COALESCE(workspace_uris, ''), \
             COALESCE(project_id, ''), COALESCE(parent_conversation_id, ''), \
             COALESCE(source, ''), COALESCE(agent_name, '') \
             FROM conversation_summaries",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |row| {
            let cid: String = row.get(0)?;
            let title: String = row.get(1)?;
            let preview: String = row.get(2)?;
            let modified_ms = row.get_ref(3).map(parse_sqlite_modified_ms).unwrap_or(0);
            let workspace_uris: String = row.get(4)?;
            let project_id: String = row.get(5)?;
            let parent_id: String = row.get(6)?;
            let source: String = row.get(7)?;
            let agent_name: String = row.get(8)?;
            Ok(json!({
                "conversationId": cid,
                "title": title,
                "preview": preview,
                "lastModifiedTime": modified_ms,
                "workspaceUris": workspace_uris,
                "projectId": project_id,
                "parentConversationId": parent_id,
                "source": source,
                "agentName": agent_name,
            }))
        })
        .ok()?;
    let mut out = Vec::new();
    for item in rows {
        if let Ok(val) = item {
            out.push(val);
        }
    }
    serde_json::to_string(&out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let mut byte = (v & 0x7F) as u8;
            v >>= 7;
            if v != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if v == 0 {
                break;
            }
        }
    }

    fn encode_tag(field_num: u32, wire_type: u8, out: &mut Vec<u8>) {
        encode_varint(((field_num as u64) << 3) | (wire_type as u64), out);
    }

    fn encode_bytes(field_num: u32, bytes: &[u8], out: &mut Vec<u8>) {
        encode_tag(field_num, WIRE_LEN, out);
        encode_varint(bytes.len() as u64, out);
        out.extend_from_slice(bytes);
    }

    fn encode_str(field_num: u32, s: &str, out: &mut Vec<u8>) {
        encode_bytes(field_num, s.as_bytes(), out);
    }

    fn encode_u64(field_num: u32, val: u64, out: &mut Vec<u8>) {
        encode_tag(field_num, WIRE_VARINT, out);
        encode_varint(val, out);
    }

    fn encode_timestamp(seconds: i64, nanos: i32) -> Vec<u8> {
        let mut b = Vec::new();
        encode_u64(1, seconds as u64, &mut b);
        if nanos != 0 {
            encode_u64(2, nanos as u64, &mut b);
        }
        b
    }

    #[test]
    fn test_iso_to_epoch_ms_roundtrip() {
        let ts_bytes = encode_timestamp(1776429296, 789_000_000);
        let iso = parse_timestamp_iso(&ts_bytes).expect("valid iso");
        assert_eq!(iso, "2026-04-17T12:34:56.789Z");
        assert_eq!(parse_iso_to_epoch_ms(&iso), Some(1776429296789));
    }

    #[test]
    fn test_sqlite_trajectory_and_usage_extraction() {
        let tmp_path = std::env::temp_dir().join(format!(
            "pulse_accel_test_{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp_path);
        let db_path_str = tmp_path.to_str().unwrap();

        // Missing file must return None and never create an empty file
        assert_eq!(
            extract_sqlite_usage_records_json(db_path_str, "11111111-2222-3333-4444-555555555555"),
            None
        );
        assert!(!tmp_path.exists());

        let conn = Connection::open(&tmp_path).expect("open temp db");
        conn.execute_batch(
            "CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
             CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
             CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);",
        )
        .expect("create tables");

        // 1. Insert trajectory_metadata_blob
        let mut spec_bytes = Vec::new();
        encode_str(1, "research", &mut spec_bytes);
        encode_str(2, "Codebase Researcher", &mut spec_bytes);
        encode_u64(4, 0, &mut spec_bytes);
        encode_u64(8, 3, &mut spec_bytes); // MODEL_TIER_FLASH

        let mut traj_meta_bytes = Vec::new();
        let created_ts = encode_timestamp(1776429000, 0);
        encode_bytes(2, &created_ts, &mut traj_meta_bytes);
        encode_str(
            5,
            "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
            &mut traj_meta_bytes,
        );
        encode_str(
            6,
            "00000000-1111-2222-3333-444444444444",
            &mut traj_meta_bytes,
        );
        encode_bytes(8, &spec_bytes, &mut traj_meta_bytes);
        encode_u64(17, 2, &mut traj_meta_bytes);

        conn.execute(
            "INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?1)",
            [&traj_meta_bytes],
        )
        .unwrap();

        // 2. Insert steps:
        // Step 0: USER_INPUT (14) with plan_model = 1668 (MODEL_PLACEHOLDER_M668)
        let mut pc_bytes = Vec::new();
        encode_u64(1, 1668, &mut pc_bytes);
        let mut user_cfg = Vec::new();
        encode_bytes(1, &pc_bytes, &mut user_cfg);
        let mut user_input = Vec::new();
        encode_bytes(12, &user_cfg, &mut user_input);
        let mut step0_payload = Vec::new();
        encode_bytes(19, &user_input, &mut step0_payload);
        let mut step0_meta = Vec::new();
        encode_bytes(1, &encode_timestamp(1776429001, 0), &mut step0_meta);
        conn.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (0, 14, 3, ?1, ?2)",
            (&step0_meta, &step0_payload),
        )
        .unwrap();

        // Step 1: PLANNER_RESPONSE (15) with response text and tool_calls
        let mut tc_bytes = Vec::new();
        encode_str(1, "call_1", &mut tc_bytes);
        encode_str(2, "view_file", &mut tc_bytes);
        let mut pr_inner = Vec::new();
        encode_str(1, "Thinking and calling tool", &mut pr_inner);
        encode_bytes(7, &tc_bytes, &mut pr_inner);
        let mut step1_payload = Vec::new();
        encode_bytes(20, &pr_inner, &mut step1_payload);
        let mut step1_meta = Vec::new();
        encode_bytes(1, &encode_timestamp(1776429005, 500_000_000), &mut step1_meta);
        encode_u64(11, 1668, &mut step1_meta);
        conn.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 15, 3, ?1, ?2)",
            (&step1_meta, &step1_payload),
        )
        .unwrap();

        // Step 2:GENERIC (132) invoke_subagent
        let mut step2_tc = Vec::new();
        encode_str(2, "invoke_subagent", &mut step2_tc);
        let mut step2_meta = Vec::new();
        encode_bytes(4, &step2_tc, &mut step2_meta);
        let mut arg_cid = Vec::new();
        encode_str(1, "ConversationId", &mut arg_cid);
        encode_str(2, "99999999-8888-7777-6666-555555555555", &mut arg_cid);
        let mut arg_role = Vec::new();
        encode_str(1, "Role", &mut arg_role);
        encode_str(2, "Worker Subagent", &mut arg_role);
        let mut generic_inner = Vec::new();
        encode_bytes(1, &arg_cid, &mut generic_inner);
        encode_bytes(1, &arg_role, &mut generic_inner);
        let mut step2_payload = Vec::new();
        encode_bytes(140, &generic_inner, &mut step2_payload);
        conn.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (2, 132, 3, ?1, ?2)",
            (&step2_meta, &step2_payload),
        )
        .unwrap();

        // 3. Insert gen_metadata
        let mut usage_bytes = Vec::new();
        encode_u64(1, 1668, &mut usage_bytes);
        encode_u64(2, 1200, &mut usage_bytes); // input_tokens
        encode_u64(3, 350, &mut usage_bytes); // output_tokens
        encode_u64(4, 100, &mut usage_bytes); // cache_write_tokens
        encode_u64(5, 800, &mut usage_bytes); // cache_read_tokens
        encode_u64(6, 24, &mut usage_bytes); // API_PROVIDER_GOOGLE_GEMINI
        encode_str(11, "resp_xyz_001", &mut usage_bytes);

        let mut csm_bytes = Vec::new();
        encode_bytes(4, &encode_timestamp(1776429002, 0), &mut csm_bytes);
        let mut cw_bytes = Vec::new();
        encode_u64(1, 45000, &mut cw_bytes);
        encode_u64(4, 1048576, &mut cw_bytes);
        encode_bytes(10, &cw_bytes, &mut csm_bytes);

        let mut chat_model_bytes = Vec::new();
        encode_u64(3, 1668, &mut chat_model_bytes);
        encode_bytes(4, &usage_bytes, &mut chat_model_bytes);
        encode_bytes(9, &csm_bytes, &mut chat_model_bytes);
        encode_bytes(11, &encode_timestamp(1, 200_000_000), &mut chat_model_bytes);
        encode_bytes(12, &encode_timestamp(3, 500_000_000), &mut chat_model_bytes);

        let mut gen_bytes = Vec::new();
        encode_bytes(1, &chat_model_bytes, &mut gen_bytes);
        encode_u64(2, 1, &mut gen_bytes);

        conn.execute(
            "INSERT INTO gen_metadata (idx, data) VALUES (0, ?1)",
            [&gen_bytes],
        )
        .unwrap();
        drop(conn);

        let cid = "11111111-2222-3333-4444-555555555555";
        let usage_json = extract_sqlite_usage_records_json(db_path_str, cid).expect("usage json");
        let parsed_usage: Value = serde_json::from_str(&usage_json).unwrap();
        let arr = parsed_usage.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["uncached"], 1200);
        assert_eq!(arr[0]["cacheRead"], 800);
        assert_eq!(arr[0]["cacheWrite"], 100);
        assert_eq!(arr[0]["output"], 350);
        assert_eq!(arr[0]["partial"], false);
        assert_eq!(arr[0]["timeBasis"], "request-start");
        assert_eq!(arr[0]["id"].as_str().unwrap().len(), 64);

        let traj_json = read_sqlite_trajectory_json(db_path_str, cid, true).expect("traj json");
        let parsed_traj: Value = serde_json::from_str(&traj_json).unwrap();
        assert_eq!(
            parsed_traj["trajectory"]["planModel"],
            "MODEL_PLACEHOLDER_M668"
        );
        assert_eq!(parsed_traj["trajectory"]["steps"][2]["type"], "CORTEX_STEP_TYPE_INVOKE_SUBAGENT");
        assert_eq!(
            parsed_traj["trajectory"]["steps"][2]["invokeSubagent"]["conversationId"],
            "99999999-8888-7777-6666-555555555555"
        );

        let meta_json = read_sqlite_conversation_meta_json(db_path_str, cid).expect("meta json");
        let parsed_meta: Value = serde_json::from_str(&meta_json).unwrap();
        assert_eq!(parsed_meta["stepCount"], 3);
        assert_eq!(parsed_meta["nestingDepth"], 2);
        assert_eq!(
            parsed_meta["parentConversationId"],
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );

        // 4. Budget limit check returns sentinel cleanly
        let over_budget = read_sqlite_trajectory_json_budgeted(db_path_str, cid, true, Some(64))
            .expect("budget sentinel");
        assert_eq!(over_budget, "{\"__budgetExceeded\":true}");

        // 5. Corrupt non-SQLite file must return None (never empty [])
        let corrupt_path = std::env::temp_dir().join(format!(
            "pulse_accel_corrupt_{}.db",
            std::process::id()
        ));
        std::fs::write(&corrupt_path, b"not-a-sqlite-file-at-all").unwrap();
        assert_eq!(
            extract_sqlite_usage_records_json(corrupt_path.to_str().unwrap(), cid),
            None
        );
        let _ = std::fs::remove_file(&corrupt_path);

        // 6. Deeply nested malformed protobuf must terminate cleanly at MAX_PROTO_DEPTH
        let mut deep_buf = vec![0x0B; 512]; // repeated WIRE_START_GROUP
        let mut p = 0;
        assert!(!crate::proto_wire::skip_field(&deep_buf, &mut p, crate::proto_wire::WIRE_START_GROUP));
        deep_buf.clear();
        for _ in 0..128 {
            let inner = deep_buf;
            deep_buf = Vec::new();
            encode_bytes(20, &inner, &mut deep_buf);
        }
        let _ = decode_step_payload(15, None, &deep_buf);

        let _ = std::fs::remove_file(&tmp_path);
    }

    #[test]
    fn test_vertex_and_evergreen_cache_providers() {
        for valid in [
            "API_PROVIDER_GOOGLE_GEMINI",
            "API_PROVIDER_GOOGLE_VERTEX",
            "API_PROVIDER_GOOGLE_EVERGREEN",
            "API_PROVIDER_ANTHROPIC_VERTEX",
            "API_PROVIDER_OPENAI_VERTEX",
            "API_PROVIDER_INTERNAL",
            "INTERNAL",
        ] {
            assert!(is_valid_cache_provider(Some(valid)), "expected {valid} to be valid");
        }
        for invalid in [
            "API_PROVIDER_UNSPECIFIED",
            "UNKNOWN",
            "CUSTOM_PROXY",
            "PRIVATE_OPENAI_TOKEN",
            "MY_GOOGLE_VERTEX",
            "",
        ] {
            assert!(!is_valid_cache_provider(Some(invalid)), "expected {invalid} to be invalid");
        }
        assert!(!is_valid_cache_provider(None));
    }
}
