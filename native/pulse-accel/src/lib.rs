pub mod enums;
pub mod json_projector;
pub mod ledger_index;
pub mod log_rotator;
pub mod napi_entry;
pub mod proto_wire;
pub mod sanitizer_accel;
pub mod shared_cache;
pub mod snapshot_diff;
pub mod sqlite_trajectory;
pub mod svg_compiler;
pub mod transcript_scan;
pub mod win32_discovery;

pub use json_projector::project_trajectory_json;
pub use ledger_index::query_usage_ledger_summary_json;
pub use log_rotator::{rotate_log_tail, rotate_log_tail_json};
pub use sanitizer_accel::{audit_open_source_privacy_json, sync_and_audit_open_source_json};
pub use snapshot_diff::diff_session_snapshots_json;
pub use sqlite_trajectory::{
    extract_sqlite_usage_records_json, read_sqlite_conversation_meta_json,
    read_sqlite_trajectory_json,
};
pub use svg_compiler::{coalesce_swimlanes_json, compile_catmull_rom_svg_path_json};
pub use transcript_scan::scan_transcript_file_json;
pub use win32_discovery::discover_win32_processes_json;
