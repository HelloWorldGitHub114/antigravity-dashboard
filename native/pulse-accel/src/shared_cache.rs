use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags};

pub const SHARED_CACHE_FILENAME: &str = "shared-usage-cache-v1.db";
const SHARED_CACHE_SUBDIR: &str = "antigravity-pulse";
const CACHE_BUSY_TIMEOUT_MS: u64 = 3000;
const SHARED_CACHE_USER_VERSION: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TrajectoryFileStamp {
    pub(crate) db_mtime_ms: i64,
    pub(crate) db_size_bytes: i64,
    pub(crate) wal_mtime_ms: i64,
    pub(crate) wal_size_bytes: i64,
}

/// Returns `true` when `PULSE_DISABLE_SHARED_CACHE` is set to `"1"` or `"true"`.
pub fn is_shared_cache_disabled() -> bool {
    match std::env::var("PULSE_DISABLE_SHARED_CACHE") {
        Ok(val) => {
            let trimmed = val.trim();
            trimmed == "1" || trimmed.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

fn explicit_shared_cache_path() -> Option<PathBuf> {
    let val = std::env::var("PULSE_SHARED_CACHE_PATH").ok()?;
    let trimmed = val.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn lexically_normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    out.components().next_back(),
                    None | Some(Component::Prefix(_)) | Some(Component::RootDir)
                ) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn normalize_path_for_prefix_check(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let lex = lexically_normalize_path(Path::new(stripped));
    let lex_str = lex.to_string_lossy();
    #[cfg(windows)]
    let normalized = lex_str.replace('/', "\\").to_ascii_lowercase();
    #[cfg(not(windows))]
    let normalized = lex_str.into_owned();
    PathBuf::from(normalized)
}

/// Returns `true` if `path` resides inside `std::env::temp_dir()`.
pub fn is_inside_temp_dir(path: &Path) -> bool {
    let temp = std::env::temp_dir();
    let mut temp_roots = vec![normalize_path_for_prefix_check(&temp)];
    if let Ok(canon_temp) = fs::canonicalize(&temp) {
        let norm = normalize_path_for_prefix_check(&canon_temp);
        if !temp_roots.contains(&norm) {
            temp_roots.push(norm);
        }
    }

    let mut candidates = Vec::new();
    let abs_path = if path.is_relative() {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    candidates.push(normalize_path_for_prefix_check(&abs_path));

    if let Ok(canon) = fs::canonicalize(&abs_path) {
        candidates.push(normalize_path_for_prefix_check(&canon));
    } else if let Some(parent) = abs_path.parent() {
        if let Ok(canon_parent) = fs::canonicalize(parent) {
            let joined = match abs_path.file_name() {
                Some(name) => canon_parent.join(name),
                None => canon_parent,
            };
            candidates.push(normalize_path_for_prefix_check(&joined));
        }
    }

    candidates
        .iter()
        .any(|cand| temp_roots.iter().any(|root| cand.starts_with(root)))
}

fn non_empty_env_path(key: &str) -> Option<PathBuf> {
    let val = std::env::var(key).ok()?;
    let trimmed = val.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn shared_base_home() -> Option<PathBuf> {
    let home = non_empty_env_path("HOME").or_else(|| non_empty_env_path("USERPROFILE"))?;
    let is_vertex_home = home.file_name().and_then(|s| s.to_str()) == Some("home")
        && home
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            == Some(".antigravity-vertex");
    if is_vertex_home {
        if let Some(root_home) = home.parent().and_then(|p| p.parent()) {
            return Some(root_home.to_path_buf());
        }
    }
    Some(home)
}

fn default_shared_cache_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = non_empty_env_path("LOCALAPPDATA") {
            return Some(local.join(SHARED_CACHE_SUBDIR));
        }
        let home = shared_base_home()?;
        return Some(home.join("AppData").join("Local").join(SHARED_CACHE_SUBDIR));
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(xdg) = non_empty_env_path("XDG_CACHE_HOME") {
            return Some(xdg.join(SHARED_CACHE_SUBDIR));
        }
        let home = shared_base_home()?;
        return Some(home.join("Library").join("Caches").join(SHARED_CACHE_SUBDIR));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = non_empty_env_path("XDG_CACHE_HOME") {
            return Some(xdg.join(SHARED_CACHE_SUBDIR));
        }
        let home = shared_base_home()?;
        return Some(home.join(".cache").join(SHARED_CACHE_SUBDIR));
    }
}

/// Resolves the shared cache SQLite path for a trajectory `db_path`, returning `None`
/// when caching is disabled or bypassed by the `temp_dir` isolation guard.
pub fn resolve_shared_cache_path(db_path: &Path) -> Option<PathBuf> {
    if is_shared_cache_disabled() {
        return None;
    }
    if let Some(explicit) = explicit_shared_cache_path() {
        return Some(explicit);
    }
    if is_inside_temp_dir(db_path) {
        return None;
    }
    Some(default_shared_cache_dir()?.join(SHARED_CACHE_FILENAME))
}

fn companion_wal_path(db_path: &Path) -> PathBuf {
    let mut os: OsString = db_path.as_os_str().to_os_string();
    os.push("-wal");
    PathBuf::from(os)
}

fn metadata_mtime_ms(meta: &fs::Metadata) -> Option<i64> {
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(dur.as_millis()).ok()
}

pub(crate) fn stat_trajectory_files(db_path: &Path) -> Option<TrajectoryFileStamp> {
    let db_meta = fs::metadata(db_path).ok()?;
    if !db_meta.is_file() {
        return None;
    }
    let db_mtime_ms = metadata_mtime_ms(&db_meta)?;
    let db_size_bytes = i64::try_from(db_meta.len()).ok()?;

    let wal_path = companion_wal_path(db_path);
    let (wal_mtime_ms, wal_size_bytes) = match fs::metadata(&wal_path) {
        Ok(wal_meta) if wal_meta.is_file() => (
            metadata_mtime_ms(&wal_meta).unwrap_or(0),
            i64::try_from(wal_meta.len()).unwrap_or(0),
        ),
        _ => (0, 0),
    };

    Some(TrajectoryFileStamp {
        db_mtime_ms,
        db_size_bytes,
        wal_mtime_ms,
        wal_size_bytes,
    })
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn open_cache_read_conn(cache_path: &Path) -> Option<Connection> {
    if !cache_path.is_file() {
        return None;
    }
    let ro_flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match Connection::open_with_flags(cache_path, ro_flags) {
        Ok(c) => c,
        Err(_) => {
            let rw_flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
            Connection::open_with_flags(cache_path, rw_flags).ok()?
        }
    };
    let _ = conn.busy_timeout(Duration::from_millis(CACHE_BUSY_TIMEOUT_MS));
    Some(conn)
}

fn open_cache_write_conn(cache_path: &Path) -> Option<Connection> {
    if let Some(parent) = cache_path.parent() {
        if !parent.as_os_str().is_empty() && fs::create_dir_all(parent).is_err() {
            return None;
        }
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(cache_path, flags).ok()?;
    conn.busy_timeout(Duration::from_millis(CACHE_BUSY_TIMEOUT_MS))
        .ok()?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 3000;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS usage_cache (
             db_path TEXT PRIMARY KEY,
             db_mtime_ms INTEGER NOT NULL,
             db_size_bytes INTEGER NOT NULL,
             wal_mtime_ms INTEGER NOT NULL,
             wal_size_bytes INTEGER NOT NULL,
             payload_json TEXT NOT NULL,
             updated_at_ms INTEGER NOT NULL
         );",
    )
    .ok()?;
    let user_ver: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if user_ver < SHARED_CACHE_USER_VERSION {
        conn.execute_batch(&format!(
            "DELETE FROM usage_cache; PRAGMA user_version = {SHARED_CACHE_USER_VERSION};"
        ))
        .ok()?;
    }
    Some(conn)
}

/// Looks up cached usage JSON for `db_path`, returning `Some(payload_json)` only when
/// `db_mtime_ms`, `db_size_bytes`, `wal_mtime_ms`, and `wal_size_bytes` all match identically.
pub fn lookup_cached_usage(db_path: &str) -> Option<String> {
    let target = Path::new(db_path);
    let cache_path = resolve_shared_cache_path(target)?;
    let stamp = stat_trajectory_files(target)?;
    let conn = open_cache_read_conn(&cache_path)?;
    let user_ver: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).ok()?;
    if user_ver < SHARED_CACHE_USER_VERSION {
        return None;
    }

    let mut stmt = conn
        .prepare(
            "SELECT db_mtime_ms, db_size_bytes, wal_mtime_ms, wal_size_bytes, payload_json
             FROM usage_cache
             WHERE db_path = ?1
             LIMIT 1",
        )
        .ok()?;
    let row = stmt
        .query_row([db_path], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .ok()?;

    if row.0 == stamp.db_mtime_ms
        && row.1 == stamp.db_size_bytes
        && row.2 == stamp.wal_mtime_ms
        && row.3 == stamp.wal_size_bytes
    {
        Some(row.4)
    } else {
        None
    }
}

/// Best-effort upsert of extracted usage JSON using a pre-read file stamp so
/// concurrent writes between reading and caching never stamp stale data.
pub(crate) fn store_cached_usage_with_stamp(
    db_path: &str,
    expected_stamp: &TrajectoryFileStamp,
    payload_json: &str,
) -> bool {
    let target = Path::new(db_path);
    let Some(cache_path) = resolve_shared_cache_path(target) else {
        return false;
    };
    let Some(stamp_after) = stat_trajectory_files(target) else {
        return false;
    };
    if &stamp_after != expected_stamp {
        return false;
    }
    let Some(conn) = open_cache_write_conn(&cache_path) else {
        return false;
    };

    let updated_at_ms = now_epoch_ms();
    conn.execute(
        "INSERT INTO usage_cache (
             db_path, db_mtime_ms, db_size_bytes, wal_mtime_ms, wal_size_bytes, payload_json, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(db_path) DO UPDATE SET
             db_mtime_ms = excluded.db_mtime_ms,
             db_size_bytes = excluded.db_size_bytes,
             wal_mtime_ms = excluded.wal_mtime_ms,
             wal_size_bytes = excluded.wal_size_bytes,
             payload_json = excluded.payload_json,
             updated_at_ms = excluded.updated_at_ms",
        params![
            db_path,
            expected_stamp.db_mtime_ms,
            expected_stamp.db_size_bytes,
            expected_stamp.wal_mtime_ms,
            expected_stamp.wal_size_bytes,
            payload_json,
            updated_at_ms
        ],
    )
    .is_ok()
}

/// Best-effort upsert of extracted usage JSON and `(db, wal)` file metadata into the shared cache.
pub fn store_cached_usage(db_path: &str, payload_json: &str) -> bool {
    let Some(stamp) = stat_trajectory_files(Path::new(db_path)) else {
        return false;
    };
    store_cached_usage_with_stamp(db_path, &stamp, payload_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    struct EnvVarGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvVarGuard {
        fn capture(keys: &[&'static str]) -> Self {
            let saved = keys
                .iter()
                .map(|&k| (k, std::env::var_os(k)))
                .collect();
            Self { saved }
        }

        fn set(&self, key: &'static str, val: Option<&str>) {
            match val {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(prev) => std::env::set_var(k, prev),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    fn make_temp_dir(label: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "pulse-shared-cache-{label}-{}-{seq}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn test_cache_miss_populate_and_hit() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = EnvVarGuard::capture(&["PULSE_SHARED_CACHE_PATH", "PULSE_DISABLE_SHARED_CACHE"]);

        let dir = make_temp_dir("hit");
        let db_path = dir.join("conv-1.db");
        fs::write(&db_path, b"sqlite-fixture-bytes").expect("write fixture");
        let cache_path = dir.join("shared-usage-cache-v1.db");

        env.set("PULSE_DISABLE_SHARED_CACHE", None);
        env.set("PULSE_SHARED_CACHE_PATH", Some(cache_path.to_str().unwrap()));

        let db_str = db_path.to_str().unwrap();
        assert_eq!(lookup_cached_usage(db_str), None);
        assert!(!cache_path.exists(), "miss must not create empty cache db");

        let payload = r#"[{"id":"r1","uncached":100}]"#;
        assert!(store_cached_usage(db_str, payload));
        assert!(cache_path.exists());
        assert_eq!(lookup_cached_usage(db_str).as_deref(), Some(payload));

        // Overwrite cached payload without changing source file stats to prove cache hit.
        let conn = Connection::open(&cache_path).expect("open cache db");
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("journal_mode");
        assert_eq!(mode.to_ascii_lowercase(), "wal");
        conn.execute(
            "UPDATE usage_cache SET payload_json = ?1 WHERE db_path = ?2",
            params![r#"[{"id":"cached-sentinel"}]"#, db_str],
        )
        .expect("update sentinel");
        drop(conn);

        assert_eq!(
            lookup_cached_usage(db_str).as_deref(),
            Some(r#"[{"id":"cached-sentinel"}]"#)
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_wal_append_invalidates_cache() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = EnvVarGuard::capture(&["PULSE_SHARED_CACHE_PATH", "PULSE_DISABLE_SHARED_CACHE"]);

        let dir = make_temp_dir("wal");
        let db_path = dir.join("conv-wal.db");
        fs::write(&db_path, b"base-db-content").expect("write base db");
        let cache_path = dir.join("shared-usage-cache-v1.db");

        env.set("PULSE_DISABLE_SHARED_CACHE", None);
        env.set("PULSE_SHARED_CACHE_PATH", Some(cache_path.to_str().unwrap()));

        let db_str = db_path.to_str().unwrap();
        assert!(store_cached_usage(db_str, r#"[{"id":"v1"}]"#));
        assert_eq!(lookup_cached_usage(db_str).as_deref(), Some(r#"[{"id":"v1"}]"#));

        // Creating companion -wal without touching main .db must invalidate cache.
        let wal_path = companion_wal_path(&db_path);
        fs::write(&wal_path, b"wal-frame-1").expect("write wal");
        assert_eq!(lookup_cached_usage(db_str), None);

        assert!(store_cached_usage(db_str, r#"[{"id":"v2"}]"#));
        assert_eq!(lookup_cached_usage(db_str).as_deref(), Some(r#"[{"id":"v2"}]"#));

        // Appending more bytes to -wal must invalidate cache again.
        let mut wal_file = OpenOptions::new().append(true).open(&wal_path).expect("open wal");
        wal_file.write_all(b"-frame-2").expect("append wal");
        wal_file.flush().expect("flush wal");
        drop(wal_file);
        assert_eq!(lookup_cached_usage(db_str), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_disable_shared_cache_env_bypasses_read_and_write() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = EnvVarGuard::capture(&["PULSE_SHARED_CACHE_PATH", "PULSE_DISABLE_SHARED_CACHE"]);

        let dir = make_temp_dir("disable");
        let db_path = dir.join("conv-disabled.db");
        fs::write(&db_path, b"db-bytes").expect("write db");
        let cache_path = dir.join("disabled-cache.db");
        let db_str = db_path.to_str().unwrap();

        env.set("PULSE_SHARED_CACHE_PATH", Some(cache_path.to_str().unwrap()));
        env.set("PULSE_DISABLE_SHARED_CACHE", Some("1"));
        assert!(!store_cached_usage(db_str, r#"[{"id":"never"}]"#));
        assert!(!cache_path.exists());
        assert_eq!(lookup_cached_usage(db_str), None);

        // Even when a populated cache exists, PULSE_DISABLE_SHARED_CACHE=1 bypasses reads.
        env.set("PULSE_DISABLE_SHARED_CACHE", None);
        assert!(store_cached_usage(db_str, r#"[{"id":"stored"}]"#));
        assert_eq!(lookup_cached_usage(db_str).as_deref(), Some(r#"[{"id":"stored"}]"#));

        env.set("PULSE_DISABLE_SHARED_CACHE", Some("1"));
        assert_eq!(lookup_cached_usage(db_str), None);
        assert!(!store_cached_usage(db_str, r#"[{"id":"ignored"}]"#));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_temp_dir_isolation_guard() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = EnvVarGuard::capture(&["PULSE_SHARED_CACHE_PATH", "PULSE_DISABLE_SHARED_CACHE"]);

        env.set("PULSE_DISABLE_SHARED_CACHE", None);
        env.set("PULSE_SHARED_CACHE_PATH", None);

        let temp_db = std::env::temp_dir().join("isolated-unit-test.db");
        assert!(is_inside_temp_dir(&temp_db));
        assert_eq!(resolve_shared_cache_path(&temp_db), None);

        #[cfg(windows)]
        let non_temp_db = Path::new("C:\\antigravity-non-temp\\conversations\\abc.db");
        #[cfg(not(windows))]
        let non_temp_db = Path::new("/antigravity-non-temp/conversations/abc.db");
        if !is_inside_temp_dir(non_temp_db) {
            if let Some(resolved) = resolve_shared_cache_path(non_temp_db) {
                assert_eq!(
                    resolved.file_name().and_then(|s| s.to_str()),
                    Some(SHARED_CACHE_FILENAME)
                );
            }
        }

        // Explicit PULSE_SHARED_CACHE_PATH overrides the temp_dir isolation guard for testing.
        let explicit = std::env::temp_dir().join("explicit-cache.db");
        env.set("PULSE_SHARED_CACHE_PATH", Some(explicit.to_str().unwrap()));
        assert_eq!(resolve_shared_cache_path(&temp_db), Some(explicit));
    }

    #[test]
    fn test_legacy_cache_user_version_invalidates_stale_rows() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = EnvVarGuard::capture(&["PULSE_SHARED_CACHE_PATH", "PULSE_DISABLE_SHARED_CACHE"]);

        let dir = make_temp_dir("user-ver");
        let db_path = dir.join("conv-ver.db");
        fs::write(&db_path, b"db-v1-content").expect("write db");
        let cache_path = dir.join("legacy-v1-cache.db");
        let db_str = db_path.to_str().unwrap();

        env.set("PULSE_DISABLE_SHARED_CACHE", None);
        env.set("PULSE_SHARED_CACHE_PATH", Some(cache_path.to_str().unwrap()));

        // Seed a legacy v0/v1 cache DB row matching the exact file stamp.
        let stamp = stat_trajectory_files(&db_path).expect("stamp");
        let legacy_conn = Connection::open(&cache_path).expect("open legacy db");
        legacy_conn
            .execute_batch(
                "CREATE TABLE usage_cache (
                    db_path TEXT PRIMARY KEY,
                    db_mtime_ms INTEGER NOT NULL,
                    db_size_bytes INTEGER NOT NULL,
                    wal_mtime_ms INTEGER NOT NULL,
                    wal_size_bytes INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                PRAGMA user_version = 1;",
            )
            .expect("create legacy schema");
        legacy_conn
            .execute(
                "INSERT INTO usage_cache VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    db_str,
                    stamp.db_mtime_ms,
                    stamp.db_size_bytes,
                    stamp.wal_mtime_ms,
                    stamp.wal_size_bytes,
                    r#"[{"id":"stale","partial":true}]"#,
                    1000i64
                ],
            )
            .expect("insert legacy row");
        drop(legacy_conn);

        // Pre-v2 cache must be treated as a cache miss.
        assert_eq!(lookup_cached_usage(db_str), None);

        // Writing upgrades user_version, purges stale rows, and serves subsequent hits.
        assert!(store_cached_usage(db_str, r#"[{"id":"fresh","partial":false}]"#));
        assert_eq!(
            lookup_cached_usage(db_str).as_deref(),
            Some(r#"[{"id":"fresh","partial":false}]"#)
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
