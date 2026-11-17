use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use regex::{Captures, Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use serde::{Deserialize, Serialize};

const SANITIZE_USAGE_MJS_REPLACEMENT: &str = r#"accounts.push({ id: "all", name: "All Accounts (Aggregated)", email: "All Accounts (Aggregated)", active: activeScope === "all" });"#;
const SANITIZE_ACCOUNTS_TS_REPLACEMENT: &str = "accounts.push({ id: 'all', name: 'All Accounts (Aggregated)', email: 'All Accounts (Aggregated)', active: activeScope === 'all' });";
const SANITIZE_MULTI_TEST_SEARCH: &str = "assert.equal(accounts[0].name, '全部账号 (汇总)');";
const SANITIZE_MULTI_TEST_REPLACE: &str = "assert.equal(accounts[0].name, 'All Accounts (Aggregated)');";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatternInput {
    pattern: String,
    #[serde(default)]
    flags: String,
    label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditPrivacyOptions {
    root_dir: String,
    #[serde(default)]
    files: Option<Vec<String>>,
    #[serde(default)]
    excluded_dirs: Vec<String>,
    #[serde(default)]
    excluded_rel_files: Vec<String>,
    #[serde(default)]
    excluded_suffixes: Vec<String>,
    #[serde(default)]
    text_extensions: Vec<String>,
    #[serde(default)]
    patterns: Vec<PatternInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncAndAuditOptions {
    source_dir: String,
    dest_dir: String,
    #[serde(default)]
    excluded_dirs: Vec<String>,
    #[serde(default)]
    excluded_rel_files: Vec<String>,
    #[serde(default)]
    excluded_suffixes: Vec<String>,
    #[serde(default)]
    text_extensions: Vec<String>,
    #[serde(default)]
    patterns: Vec<PatternInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditPrivacyOutput {
    checked: usize,
    findings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncAndAuditOutput {
    exported: usize,
    checked: usize,
    findings: Vec<String>,
}

struct FilterRules {
    excluded_dirs: HashSet<String>,
    excluded_rel_files: HashSet<String>,
    excluded_suffixes: HashSet<String>,
    text_extensions_lower: HashSet<String>,
    text_extensions_exact: HashSet<String>,
}

impl FilterRules {
    fn new(
        excluded_dirs: Vec<String>,
        excluded_rel_files: Vec<String>,
        excluded_suffixes: Vec<String>,
        text_extensions: Vec<String>,
    ) -> Self {
        let excluded_suffixes = excluded_suffixes
            .into_iter()
            .map(|s| s.to_ascii_lowercase())
            .collect();
        let mut text_extensions_lower = HashSet::with_capacity(text_extensions.len());
        let mut text_extensions_exact = HashSet::with_capacity(text_extensions.len());
        for ext in text_extensions {
            text_extensions_lower.insert(ext.to_ascii_lowercase());
            text_extensions_exact.insert(ext);
        }
        Self {
            excluded_dirs: excluded_dirs.into_iter().collect(),
            excluded_rel_files: excluded_rel_files.into_iter().collect(),
            excluded_suffixes,
            text_extensions_lower,
            text_extensions_exact,
        }
    }

    fn is_excluded(&self, rel_posix: &str) -> bool {
        let mut base_name = "";
        for part in rel_posix.split('/').filter(|p| !p.is_empty()) {
            if self.excluded_dirs.contains(part) {
                return true;
            }
            base_name = part;
        }
        if self.excluded_rel_files.contains(rel_posix) {
            return true;
        }
        if base_name.starts_with(".env") {
            return true;
        }
        let ext = posix_extname(base_name);
        !ext.is_empty() && self.excluded_suffixes.contains(&ext.to_ascii_lowercase())
    }

    fn is_text_rel_path(&self, rel_posix: &str) -> bool {
        let base_name = rel_posix.rsplit('/').next().unwrap_or(rel_posix);
        let ext = posix_extname(base_name).to_ascii_lowercase();
        self.text_extensions_lower.contains(&ext) || self.text_extensions_exact.contains(base_name)
    }
}

fn posix_extname(base_name: &str) -> &str {
    if base_name.is_empty() || base_name == "." || base_name == ".." {
        return "";
    }
    match base_name.rfind('.') {
        Some(idx) if idx > 0 => &base_name[idx..],
        _ => "",
    }
}

fn is_safe_rel_posix(rel_posix: &str) -> bool {
    if rel_posix.is_empty()
        || rel_posix.starts_with('/')
        || rel_posix.ends_with('/')
        || rel_posix.contains('\\')
        || rel_posix.contains('\0')
        || rel_posix.contains(':')
    {
        return false;
    }
    rel_posix
        .split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn join_rel_posix(base: &Path, rel_posix: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    for part in rel_posix.split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

fn collect_sanitized_files(root_dir: &Path, rules: &FilterRules) -> Option<Vec<String>> {
    fn walk(abs_dir: &Path, rel_prefix: &str, rules: &FilterRules, out: &mut Vec<String>) -> bool {
        let Ok(read_dir) = fs::read_dir(abs_dir) else {
            return false;
        };
        let mut entries = Vec::new();
        for entry_res in read_dir {
            let Ok(entry) = entry_res else {
                continue;
            };
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            entries.push((name_str.to_string(), entry));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        for (name, entry) in entries {
            let rel_posix = if rel_prefix.is_empty() {
                name
            } else {
                format!("{rel_prefix}/{name}")
            };
            if rules.is_excluded(&rel_posix) {
                continue;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                if !walk(&entry.path(), &rel_posix, rules, out) {
                    return false;
                }
            } else if ft.is_file() {
                out.push(rel_posix);
            }
        }
        true
    }

    let mut files = Vec::new();
    if !walk(root_dir, "", rules, &mut files) {
        return None;
    }
    files.sort();
    Some(files)
}

fn flags_supported(flags: &str) -> bool {
    flags
        .chars()
        .all(|c| matches!(c, 'i' | 'g' | 'm' | 'u' | 'v' | 's' | 'd'))
}

fn contains_ascii_word_or_digit_escape(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'\\' {
            let next = bytes[i + 1];
            if matches!(next, b'w' | b'W' | b'd' | b'D' | b'b' | b'B') {
                return true;
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    false
}

fn contains_whitespace_escape(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'\\' {
            let next = bytes[i + 1];
            if matches!(next, b's' | b'S') {
                return true;
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    false
}

/// Resolves whether a JS RegExp pattern should compile in Unicode mode or ASCII-only (`(?-u)`)
/// in Rust `regex`, returning `None` to trigger JS fallback when semantics cannot match cleanly.
fn resolve_unicode_mode(spec: &PatternInput) -> Option<bool> {
    if !flags_supported(&spec.flags) {
        return None;
    }
    let has_unicode_flag = spec.flags.contains('u') || spec.flags.contains('v');
    if has_unicode_flag {
        return Some(true);
    }
    let has_word_digit = contains_ascii_word_or_digit_escape(&spec.pattern);
    if !has_word_digit {
        // Without \w/\W/\d/\D/\b/\B, JS non-u patterns match literals and Unicode \s cleanly under default regex mode.
        return Some(true);
    }
    if !spec.pattern.is_ascii() || contains_whitespace_escape(&spec.pattern) {
        // Defer mixed non-ASCII / \s + \b/\w/\d non-u patterns to exact JS RegExp semantics.
        return None;
    }
    Some(false)
}

fn compile_regex_set(patterns: &[PatternInput]) -> Option<RegexSet> {
    let mut set_patterns = Vec::with_capacity(patterns.len());
    for spec in patterns {
        let unicode = resolve_unicode_mode(spec)?;
        let mut flags = String::new();
        if spec.flags.contains('i') {
            flags.push('i');
        }
        if unicode {
            flags.push('u');
        }
        if !spec.flags.contains('i') || !unicode {
            flags.push('-');
            if !spec.flags.contains('i') {
                flags.push('i');
            }
            if !unicode {
                flags.push('u');
            }
        }
        set_patterns.push(format!("(?{flags}:{})", spec.pattern));
    }
    RegexSetBuilder::new(&set_patterns)
        .multi_line(true)
        .crlf(true)
        .build()
        .ok()
}

fn compile_individual_regex(spec: &PatternInput) -> Option<Regex> {
    let unicode = resolve_unicode_mode(spec)?;
    RegexBuilder::new(&spec.pattern)
        .case_insensitive(spec.flags.contains('i'))
        .multi_line(spec.flags.contains('m'))
        .dot_matches_new_line(spec.flags.contains('s'))
        .unicode(unicode)
        .build()
        .ok()
}

fn audit_files_parallel(
    root_dir: &Path,
    files: &[String],
    rules: &FilterRules,
    patterns: &[PatternInput],
) -> Option<Vec<String>> {
    if patterns.is_empty() {
        return Some(Vec::new());
    }
    let regex_set = compile_regex_set(patterns)?;
    let text_indices: Vec<usize> = files
        .iter()
        .enumerate()
        .filter_map(|(i, rel)| rules.is_text_rel_path(rel).then_some(i))
        .collect();
    if text_indices.is_empty() {
        return Some(Vec::new());
    }

    let individual: Vec<OnceLock<Option<Regex>>> =
        (0..patterns.len()).map(|_| OnceLock::new()).collect();
    let cursor = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(text_indices.len())
        .min(16)
        .max(1);

    let mut all_findings: Vec<(usize, usize, usize, String)> = Vec::new();
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(scope.spawn(|| {
                let mut local = Vec::new();
                loop {
                    if failed.load(Ordering::Relaxed) {
                        break;
                    }
                    let work_idx = cursor.fetch_add(1, Ordering::Relaxed);
                    if work_idx >= text_indices.len() {
                        break;
                    }
                    let file_idx = text_indices[work_idx];
                    let rel_posix = &files[file_idx];
                    let file_path = join_rel_posix(root_dir, rel_posix);
                    let Ok(bytes) = fs::read(&file_path) else {
                        continue;
                    };
                    let Ok(text) = std::str::from_utf8(&bytes) else {
                        continue;
                    };
                    if text.contains('\u{FFFD}') {
                        continue;
                    }
                    let set_matches = regex_set.matches(text);
                    if !set_matches.matched_any() {
                        continue;
                    }
                    let matched_pats: Vec<usize> = set_matches.into_iter().collect();
                    let mut pat_regexes = Vec::with_capacity(matched_pats.len());
                    for &pat_idx in &matched_pats {
                        let compiled = individual[pat_idx]
                            .get_or_init(|| compile_individual_regex(&patterns[pat_idx]));
                        let Some(re) = compiled.as_ref() else {
                            failed.store(true, Ordering::Relaxed);
                            return local;
                        };
                        pat_regexes.push((pat_idx, re));
                    }
                    let mut lines = text.split('\n').enumerate().peekable();
                    while let Some((line_idx, raw_line)) = lines.next() {
                        // Match JS `text.split(/\r?\n/)`: strip `\r` only when followed by `\n`.
                        let line = if lines.peek().is_some() {
                            raw_line.strip_suffix('\r').unwrap_or(raw_line)
                        } else {
                            raw_line
                        };
                        for &(pat_idx, re) in &pat_regexes {
                            if re.is_match(line) {
                                local.push((
                                    file_idx,
                                    line_idx + 1,
                                    pat_idx,
                                    format!(
                                        "{rel_posix}:{} ({})",
                                        line_idx + 1,
                                        patterns[pat_idx].label
                                    ),
                                ));
                            }
                        }
                    }
                }
                local
            }));
        }
        for handle in handles {
            if let Ok(mut part) = handle.join() {
                all_findings.append(&mut part);
            }
        }
    });

    if failed.load(Ordering::Relaxed) {
        return None;
    }
    all_findings.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    Some(all_findings.into_iter().map(|(_, _, _, msg)| msg).collect())
}

fn sanitize_all_accounts_label(text: &str, replacement: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r#"(?i)accounts\.push\(\s*\{\s*id:\s*(['"])all(['"])\s*,\s*name:\s*(['"])(?:全部账号 \(汇总\)|\\u5168\\u90E8\\u8D26\\u53F7 \(\\u6C47\\u603B\))(['"])\s*,\s*email:\s*(['"])(?:全部账号 \(汇总\)|\\u5168\\u90E8\\u8D26\\u53F7 \(\\u6C47\\u603B\))(['"])\s*,\s*active:\s*activeScope\s*===\s*(['"])all(['"])\s*\}\s*\);"#,
        )
        .expect("valid ALL_ACCOUNTS_LABEL_RE")
    });
    re.replace_all(text, |caps: &Captures<'_>| {
        let pairs_match = [(1, 2), (3, 4), (5, 6), (7, 8)]
            .into_iter()
            .all(|(a, b)| caps.get(a).map(|m| m.as_str()) == caps.get(b).map(|m| m.as_str()));
        if pairs_match {
            replacement.to_string()
        } else {
            caps[0].to_string()
        }
    })
    .into_owned()
}

fn sanitize_multi_account_test(text: &str) -> String {
    text.replacen(SANITIZE_MULTI_TEST_SEARCH, SANITIZE_MULTI_TEST_REPLACE, 1)
}

fn apply_sanitizer_transform(rel_posix: &str, text: &str) -> Option<String> {
    match rel_posix {
        "sidecars/panel/usage.mjs" => {
            Some(sanitize_all_accounts_label(text, SANITIZE_USAGE_MJS_REPLACEMENT))
        }
        "src/telemetry/ledger/accounts.ts" => {
            Some(sanitize_all_accounts_label(text, SANITIZE_ACCOUNTS_TS_REPLACEMENT))
        }
        "sidecars/panel/tests/multi-account-features.test.mjs" => {
            Some(sanitize_multi_account_test(text))
        }
        _ => None,
    }
}

fn is_sanitizer_target(rel_posix: &str) -> bool {
    matches!(
        rel_posix,
        "sidecars/panel/usage.mjs"
            | "src/telemetry/ledger/accounts.ts"
            | "sidecars/panel/tests/multi-account-features.test.mjs"
    )
}

fn prune_stale_destination_files(
    expected_set: &HashSet<&str>,
    abs_dir: &Path,
    rel_prefix: &str,
) -> bool {
    let Ok(read_dir) = fs::read_dir(abs_dir) else {
        return !abs_dir.exists();
    };
    for entry_res in read_dir {
        let Ok(entry) = entry_res else {
            continue;
        };
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if name_str == ".git" && rel_prefix.is_empty() {
            continue;
        }
        let rel_posix = if rel_prefix.is_empty() {
            name_str.to_string()
        } else {
            format!("{rel_prefix}/{name_str}")
        };
        if rel_posix.split('/').any(|p| p == ".git") {
            continue;
        }
        let abs_child = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if !prune_stale_destination_files(expected_set, &abs_child, &rel_posix) {
                return false;
            }
            let is_empty_dir = match fs::read_dir(&abs_child) {
                Ok(mut iter) => iter.next().is_none(),
                Err(_) => false,
            };
            if is_empty_dir {
                let _ = fs::remove_dir_all(&abs_child);
            }
        } else if !expected_set.contains(rel_posix.as_str()) {
            clear_readonly_if_needed(&abs_child);
            if fs::remove_file(&abs_child).is_err() {
                // On Windows, directory symlinks/NTFS junctions report ft.is_symlink() and need remove_dir.
                if !(ft.is_symlink() && fs::remove_dir(&abs_child).is_ok()) {
                    return false;
                }
            }
        }
    }
    true
}

fn mtime_matches(a: SystemTime, b: SystemTime) -> bool {
    let diff = match a.duration_since(b) {
        Ok(d) => d,
        Err(e) => e.duration(),
    };
    diff <= Duration::from_millis(1)
}

fn clear_readonly_if_needed(path: &Path) {
    if let Ok(meta) = fs::symlink_metadata(path) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

fn sync_single_file(source_dir: &Path, dest_dir: &Path, rel_posix: &str) -> bool {
    let src_file = join_rel_posix(source_dir, rel_posix);
    let dst_file = join_rel_posix(dest_dir, rel_posix);

    if is_sanitizer_target(rel_posix) {
        let Ok(text) = fs::read_to_string(&src_file) else {
            return false;
        };
        let transformed = apply_sanitizer_transform(rel_posix, &text).unwrap_or(text);
        if let Ok(dm) = fs::symlink_metadata(&dst_file) {
            if dm.is_dir() {
                let _ = fs::remove_dir_all(&dst_file);
            } else if dm.permissions().readonly() {
                clear_readonly_if_needed(&dst_file);
            }
        }
        return fs::write(&dst_file, transformed.as_bytes()).is_ok();
    }

    let Ok(src_meta) = fs::metadata(&src_file) else {
        return false;
    };
    if let Ok(dst_meta) = fs::symlink_metadata(&dst_file) {
        if dst_meta.is_file() && src_meta.len() == dst_meta.len() {
            if let (Ok(sm), Ok(dm)) = (src_meta.modified(), dst_meta.modified()) {
                if mtime_matches(sm, dm) {
                    return true;
                }
            }
        } else if dst_meta.is_dir() {
            let _ = fs::remove_dir_all(&dst_file);
        } else if !dst_meta.is_file() {
            let _ = fs::remove_file(&dst_file);
        }
    }

    if fs::copy(&src_file, &dst_file).is_err() {
        clear_readonly_if_needed(&dst_file);
        let _ = fs::remove_file(&dst_file);
        if fs::copy(&src_file, &dst_file).is_err() {
            return false;
        }
    }
    if let Ok(mtime) = src_meta.modified() {
        clear_readonly_if_needed(&dst_file);
        if let Ok(file) = OpenOptions::new().write(true).open(&dst_file) {
            let _ = file.set_modified(mtime);
        }
    }
    true
}

pub fn audit_open_source_privacy_json(options_json: &str) -> Option<String> {
    let opts: AuditPrivacyOptions = serde_json::from_str(options_json).ok()?;
    let root_dir = PathBuf::from(&opts.root_dir);
    let rules = FilterRules::new(
        opts.excluded_dirs,
        opts.excluded_rel_files,
        opts.excluded_suffixes,
        opts.text_extensions,
    );
    let files = match opts.files {
        Some(list) => {
            if !list.iter().all(|rel| is_safe_rel_posix(rel)) {
                return None;
            }
            list.into_iter()
                .filter(|rel| !rules.is_excluded(rel))
                .collect()
        }
        None => collect_sanitized_files(&root_dir, &rules)?,
    };
    let findings = audit_files_parallel(&root_dir, &files, &rules, &opts.patterns)?;
    let out = AuditPrivacyOutput {
        checked: files.len(),
        findings,
    };
    serde_json::to_string(&out).ok()
}

pub fn sync_and_audit_open_source_json(options_json: &str) -> Option<String> {
    let opts: SyncAndAuditOptions = serde_json::from_str(options_json).ok()?;
    let source_dir = PathBuf::from(&opts.source_dir);
    let dest_dir = PathBuf::from(&opts.dest_dir);
    let rules = FilterRules::new(
        opts.excluded_dirs,
        opts.excluded_rel_files,
        opts.excluded_suffixes,
        opts.text_extensions,
    );

    // Validate all patterns up front so incompatible JS regexes fall back before mutating dest_dir.
    if !opts.patterns.is_empty() && compile_regex_set(&opts.patterns).is_none() {
        return None;
    }

    let files = collect_sanitized_files(&source_dir, &rules)?;
    fs::create_dir_all(&dest_dir).ok()?;

    let expected_set: HashSet<&str> = files.iter().map(String::as_str).collect();
    if !prune_stale_destination_files(&expected_set, &dest_dir, "") {
        return None;
    }

    let mut parent_dirs = HashSet::new();
    for rel_posix in &files {
        if let Some((parent, _)) = rel_posix.rsplit_once('/') {
            parent_dirs.insert(parent);
        }
    }
    for rel_parent in parent_dirs {
        fs::create_dir_all(join_rel_posix(&dest_dir, rel_parent)).ok()?;
    }

    if !files.is_empty() {
        let cursor = AtomicUsize::new(0);
        let sync_failed = AtomicBool::new(false);
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(files.len())
            .min(16)
            .max(1);
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    if sync_failed.load(Ordering::Relaxed) {
                        break;
                    }
                    let idx = cursor.fetch_add(1, Ordering::Relaxed);
                    if idx >= files.len() {
                        break;
                    }
                    if !sync_single_file(&source_dir, &dest_dir, &files[idx]) {
                        sync_failed.store(true, Ordering::Relaxed);
                        break;
                    }
                });
            }
        });
        if sync_failed.load(Ordering::Relaxed) {
            return None;
        }
    }

    let findings = audit_files_parallel(&dest_dir, &files, &rules, &opts.patterns)?;
    let out = SyncAndAuditOutput {
        exported: files.len(),
        checked: files.len(),
        findings,
    };
    serde_json::to_string(&out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("{prefix}-{pid}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn default_rules() -> (Vec<&'static str>, Vec<&'static str>, Vec<&'static str>, Vec<&'static str>) {
        (
            vec![".git", ".data", "dist", "node_modules", "target"],
            vec!["RULE.md", "tools/export-opensource.mjs"],
            vec![".pyc", ".node", ".dll", ".log"],
            vec![".js", ".mjs", ".ts", ".md", ".txt", ".json", ".gitignore"],
        )
    }

    #[test]
    fn filter_rules_match_node_extname_and_exclusions() {
        let (dirs, rels, suffixes, exts) = default_rules();
        let rules = FilterRules::new(
            dirs.into_iter().map(String::from).collect(),
            rels.into_iter().map(String::from).collect(),
            suffixes.into_iter().map(String::from).collect(),
            exts.into_iter().map(String::from).collect(),
        );
        assert!(rules.is_excluded(".git/config"));
        assert!(rules.is_excluded("nested/node_modules/a.js"));
        assert!(rules.is_excluded("RULE.md"));
        assert!(rules.is_excluded("tools/export-opensource.mjs"));
        assert!(rules.is_excluded(".env"));
        assert!(rules.is_excluded("sub/.env.local"));
        assert!(rules.is_excluded("build/app.NODE"));
        assert!(!rules.is_excluded(".gitignore"));
        assert!(rules.is_text_rel_path(".gitignore"));
        assert!(rules.is_text_rel_path("src/app.TS"));
        assert!(!rules.is_text_rel_path("assets/logo.png"));
    }

    #[test]
    fn audit_privacy_scans_parallel_handles_crlf_and_skips_invalid_utf8() {
        let root = make_temp_dir("pulse-san-audit");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join(".data")).unwrap();
        fs::write(root.join(".data/secret.txt"), "alice should be excluded\n").unwrap();
        fs::write(root.join(".env.local"), "alice env excluded\n").unwrap();
        fs::write(root.join("src/clean.ts"), "export const ok = 1;\n").unwrap();
        fs::write(
            root.join("src/dirty.ts"),
            "line1\r\n^AnchorSecret\r\nline3\r\nline4 AlIcE\r\n",
        )
        .unwrap();
        fs::write(root.join("src/binary.txt"), [0xff, 0xfe, b'a', b'l', b'i', b'c', b'e']).unwrap();
        fs::write(root.join("src/image.png"), "alice in png skipped\n").unwrap();

        let (dirs, rels, suffixes, exts) = default_rules();
        let opts = serde_json::json!({
            "rootDir": root.to_string_lossy(),
            "excludedDirs": dirs,
            "excludedRelFiles": rels,
            "excludedSuffixes": suffixes,
            "textExtensions": exts,
            "patterns": [
                { "pattern": "alice", "flags": "i", "label": "local username" },
                { "pattern": "^\\^AnchorSecret$", "flags": "", "label": "anchored secret" }
            ]
        });

        let out_json = audit_open_source_privacy_json(&opts.to_string()).expect("some output");
        let parsed: serde_json::Value = serde_json::from_str(&out_json).unwrap();
        assert_eq!(parsed["checked"], 4); // clean.ts, dirty.ts, binary.txt, image.png
        assert_eq!(
            parsed["findings"],
            serde_json::json!([
                "src/dirty.ts:2 (anchored secret)",
                "src/dirty.ts:4 (local username)"
            ])
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn audit_privacy_returns_none_on_unsupported_js_regex() {
        let root = make_temp_dir("pulse-san-fallback");
        fs::write(root.join("a.txt"), "foobar\n").unwrap();
        let (dirs, rels, suffixes, exts) = default_rules();

        let lookahead = serde_json::json!({
            "rootDir": root.to_string_lossy(),
            "excludedDirs": dirs,
            "excludedRelFiles": rels,
            "excludedSuffixes": suffixes,
            "textExtensions": exts,
            "patterns": [{ "pattern": "foo(?!bar)", "flags": "", "label": "lookahead" }]
        });
        assert!(audit_open_source_privacy_json(&lookahead.to_string()).is_none());

        let backref = serde_json::json!({
            "rootDir": root.to_string_lossy(),
            "excludedDirs": dirs,
            "excludedRelFiles": rels,
            "excludedSuffixes": suffixes,
            "textExtensions": exts,
            "patterns": [{ "pattern": "(a)\\1", "flags": "", "label": "backref" }]
        });
        assert!(audit_open_source_privacy_json(&backref.to_string()).is_none());

        let sticky = serde_json::json!({
            "rootDir": root.to_string_lossy(),
            "excludedDirs": dirs,
            "excludedRelFiles": rels,
            "excludedSuffixes": suffixes,
            "textExtensions": exts,
            "patterns": [{ "pattern": "foo", "flags": "y", "label": "sticky" }]
        });
        assert!(audit_open_source_privacy_json(&sticky.to_string()).is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_and_audit_transforms_prunes_and_skips_unchanged_mtime_size() {
        let src = make_temp_dir("pulse-san-src");
        let dst = make_temp_dir("pulse-san-dst");

        fs::create_dir_all(src.join("sidecars/panel/tests")).unwrap();
        fs::create_dir_all(src.join("src/telemetry/ledger")).unwrap();
        fs::create_dir_all(src.join(".git")).unwrap();
        fs::write(src.join(".git/ignored"), "x").unwrap();

        fs::write(
            src.join("sidecars/panel/usage.mjs"),
            "accounts.push({ id: \"all\", name: \"\\u5168\\u90E8\\u8D26\\u53F7 (\\u6C47\\u603B)\", email: \"\\u5168\\u90E8\\u8D26\\u53F7 (\\u6C47\\u603B)\", active: activeScope === \"all\" });\n",
        )
        .unwrap();
        fs::write(
            src.join("src/telemetry/ledger/accounts.ts"),
            "accounts.push({ id: 'all', name: '全部账号 (汇总)', email: '全部账号 (汇总)', active: activeScope === 'all' });\n",
        )
        .unwrap();
        fs::write(
            src.join("sidecars/panel/tests/multi-account-features.test.mjs"),
            "assert.equal(accounts[0].name, '全部账号 (汇总)');\nassert.equal(accounts[0].name, '全部账号 (汇总)');\n",
        )
        .unwrap();
        fs::write(src.join("README.md"), "hello world\n").unwrap();

        // Pre-populate dst with .git and stale files/dirs
        fs::create_dir_all(dst.join(".git")).unwrap();
        fs::write(dst.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::create_dir_all(dst.join("stale_dir/nested")).unwrap();
        fs::write(dst.join("stale_dir/nested/old.txt"), "stale").unwrap();
        fs::write(dst.join("stale.txt"), "stale").unwrap();

        let (dirs, rels, suffixes, exts) = default_rules();
        let opts = serde_json::json!({
            "sourceDir": src.to_string_lossy(),
            "destDir": dst.to_string_lossy(),
            "excludedDirs": dirs,
            "excludedRelFiles": rels,
            "excludedSuffixes": suffixes,
            "textExtensions": exts,
            "patterns": [{ "pattern": "全部账号", "flags": "", "label": "zh label" }]
        });

        let out_json = sync_and_audit_open_source_json(&opts.to_string()).expect("sync ok");
        let parsed: serde_json::Value = serde_json::from_str(&out_json).unwrap();
        assert_eq!(parsed["exported"], 4);
        assert_eq!(parsed["checked"], 4);
        // multi-account-features.test.mjs only replaces the first occurrence, matching TS String.replace
        assert_eq!(
            parsed["findings"],
            serde_json::json!(["sidecars/panel/tests/multi-account-features.test.mjs:2 (zh label)"])
        );

        assert!(dst.join(".git/HEAD").exists());
        assert!(!dst.join("stale.txt").exists());
        assert!(!dst.join("stale_dir").exists());
        assert!(fs::read_to_string(dst.join("sidecars/panel/usage.mjs"))
            .unwrap()
            .contains("All Accounts (Aggregated)"));
        assert!(fs::read_to_string(dst.join("src/telemetry/ledger/accounts.ts"))
            .unwrap()
            .contains("All Accounts (Aggregated)"));

        // Verify (mtime, size) skip: overwrite dst README.md with same length & same mtime,
        // and confirm second sync skips recopying it.
        let src_meta = fs::metadata(src.join("README.md")).unwrap();
        let mtime = src_meta.modified().unwrap();
        fs::write(dst.join("README.md"), "MAGIC SENTIN").unwrap(); // exact 12 bytes ("hello world\n")
        assert_eq!(fs::metadata(dst.join("README.md")).unwrap().len(), src_meta.len());
        OpenOptions::new()
            .write(true)
            .open(dst.join("README.md"))
            .unwrap()
            .set_modified(mtime)
            .unwrap();

        let _ = sync_and_audit_open_source_json(&opts.to_string()).expect("sync 2 ok");
        assert_eq!(fs::read_to_string(dst.join("README.md")).unwrap(), "MAGIC SENTIN");

        // Verify changing mtime triggers recopy
        OpenOptions::new()
            .write(true)
            .open(dst.join("README.md"))
            .unwrap()
            .set_modified(mtime - Duration::from_secs(10))
            .unwrap();
        let _ = sync_and_audit_open_source_json(&opts.to_string()).expect("sync 3 ok");
        assert_eq!(fs::read_to_string(dst.join("README.md")).unwrap(), "hello world\n");

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn rejects_traversal_filters_excluded_and_matches_non_ascii_word_boundary() {
        let root = make_temp_dir("audit-safety");
        fs::write(root.join("note.txt"), "中文foo\r").unwrap();
        fs::write(root.join(".env.local"), "SECRET=123\n").unwrap();

        let (dirs, rels, suffixes, exts) = default_rules();
        let bad_opts = serde_json::json!({
            "rootDir": root.to_string_lossy(),
            "files": ["../escape.txt"],
            "excludedDirs": dirs,
            "excludedRelFiles": rels,
            "excludedSuffixes": suffixes,
            "textExtensions": exts,
            "patterns": [{ "pattern": "\\bfoo\\b", "flags": "", "label": "word" }]
        });
        assert!(audit_open_source_privacy_json(&bad_opts.to_string()).is_none());

        let good_opts = serde_json::json!({
            "rootDir": root.to_string_lossy(),
            "files": [".env.local", "note.txt"],
            "excludedDirs": dirs,
            "excludedRelFiles": rels,
            "excludedSuffixes": suffixes,
            "textExtensions": exts,
            "patterns": [
                { "pattern": "\\bfoo\\b", "flags": "", "label": "word" },
                { "pattern": "\\r$", "flags": "", "label": "trailing-cr" }
            ]
        });
        let out_json = audit_open_source_privacy_json(&good_opts.to_string()).expect("audit ok");
        let parsed: serde_json::Value = serde_json::from_str(&out_json).unwrap();
        assert_eq!(parsed["checked"], 1);
        assert_eq!(
            parsed["findings"],
            serde_json::json!(["note.txt:1 (word)", "note.txt:1 (trailing-cr)"])
        );

        let _ = fs::remove_dir_all(&root);
    }
}
