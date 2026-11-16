use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;

const DEFAULT_CONTAINER_WIDTH_PX: f64 = 600.0;
const DEFAULT_MIN_PX_WIDTH: f64 = 1.5;
const DEFAULT_MAX_SEGMENTS: usize = 128;
const MIN_WIDTH_RATIO: f64 = 0.01;
const MIN_LEFT_PCT: f64 = 0.0;
const MAX_LEFT_PCT: f64 = 98.5;
const MIN_WIDTH_PCT: f64 = 1.5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwimlaneInputItem {
    #[serde(default)]
    pub index: Option<f64>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_label: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub start_ms: Option<f64>,
    #[serde(default)]
    pub end_ms: Option<f64>,
    #[serde(default)]
    pub start_ratio: Option<f64>,
    #[serde(default)]
    pub width_ratio: Option<f64>,
    #[serde(default)]
    pub step_start: Option<f64>,
    #[serde(default)]
    pub step_end: Option<f64>,
    #[serde(default)]
    pub step_count: Option<f64>,
    #[serde(default)]
    pub calls: Option<f64>,
    #[serde(default)]
    pub has_error: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoalesceSwimlanesInput {
    #[serde(default)]
    pub lanes: Vec<SwimlaneInputItem>,
    #[serde(default)]
    pub total_start_ms: Option<f64>,
    #[serde(default)]
    pub span_ms: Option<f64>,
    #[serde(default)]
    pub min_px_width: Option<f64>,
    #[serde(default)]
    pub container_width_px: Option<f64>,
    #[serde(default)]
    pub max_segments: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoalescedSwimlaneItem {
    pub index: usize,
    pub kind: &'static str,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_label: Option<String>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub start_ms: f64,
    pub end_ms: f64,
    pub start_ratio: f64,
    pub width_ratio: f64,
    pub left_pct: f64,
    pub width_pct: f64,
    pub step_start: u64,
    pub step_end: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_count: Option<u64>,
    pub calls: u64,
    pub has_error: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SwimlaneKindCounts {
    pub plan: usize,
    pub worker: usize,
    pub tool: usize,
    pub subagent: usize,
    pub handoff: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SwimlaneCoalesceSummary {
    pub input_count: usize,
    pub output_count: usize,
    pub merged_count: usize,
    pub total_calls: u64,
    pub error_count: usize,
    pub by_kind: SwimlaneKindCounts,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoalesceSwimlanesOutput {
    pub lanes: Vec<CoalescedSwimlaneItem>,
    pub total_start_ms: f64,
    pub span_ms: f64,
    pub summary: SwimlaneCoalesceSummary,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplinePointInput {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub val: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileCatmullRomInput {
    #[serde(default)]
    pub points: Vec<SplinePointInput>,
    pub baseline_y: f64,
    #[serde(default)]
    pub tension: Option<f64>,
    #[serde(default)]
    pub min_y: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompileCatmullRomOutput {
    pub path_d: String,
    pub area_d: String,
}

#[inline]
fn clamp01(v: f64) -> f64 {
    if !v.is_finite() {
        0.0
    } else if v <= 0.0 {
        0.0
    } else if v >= 1.0 {
        1.0
    } else {
        v
    }
}

#[inline]
fn round2(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    let sign = if v < 0.0 { -1.0 } else { 1.0 };
    let scaled = (v.abs() * 100.0).round();
    if scaled == 0.0 {
        0.0
    } else {
        (sign * scaled) / 100.0
    }
}

#[inline]
fn clean_opt_str(val: Option<String>) -> Option<String> {
    let s = val?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[inline]
fn parse_lane_kind(kind: Option<&str>, phase: Option<&str>) -> &'static str {
    for candidate in [kind, phase].into_iter().flatten() {
        match candidate.trim() {
            "plan" => return "plan",
            "worker" => return "worker",
            "tool" => return "tool",
            "subagent" => return "subagent",
            "handoff" => return "handoff",
            _ => {}
        }
    }
    "worker"
}

#[inline]
fn track_rank(kind: &str) -> usize {
    match kind {
        "plan" => 0,
        "worker" => 1,
        "tool" => 2,
        "subagent" => 3,
        "handoff" => 4,
        _ => 1,
    }
}

#[derive(Debug, Clone)]
struct WorkingLane {
    orig_index: usize,
    item: CoalescedSwimlaneItem,
}

fn recompute_ratios(item: &mut CoalescedSwimlaneItem, total_start_ms: f64, span_ms: f64) {
    let start_ratio = clamp01((item.start_ms - total_start_ms) / span_ms);
    let raw_width = clamp01((item.end_ms - item.start_ms) / span_ms);
    let width_ratio = if item.end_ms == item.start_ms && item.kind == "handoff" {
        MIN_WIDTH_RATIO
    } else {
        raw_width.max(MIN_WIDTH_RATIO)
    };
    let left_pct = round2((start_ratio * 100.0).clamp(MIN_LEFT_PCT, MAX_LEFT_PCT));
    let width_pct = round2((width_ratio * 100.0).max(MIN_WIDTH_PCT).min(100.0 - left_pct));
    item.start_ratio = start_ratio;
    item.width_ratio = width_ratio;
    item.left_pct = left_pct;
    item.width_pct = width_pct;
}

fn merge_into(
    prev: &mut CoalescedSwimlaneItem,
    curr: &CoalescedSwimlaneItem,
    total_start_ms: f64,
    span_ms: f64,
) {
    if curr.start_ms < prev.start_ms {
        prev.start_ms = curr.start_ms;
    }
    if curr.end_ms > prev.end_ms {
        prev.end_ms = curr.end_ms;
    }
    prev.step_start = prev.step_start.min(curr.step_start);
    prev.step_end = prev.step_end.max(curr.step_end);
    prev.calls = prev.calls.saturating_add(curr.calls);
    if prev.step_count.is_some() || curr.step_count.is_some() {
        prev.step_count = Some(
            prev.step_count
                .unwrap_or(0)
                .saturating_add(curr.step_count.unwrap_or(0)),
        );
    }
    prev.has_error = prev.has_error || curr.has_error;
    if prev.model != curr.model {
        prev.model = None;
        prev.model_label = Some("mixed".to_string());
        if prev.kind != "tool" {
            prev.label = "mixed".to_string();
        }
    } else if prev.model_label.is_none() && curr.model_label.is_some() {
        prev.model_label = curr.model_label.clone();
    }
    if prev.phase != curr.phase {
        prev.phase = None;
    }
    match (&prev.tool_name, &curr.tool_name) {
        (Some(a), Some(b)) if a != b => prev.tool_name = Some("mixed".to_string()),
        (None, Some(b)) => prev.tool_name = Some(b.clone()),
        _ => {}
    }
    if prev.kind == "tool"
        && prev.label.ends_with(" tools")
        && curr.label.ends_with(" tools")
    {
        prev.label = format!("{} tools", prev.calls);
    }
    recompute_ratios(prev, total_start_ms, span_ms);
}

#[inline]
fn f64_cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

fn to_non_neg_u64(v: Option<f64>) -> Option<u64> {
    v.filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n.floor() as u64)
}

pub fn coalesce_swimlanes(input: CoalesceSwimlanesInput) -> CoalesceSwimlanesOutput {
    let input_count = input.lanes.len();
    let container_width_px = input
        .container_width_px
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(DEFAULT_CONTAINER_WIDTH_PX);
    let min_px_width = input
        .min_px_width
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(DEFAULT_MIN_PX_WIDTH);
    let min_gap_ratio = clamp01(min_px_width / container_width_px);
    let max_segments = input
        .max_segments
        .filter(|v| v.is_finite() && *v >= 1.0)
        .map(|v| (v.floor() as usize).max(1))
        .unwrap_or(DEFAULT_MAX_SEGMENTS);

    let mut normalized: Vec<WorkingLane> = Vec::with_capacity(input_count);
    for (orig_index, raw) in input.lanes.into_iter().enumerate() {
        let phase = clean_opt_str(raw.phase);
        let kind = parse_lane_kind(raw.kind.as_deref(), phase.as_deref());
        let model = clean_opt_str(raw.model);
        let model_label = clean_opt_str(raw.model_label);
        let tool_name = clean_opt_str(raw.tool_name);
        let label = clean_opt_str(raw.label)
            .or_else(|| model_label.clone())
            .or_else(|| model.clone())
            .unwrap_or_else(|| kind.to_string());
        let start_ms = raw
            .start_ms
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(0.0);
        let end_ms = raw
            .end_ms
            .filter(|v| v.is_finite() && *v >= start_ms)
            .unwrap_or(start_ms);
        let step_start = to_non_neg_u64(raw.step_start).unwrap_or(0);
        let step_end = to_non_neg_u64(raw.step_end)
            .unwrap_or(step_start)
            .max(step_start);
        let step_count = to_non_neg_u64(raw.step_count);
        let calls = to_non_neg_u64(raw.calls).or(step_count).unwrap_or(1);
        let has_error = raw.has_error.unwrap_or(false);

        normalized.push(WorkingLane {
            orig_index: to_non_neg_u64(raw.index)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(orig_index),
            item: CoalescedSwimlaneItem {
                index: 0,
                kind,
                model,
                model_label,
                label,
                phase,
                tool_name,
                start_ms,
                end_ms,
                start_ratio: 0.0,
                width_ratio: MIN_WIDTH_RATIO,
                left_pct: 0.0,
                width_pct: MIN_WIDTH_PCT,
                step_start,
                step_end,
                step_count,
                calls,
                has_error,
            },
        });
    }

    let total_start_ms = input
        .total_start_ms
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| {
            normalized
                .iter()
                .map(|w| w.item.start_ms)
                .fold(f64::INFINITY, f64::min)
                .pipe_finite_or(0.0)
        });

    let span_ms = input
        .span_ms
        .filter(|v| v.is_finite())
        .map(|v| v.max(1.0))
        .unwrap_or_else(|| {
            if normalized.is_empty() {
                1.0
            } else {
                let max_end = normalized
                    .iter()
                    .map(|w| w.item.end_ms)
                    .fold(total_start_ms, f64::max);
                (max_end - total_start_ms).max(1.0)
            }
        });

    let mut tracks: [Vec<WorkingLane>; 5] = Default::default();
    for mut entry in normalized {
        recompute_ratios(&mut entry.item, total_start_ms, span_ms);
        tracks[track_rank(entry.item.kind)].push(entry);
    }

    let mut coalesced_tracks: [Vec<CoalescedSwimlaneItem>; 5] = Default::default();
    for (ti, track) in tracks.iter_mut().enumerate() {
        track.sort_by(|a, b| {
            f64_cmp(a.item.start_ms, b.item.start_ms)
                .then_with(|| f64_cmp(a.item.end_ms, b.item.end_ms))
                .then_with(|| a.item.step_start.cmp(&b.item.step_start))
                .then_with(|| a.orig_index.cmp(&b.orig_index))
        });

        let out_track = &mut coalesced_tracks[ti];
        let mut last_by_key: HashMap<(Option<String>, Option<String>), usize> = HashMap::new();
        for entry in track.iter() {
            let key = (entry.item.model.clone(), entry.item.phase.clone());
            let merge_idx = last_by_key.get(&key).copied().filter(|&idx| {
                let prev = &out_track[idx];
                (entry.item.start_ratio - (prev.start_ratio + prev.width_ratio).min(1.0))
                    <= min_gap_ratio
            });
            if let Some(idx) = merge_idx {
                merge_into(&mut out_track[idx], &entry.item, total_start_ms, span_ms);
            } else {
                let idx = out_track.len();
                out_track.push(entry.item.clone());
                last_by_key.insert(key, idx);
            }
        }
        out_track.sort_by(|a, b| {
            f64_cmp(a.start_ms, b.start_ms)
                .then_with(|| f64_cmp(a.end_ms, b.end_ms))
                .then_with(|| a.step_start.cmp(&b.step_start))
        });
    }

    loop {
        let total: usize = coalesced_tracks.iter().map(|t| t.len()).sum();
        if total <= max_segments {
            break;
        }
        let mut best_same: Option<(usize, usize, usize, f64)> = None;
        let mut best_any: Option<(usize, usize, f64)> = None;

        for (ti, track) in coalesced_tracks.iter().enumerate() {
            for i in 0..track.len() {
                let prev = &track[i];
                for j in (i + 1)..track.len() {
                    let curr = &track[j];
                    let gap = curr.start_ratio - (prev.start_ratio + prev.width_ratio).min(1.0);
                    if prev.model == curr.model && prev.phase == curr.phase {
                        if best_same.map_or(true, |(_, _, _, g)| gap < g) {
                            best_same = Some((ti, i, j, gap));
                        }
                        break;
                    }
                }
                if i + 1 < track.len() {
                    let curr = &track[i + 1];
                    let gap = curr.start_ratio - (prev.start_ratio + prev.width_ratio).min(1.0);
                    if best_any.map_or(true, |(_, _, g)| gap < g) {
                        best_any = Some((ti, i, gap));
                    }
                }
            }
        }

        if let Some((ti, idx, jdx, _)) = best_same {
            let curr = coalesced_tracks[ti].remove(jdx);
            merge_into(&mut coalesced_tracks[ti][idx], &curr, total_start_ms, span_ms);
        } else if let Some((ti, idx, _)) = best_any {
            let curr = coalesced_tracks[ti].remove(idx + 1);
            merge_into(&mut coalesced_tracks[ti][idx], &curr, total_start_ms, span_ms);
        } else {
            break;
        }
    }

    let mut out: Vec<CoalescedSwimlaneItem> = coalesced_tracks.into_iter().flatten().collect();
    out.sort_by(|a, b| {
        f64_cmp(a.start_ms, b.start_ms)
            .then_with(|| track_rank(a.kind).cmp(&track_rank(b.kind)))
            .then_with(|| f64_cmp(a.end_ms, b.end_ms))
            .then_with(|| a.step_start.cmp(&b.step_start))
    });

    let mut total_calls: u64 = 0;
    let mut error_count: usize = 0;
    let mut by_kind = SwimlaneKindCounts {
        plan: 0,
        worker: 0,
        tool: 0,
        subagent: 0,
        handoff: 0,
    };

    for (idx, item) in out.iter_mut().enumerate() {
        item.index = idx;
        total_calls = total_calls.saturating_add(item.calls);
        if item.has_error {
            error_count += 1;
        }
        match item.kind {
            "plan" => by_kind.plan += 1,
            "worker" => by_kind.worker += 1,
            "tool" => by_kind.tool += 1,
            "subagent" => by_kind.subagent += 1,
            "handoff" => by_kind.handoff += 1,
            _ => {}
        }
    }

    let output_count = out.len();
    let merged_count = input_count.saturating_sub(output_count);

    CoalesceSwimlanesOutput {
        lanes: out,
        total_start_ms,
        span_ms,
        summary: SwimlaneCoalesceSummary {
            input_count,
            output_count,
            merged_count,
            total_calls,
            error_count,
            by_kind,
        },
    }
}

trait PipeFinite {
    fn pipe_finite_or(self, fallback: f64) -> f64;
}

impl PipeFinite for f64 {
    fn pipe_finite_or(self, fallback: f64) -> f64 {
        if self.is_finite() {
            self
        } else {
            fallback
        }
    }
}

pub fn coalesce_swimlanes_json(input_json: &str) -> Result<String, String> {
    let input: CoalesceSwimlanesInput = serde_json::from_str(input_json)
        .map_err(|err| format!("invalid swimlane coalesce json: {err}"))?;
    let output = coalesce_swimlanes(input);
    serde_json::to_string(&output)
        .map_err(|err| format!("failed to serialize swimlane coalesce output: {err}"))
}

#[inline]
fn fmt1(v: f64) -> String {
    if !v.is_finite() {
        return "0.0".to_string();
    }
    let sign = if v < 0.0 { -1.0 } else { 1.0 };
    let scaled = (v.abs() * 10.0).round();
    let rounded = if scaled == 0.0 {
        0.0
    } else {
        (sign * scaled) / 10.0
    };
    format!("{rounded:.1}")
}

#[inline]
fn is_baseline_point(p: &SplinePointInput, baseline_y: f64) -> bool {
    match p.val {
        Some(v) => v == 0.0,
        None => (p.y - baseline_y).abs() <= 1e-9 || p.y >= baseline_y,
    }
}

pub fn compile_catmull_rom_svg_path(
    input: &CompileCatmullRomInput,
) -> Result<CompileCatmullRomOutput, String> {
    if !input.baseline_y.is_finite() {
        return Err("baselineY must be a finite number".to_string());
    }
    let baseline_y = input.baseline_y;
    let tension = input.tension.filter(|v| v.is_finite()).unwrap_or(0.5);
    let pts: Vec<&SplinePointInput> = input
        .points
        .iter()
        .filter(|p| p.x.is_finite() && p.y.is_finite())
        .collect();
    if pts.is_empty() {
        return Ok(CompileCatmullRomOutput {
            path_d: String::new(),
            area_d: String::new(),
        });
    }

    let min_y = input
        .min_y
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| pts.iter().map(|p| p.y).fold(baseline_y, f64::min));
    let lo = min_y.min(baseline_y);
    let hi = min_y.max(baseline_y);

    let n = pts.len();
    let mut path_d = String::with_capacity(n * 38);
    path_d.push_str("M ");
    path_d.push_str(&fmt1(pts[0].x));
    path_d.push(',');
    path_d.push_str(&fmt1(pts[0].y));

    for i in 0..n.saturating_sub(1) {
        let p0 = pts[i.saturating_sub(1)];
        let p1 = pts[i];
        let p2 = pts[i + 1];
        let p3 = pts[(i + 2).min(n - 1)];

        let cp1x = p1.x + ((p2.x - p0.x) * tension) / 3.0;
        let cp2x = p2.x - ((p3.x - p1.x) * tension) / 3.0;
        let mut cp1y = p1.y + ((p2.y - p0.y) * tension) / 3.0;
        let mut cp2y = p2.y - ((p3.y - p1.y) * tension) / 3.0;

        let p1_zero = is_baseline_point(p1, baseline_y);
        let p2_zero = is_baseline_point(p2, baseline_y);
        if p1_zero && p2_zero {
            cp1y = baseline_y;
            cp2y = baseline_y;
        } else {
            if p1_zero {
                cp1y = baseline_y;
            }
            if p2_zero {
                cp2y = baseline_y;
            }
            cp1y = cp1y.min(hi).max(lo);
            cp2y = cp2y.min(hi).max(lo);
        }

        path_d.push_str(" C ");
        path_d.push_str(&fmt1(cp1x));
        path_d.push(',');
        path_d.push_str(&fmt1(cp1y));
        path_d.push(' ');
        path_d.push_str(&fmt1(cp2x));
        path_d.push(',');
        path_d.push_str(&fmt1(cp2y));
        path_d.push(' ');
        path_d.push_str(&fmt1(p2.x));
        path_d.push(',');
        path_d.push_str(&fmt1(p2.y));
    }

    let first = pts[0];
    let last = pts[n - 1];
    let base_s = fmt1(baseline_y);
    let area_d = format!(
        "{path_d} L {},{base_s} L {},{base_s} Z",
        fmt1(last.x),
        fmt1(first.x),
    );

    Ok(CompileCatmullRomOutput { path_d, area_d })
}

pub fn compile_catmull_rom_svg_path_json(input_json: &str) -> Result<String, String> {
    let input: CompileCatmullRomInput = serde_json::from_str(input_json)
        .map_err(|err| format!("invalid spline json: {err}"))?;
    let output = compile_catmull_rom_svg_path(&input)?;
    serde_json::to_string(&output)
        .map_err(|err| format!("failed to serialize spline output: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesce_handles_empty_and_zero_span() {
        let empty_json = coalesce_swimlanes_json(r#"{"lanes":[]}"#).unwrap();
        let empty: serde_json::Value = serde_json::from_str(&empty_json).unwrap();
        assert_eq!(empty["lanes"].as_array().unwrap().len(), 0);
        assert_eq!(empty["spanMs"], 1.0);
        assert_eq!(empty["summary"]["inputCount"], 0);
        assert_eq!(empty["summary"]["outputCount"], 0);

        let zero_span_json = coalesce_swimlanes_json(
            r#"{
                "totalStartMs": 1000,
                "spanMs": 0,
                "lanes": [
                    {"kind":"worker","model":"Flash","startMs":1000,"endMs":1000,"stepStart":1,"stepEnd":1,"calls":1},
                    {"kind":"worker","model":"Flash","startMs":1000,"endMs":1000,"stepStart":2,"stepEnd":2,"calls":2},
                    {"kind":"handoff","model":"Pro","label":"Flash -> Pro","startMs":1000,"endMs":1000,"stepStart":3,"stepEnd":3,"calls":1}
                ]
            }"#,
        )
        .unwrap();
        let zero: serde_json::Value = serde_json::from_str(&zero_span_json).unwrap();
        assert_eq!(zero["spanMs"], 1.0);
        assert_eq!(zero["summary"]["inputCount"], 3);
        assert_eq!(zero["summary"]["outputCount"], 2);
        assert_eq!(zero["summary"]["mergedCount"], 1);
        assert_eq!(zero["lanes"][0]["calls"], 3);
        assert_eq!(zero["lanes"][0]["leftPct"], 0.0);
        assert_eq!(zero["lanes"][0]["widthPct"], 1.5);
    }

    #[test]
    fn coalesce_merges_tiny_segments_and_subpixel_gaps_without_cross_model_merge() {
        let json = coalesce_swimlanes_json(
            r#"{
                "totalStartMs": 0,
                "spanMs": 10000,
                "minPxWidth": 1.5,
                "containerWidthPx": 600,
                "lanes": [
                    {"kind":"tool","model":"Flash","label":"2 tools","toolName":"read_file","startMs":0,"endMs":5,"stepStart":1,"stepEnd":2,"calls":2,"stepCount":2,"hasError":false},
                    {"kind":"tool","model":"Flash","label":"3 tools","toolName":"edit_file","startMs":40,"endMs":50,"stepStart":3,"stepEnd":4,"calls":3,"stepCount":3,"hasError":true},
                    {"kind":"tool","model":"Flash","label":"1 tools","toolName":"read_file","startMs":5000,"endMs":6000,"stepStart":10,"stepEnd":10,"calls":1,"stepCount":1,"hasError":false},
                    {"kind":"tool","model":"Pro","label":"1 tools","toolName":"grep","startMs":10,"endMs":20,"stepStart":5,"stepEnd":5,"calls":1}
                ]
            }"#,
        )
        .unwrap();
        let out: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(out["summary"]["inputCount"], 4);
        assert_eq!(out["summary"]["outputCount"], 3);
        assert_eq!(out["summary"]["mergedCount"], 1);
        assert_eq!(out["summary"]["totalCalls"], 7);
        assert_eq!(out["summary"]["errorCount"], 1);

        let first = &out["lanes"][0];
        assert_eq!(first["model"], "Flash");
        assert_eq!(first["label"], "5 tools");
        assert_eq!(first["toolName"], "mixed");
        assert_eq!(first["stepStart"], 1);
        assert_eq!(first["stepEnd"], 4);
        assert_eq!(first["stepCount"], 5);
        assert_eq!(first["calls"], 5);
        assert_eq!(first["hasError"], true);
        assert_eq!(first["endMs"], 50.0);
    }

    #[test]
    fn spline_edge_cases_zero_one_two_and_multipoint_clamping() {
        let empty: CompileCatmullRomOutput =
            serde_json::from_str(&compile_catmull_rom_svg_path_json(r#"{"points":[],"baselineY":105}"#).unwrap()).unwrap();
        assert_eq!(empty.path_d, "");
        assert_eq!(empty.area_d, "");

        let single: serde_json::Value = serde_json::from_str(
            &compile_catmull_rom_svg_path_json(r#"{"points":[{"x":40,"y":60}],"baselineY":105}"#).unwrap(),
        )
        .unwrap();
        assert_eq!(single["pathD"], "M 40.0,60.0");
        assert_eq!(single["areaD"], "M 40.0,60.0 L 40.0,105.0 L 40.0,105.0 Z");

        let two: serde_json::Value = serde_json::from_str(
            &compile_catmull_rom_svg_path_json(r#"{"points":[{"x":40,"y":105,"val":0},{"x":600,"y":15,"val":100}],"baselineY":105,"minY":15}"#).unwrap(),
        )
        .unwrap();
        assert_eq!(two["pathD"], "M 40.0,105.0 C 133.3,105.0 506.7,30.0 600.0,15.0");
        assert_eq!(
            two["areaD"],
            "M 40.0,105.0 C 133.3,105.0 506.7,30.0 600.0,15.0 L 600.0,105.0 L 40.0,105.0 Z"
        );

        let multi: serde_json::Value = serde_json::from_str(
            &compile_catmull_rom_svg_path_json(
                r#"{"points":[{"x":40,"y":105},{"x":100,"y":15},{"x":160,"y":15},{"x":220,"y":105}],"baselineY":105,"tension":0.5,"minY":15}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let path_d = multi["pathD"].as_str().unwrap();
        assert!(path_d.starts_with("M 40.0,105.0 C "));
        // Control points between the two plateau peaks at y=15 must stay clamped >= 15.0
        for token in path_d.split_whitespace() {
            if let Some((_, y_str)) = token.split_once(',') {
                let y_val: f64 = y_str.parse().unwrap();
                assert!(
                    (15.0..=105.0).contains(&y_val),
                    "y coordinate out of [15.0, 105.0] bounds: {y_val} in {path_d}"
                );
            }
        }
    }
}
