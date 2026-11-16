use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const CHUNK_SIZE: usize = 64 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempFileGuard {
    path: PathBuf,
    armed: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn create_unique_temp(log_path: &Path) -> io::Result<(File, TempFileGuard)> {
    let pid = std::process::id();
    for _ in 0..16 {
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut os_str: OsString = log_path.as_os_str().to_os_string();
        os_str.push(format!(".{pid}.{seq}.tmp"));
        let tmp_path = PathBuf::from(os_str);
        match OpenOptions::new().create_new(true).write(true).open(&tmp_path) {
            Ok(file) => return Ok((file, TempFileGuard::new(tmp_path))),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed to allocate unique temp file for log rotation",
    ))
}

fn rename_atomic(tmp_path: &Path, log_path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        const MAX_ATTEMPTS: usize = 5;
        let mut attempt = 0usize;
        loop {
            match fs::rename(tmp_path, log_path) {
                Ok(()) => return Ok(()),
                Err(e)
                    if attempt + 1 < MAX_ATTEMPTS
                        && matches!(
                            e.kind(),
                            io::ErrorKind::PermissionDenied | io::ErrorKind::AlreadyExists
                        ) =>
                {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(2 * attempt as u64));
                }
                Err(e) => return Err(e),
            }
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(tmp_path, log_path)
    }
}

/// Truncates `log_path` in place via an atomic sibling temp file so at most the
/// last `keep_lines` lines remain whenever the file size exceeds `max_bytes`.
/// Returns `Ok(true)` if the file was rotated, `Ok(false)` otherwise.
pub fn rotate_log_tail(
    log_path: &Path,
    max_bytes: u64,
    keep_lines: usize,
) -> io::Result<bool> {
    let meta = match fs::metadata(log_path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if meta.len() <= max_bytes {
        return Ok(false);
    }

    if keep_lines == 0 {
        let (mut out, mut guard) = create_unique_temp(log_path)?;
        out.flush()?;
        drop(out);
        rename_atomic(guard.path(), log_path)?;
        guard.disarm();
        return Ok(true);
    }

    let mut file = File::open(log_path)?;
    let file_len = file.metadata()?.len();
    if file_len <= max_bytes {
        return Ok(false);
    }

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut pos = file_len;
    let mut newlines_found = 0usize;
    let mut cut_offset = 0u64;

    while pos > 0 {
        let read_len = std::cmp::min(pos, CHUNK_SIZE as u64) as usize;
        pos -= read_len as u64;
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(&mut buf[..read_len])?;

        for i in (0..read_len).rev() {
            if buf[i] == b'\n' {
                if pos + (i as u64) + 1 == file_len {
                    continue;
                }
                newlines_found += 1;
                if newlines_found == keep_lines {
                    cut_offset = pos + (i as u64) + 1;
                    break;
                }
            }
        }
        if newlines_found >= keep_lines {
            break;
        }
    }

    if cut_offset == 0 {
        return Ok(false);
    }

    let (mut out, mut guard) = create_unique_temp(log_path)?;
    file.seek(SeekFrom::Start(cut_offset))?;
    io::copy(&mut file, &mut out)?;
    out.flush()?;
    drop(out);
    drop(file);
    rename_atomic(guard.path(), log_path)?;
    guard.disarm();
    Ok(true)
}

/// N-API helper returning `{"rotated":true|false}` JSON or `None` on error.
pub fn rotate_log_tail_json(
    log_path: &str,
    max_bytes: u64,
    keep_lines: usize,
) -> Option<String> {
    if log_path.is_empty() {
        return None;
    }
    match rotate_log_tail(Path::new(log_path), max_bytes, keep_lines) {
        Ok(rotated) => Some(if rotated {
            "{\"rotated\":true}".to_string()
        } else {
            "{\"rotated\":false}".to_string()
        }),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static TEST_SEQ: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(prefix: &str) -> Self {
            let id = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "pulse_log_rotator_{prefix}_{}_{id}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn count_tmp_files(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count()
    }

    #[test]
    fn missing_file_and_below_threshold_return_false() {
        let dir = TestDir::new("missing_threshold");
        let missing = dir.path("missing.log");
        assert!(!rotate_log_tail(&missing, 100, 5).unwrap());
        assert_eq!(
            rotate_log_tail_json(missing.to_str().unwrap(), 100, 5).as_deref(),
            Some("{\"rotated\":false}")
        );

        let small = dir.path("small.log");
        fs::write(&small, b"line1\nline2\n").unwrap();
        assert!(!rotate_log_tail(&small, 12, 1).unwrap());
        assert_eq!(fs::read(&small).unwrap(), b"line1\nline2\n");
        assert_eq!(count_tmp_files(&dir.0), 0);
    }

    #[test]
    fn exact_keep_lines_with_trailing_newline() {
        let dir = TestDir::new("exact_keep");
        let log = dir.path("app.log");
        fs::write(&log, b"l1\nl2\nl3\nl4\nl5\n").unwrap();

        assert!(rotate_log_tail(&log, 5, 3).unwrap());
        assert_eq!(fs::read_to_string(&log).unwrap(), "l3\nl4\nl5\n");

        // Exactly 3 lines remaining -> no further truncation needed even if > max_bytes
        assert!(!rotate_log_tail(&log, 5, 3).unwrap());
        assert_eq!(fs::read_to_string(&log).unwrap(), "l3\nl4\nl5\n");
        assert_eq!(count_tmp_files(&dir.0), 0);
    }

    #[test]
    fn handles_crlf_and_no_trailing_newline() {
        let dir = TestDir::new("crlf_notrail");
        let crlf_log = dir.path("crlf.log");
        fs::write(&crlf_log, b"a\r\nb\r\nc\r\nd\r\n").unwrap();
        assert!(rotate_log_tail(&crlf_log, 4, 2).unwrap());
        assert_eq!(fs::read(&crlf_log).unwrap(), b"c\r\nd\r\n");

        let no_trail = dir.path("notrail.log");
        fs::write(&no_trail, b"one\ntwo\nthree\nfour").unwrap();
        assert!(rotate_log_tail(&no_trail, 4, 2).unwrap());
        assert_eq!(fs::read_to_string(&no_trail).unwrap(), "three\nfour");
        assert_eq!(count_tmp_files(&dir.0), 0);
    }

    #[test]
    fn keep_lines_zero_truncates_to_empty() {
        let dir = TestDir::new("keep_zero");
        let log = dir.path("zero.log");
        fs::write(&log, b"alpha\nbeta\ngamma\n").unwrap();
        assert_eq!(
            rotate_log_tail_json(log.to_str().unwrap(), 1, 0).as_deref(),
            Some("{\"rotated\":true}")
        );
        assert_eq!(fs::read(&log).unwrap(), b"");
        assert_eq!(count_tmp_files(&dir.0), 0);
    }

    #[test]
    fn multi_chunk_over_128_kib_preserves_exact_tail() {
        let dir = TestDir::new("multichunk");
        let log = dir.path("big.log");
        let mut content = String::new();
        for i in 0..3000 {
            content.push_str(&format!("line-{i:04}-0123456789abcdef0123456789abcdef0123456789abcdef\n"));
        }
        assert!(content.len() > 128 * 1024);
        fs::write(&log, content.as_bytes()).unwrap();

        assert!(rotate_log_tail(&log, 64 * 1024, 1500).unwrap());
        let rotated = fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = rotated.lines().collect();
        assert_eq!(lines.len(), 1500);
        assert!(lines[0].starts_with("line-1500-"));
        assert!(lines[1499].starts_with("line-2999-"));
        assert!(rotated.ends_with('\n'));
        assert_eq!(count_tmp_files(&dir.0), 0);
    }
}
