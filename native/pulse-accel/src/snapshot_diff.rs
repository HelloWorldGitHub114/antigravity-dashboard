use serde::{Deserialize, Serialize};

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;
const FIELD_DELIMITER: [u8; 1] = [0xff];

const RUNNING_KEYWORDS: [&[u8]; 4] = [b"RUNNING", b"GENERATING", b"WAITING", b"QUEUED"];
const SETTLED_KEYWORDS: [&[u8]; 8] = [
    b"IDLE",
    b"DONE",
    b"COMPLETED",
    b"CANCELLED",
    b"CANCELED",
    b"STOPPED",
    b"FAILED",
    b"ERROR",
];

fn default_last_user_input_step_index() -> i32 {
    -1
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptorInput {
    pub cascade_id: String,
    #[serde(default)]
    pub mtime_ms: i64,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub step_count: i32,
    #[serde(default = "default_last_user_input_step_index")]
    pub last_user_input_step_index: i32,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub prev_fingerprint: Option<String>,
    #[serde(default)]
    pub prev_settled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiffItem {
    pub cascade_id: String,
    pub fingerprint: String,
    pub status_kind: &'static str,
    pub transition: &'static str,
    pub needs_poll: bool,
    pub prefer_sqlite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDiffOutput {
    pub dirty_ids: Vec<String>,
    pub newly_settled_ids: Vec<String>,
    pub running_ids: Vec<String>,
    pub items: Vec<SessionDiffItem>,
}

#[inline]
fn fnv1a_update(hash: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *hash ^= b as u64;
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

pub fn compute_session_fingerprint_u64(
    mtime_ms: i64,
    size_bytes: u64,
    step_count: i32,
    last_user_input_step_index: i32,
    status: &str,
) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    fnv1a_update(&mut hash, &mtime_ms.to_le_bytes());
    fnv1a_update(&mut hash, &FIELD_DELIMITER);
    fnv1a_update(&mut hash, &size_bytes.to_le_bytes());
    fnv1a_update(&mut hash, &FIELD_DELIMITER);
    fnv1a_update(&mut hash, &step_count.to_le_bytes());
    fnv1a_update(&mut hash, &FIELD_DELIMITER);
    fnv1a_update(&mut hash, &last_user_input_step_index.to_le_bytes());
    fnv1a_update(&mut hash, &FIELD_DELIMITER);
    let status_bytes = status.as_bytes();
    fnv1a_update(&mut hash, &(status_bytes.len() as u32).to_le_bytes());
    fnv1a_update(&mut hash, status_bytes);
    hash
}

pub fn compute_session_fingerprint_hex(
    mtime_ms: i64,
    size_bytes: u64,
    step_count: i32,
    last_user_input_step_index: i32,
    status: &str,
) -> String {
    let hash = compute_session_fingerprint_u64(
        mtime_ms,
        size_bytes,
        step_count,
        last_user_input_step_index,
        status,
    );
    format!("{:016x}", hash)
}

#[inline]
fn contains_ascii_ci(haystack: &[u8], needle_upper: &[u8]) -> bool {
    if needle_upper.is_empty() || haystack.len() < needle_upper.len() {
        return false;
    }
    haystack
        .windows(needle_upper.len())
        .any(|win| win.iter().zip(needle_upper).all(|(a, b)| a.to_ascii_uppercase() == *b))
}

#[inline]
fn classify_status(status: &str) -> &'static str {
    let bytes = status.as_bytes();
    if RUNNING_KEYWORDS.iter().any(|kw| contains_ascii_ci(bytes, kw)) {
        return "running";
    }
    if SETTLED_KEYWORDS.iter().any(|kw| contains_ascii_ci(bytes, kw)) {
        return "settled";
    }
    "unknown"
}

pub fn diff_session_snapshots(inputs: &[SessionDescriptorInput]) -> SnapshotDiffOutput {
    let mut dirty_ids = Vec::new();
    let mut newly_settled_ids = Vec::new();
    let mut running_ids = Vec::new();
    let mut items = Vec::with_capacity(inputs.len());

    for input in inputs {
        let fp_hex = compute_session_fingerprint_hex(
            input.mtime_ms,
            input.size_bytes,
            input.step_count,
            input.last_user_input_step_index,
            &input.status,
        );
        let status_kind = classify_status(&input.status);
        let is_running = status_kind == "running";
        let is_settled = status_kind == "settled";
        let fp_changed = input.prev_fingerprint.as_deref() != Some(fp_hex.as_str());

        let transition = if input.prev_fingerprint.is_none() {
            "newly_discovered"
        } else if input.prev_settled == Some(false) && is_settled {
            "newly_settled"
        } else if fp_changed {
            "modified"
        } else {
            "unchanged"
        };

        let needs_poll = is_running || fp_changed;
        let prefer_sqlite = input.size_bytes > 0 && !is_running;

        if is_running {
            running_ids.push(input.cascade_id.clone());
        }
        if transition == "newly_settled" {
            newly_settled_ids.push(input.cascade_id.clone());
        }
        if needs_poll || transition == "newly_settled" {
            dirty_ids.push(input.cascade_id.clone());
        }

        items.push(SessionDiffItem {
            cascade_id: input.cascade_id.clone(),
            fingerprint: fp_hex,
            status_kind,
            transition,
            needs_poll,
            prefer_sqlite,
        });
    }

    SnapshotDiffOutput {
        dirty_ids,
        newly_settled_ids,
        running_ids,
        items,
    }
}

pub fn diff_session_snapshots_json(inputs_json: &str) -> Option<String> {
    let inputs: Vec<SessionDescriptorInput> = serde_json::from_str(inputs_json).ok()?;
    let output = diff_session_snapshots(&inputs);
    serde_json::to_string(&output).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_input(cascade_id: &str, status: &str) -> SessionDescriptorInput {
        SessionDescriptorInput {
            cascade_id: cascade_id.to_string(),
            mtime_ms: 1_763_300_000_123,
            size_bytes: 4096,
            step_count: 12,
            last_user_input_step_index: 8,
            status: status.to_string(),
            prev_fingerprint: None,
            prev_settled: None,
        }
    }

    #[test]
    fn fingerprint_is_16_char_lowercase_hex_and_sensitive_to_every_field() {
        let base = compute_session_fingerprint_hex(1_763_300_000_123, 4096, 12, 8, "CASCADE_RUN_STATUS_IDLE");
        assert_eq!(base.len(), 16);
        assert!(base.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));

        // Verify the JSON output keeps fingerprint as a string (never truncated float).
        let json = diff_session_snapshots_json(
            r#"[{"cascadeId":"c1","mtimeMs":1763300000123,"sizeBytes":4096,"stepCount":12,"lastUserInputStepIndex":8,"status":"CASCADE_RUN_STATUS_IDLE"}]"#,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed["items"][0]["fingerprint"].is_string());
        assert_eq!(parsed["items"][0]["fingerprint"].as_str(), Some(base.as_str()));

        // Mutating any single field changes the fingerprint.
        assert_ne!(
            base,
            compute_session_fingerprint_hex(1_763_300_000_124, 4096, 12, 8, "CASCADE_RUN_STATUS_IDLE")
        );
        assert_ne!(
            base,
            compute_session_fingerprint_hex(1_763_300_000_123, 4097, 12, 8, "CASCADE_RUN_STATUS_IDLE")
        );
        assert_ne!(
            base,
            compute_session_fingerprint_hex(1_763_300_000_123, 4096, 13, 8, "CASCADE_RUN_STATUS_IDLE")
        );
        assert_ne!(
            base,
            compute_session_fingerprint_hex(1_763_300_000_123, 4096, 12, 9, "CASCADE_RUN_STATUS_IDLE")
        );
        assert_ne!(
            base,
            compute_session_fingerprint_hex(1_763_300_000_123, 4096, 12, 8, "CASCADE_RUN_STATUS_RUNNING")
        );
    }

    #[test]
    fn status_classification_covers_all_running_settled_and_unknown_variants() {
        for running in [
            "CASCADE_RUN_STATUS_RUNNING",
            "generating",
            "WAITING_FOR_USER",
            "queued_task",
            "RUNNING_AND_DONE",
        ] {
            assert_eq!(classify_status(running), "running", "expected running for {running}");
        }
        for settled in [
            "CASCADE_RUN_STATUS_IDLE",
            "done",
            "COMPLETED",
            "CANCELLED",
            "canceled",
            "STOPPED",
            "FAILED",
            "ERROR",
        ] {
            assert_eq!(classify_status(settled), "settled", "expected settled for {settled}");
        }
        for unknown in ["", "CASCADE_RUN_STATUS_UNSPECIFIED", "PAUSED"] {
            assert_eq!(classify_status(unknown), "unknown", "expected unknown for {unknown}");
        }
    }

    #[test]
    fn transitions_dirty_sets_and_prefer_sqlite_are_exact() {
        let mut s_new = make_input("id-new", "CASCADE_RUN_STATUS_IDLE");
        s_new.size_bytes = 0;

        let s_unchanged_idle_fp =
            compute_session_fingerprint_hex(1_763_300_000_123, 4096, 12, 8, "CASCADE_RUN_STATUS_IDLE");
        let mut s_unchanged = make_input("id-unchanged", "CASCADE_RUN_STATUS_IDLE");
        s_unchanged.prev_fingerprint = Some(s_unchanged_idle_fp.clone());
        s_unchanged.prev_settled = Some(true);

        let mut s_modified = make_input("id-modified", "CASCADE_RUN_STATUS_IDLE");
        s_modified.step_count = 15;
        s_modified.prev_fingerprint = Some(s_unchanged_idle_fp.clone());
        s_modified.prev_settled = Some(true);

        let mut s_newly_settled = make_input("id-settled", "CASCADE_RUN_STATUS_COMPLETED");
        s_newly_settled.prev_fingerprint = Some("0123456789abcdef".to_string());
        s_newly_settled.prev_settled = Some(false);

        let s_running_fp =
            compute_session_fingerprint_hex(1_763_300_000_123, 4096, 12, 8, "CASCADE_RUN_STATUS_RUNNING");
        let mut s_running = make_input("id-running", "CASCADE_RUN_STATUS_RUNNING");
        s_running.prev_fingerprint = Some(s_running_fp);
        s_running.prev_settled = Some(false);

        let out = diff_session_snapshots(&[s_new, s_unchanged, s_modified, s_newly_settled, s_running]);

        assert_eq!(out.items[0].transition, "newly_discovered");
        assert!(out.items[0].needs_poll);
        assert!(!out.items[0].prefer_sqlite); // size_bytes == 0

        assert_eq!(out.items[1].transition, "unchanged");
        assert!(!out.items[1].needs_poll);
        assert!(out.items[1].prefer_sqlite);

        assert_eq!(out.items[2].transition, "modified");
        assert!(out.items[2].needs_poll);
        assert!(out.items[2].prefer_sqlite);

        assert_eq!(out.items[3].transition, "newly_settled");
        assert!(out.items[3].needs_poll);
        assert!(out.items[3].prefer_sqlite);

        assert_eq!(out.items[4].transition, "unchanged");
        assert!(out.items[4].needs_poll); // running always needs poll
        assert!(!out.items[4].prefer_sqlite); // running never prefers sqlite bypass

        assert_eq!(
            out.dirty_ids,
            vec!["id-new", "id-modified", "id-settled", "id-running"]
        );
        assert_eq!(out.newly_settled_ids, vec!["id-settled"]);
        assert_eq!(out.running_ids, vec!["id-running"]);
    }

    #[test]
    fn invalid_or_empty_json_handled_safely() {
        assert!(diff_session_snapshots_json("{bad json").is_none());
        let empty = diff_session_snapshots_json("[]").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&empty).unwrap();
        assert_eq!(parsed["items"].as_array().unwrap().len(), 0);
        assert_eq!(parsed["dirtyIds"].as_array().unwrap().len(), 0);
    }
}
