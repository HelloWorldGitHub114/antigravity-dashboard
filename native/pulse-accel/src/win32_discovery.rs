use std::collections::HashMap;
use std::fmt::Write as _;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::mem::{size_of, zeroed};
#[cfg(windows)]
use std::ptr;

#[cfg(windows)]
const MAX_CMDLINE_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const MAX_TCP_TABLE_BYTES: usize = 16 * 1024 * 1024;

#[cfg(windows)]
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
#[cfg(windows)]
const PROCESS_VM_READ: u32 = 0x0010;
#[cfg(windows)]
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
#[cfg(windows)]
const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;

#[cfg(windows)]
const AF_INET: u32 = 2;
#[cfg(windows)]
const AF_INET6: u32 = 23;
#[cfg(windows)]
const TCP_TABLE_OWNER_PID_LISTENER: u32 = 3;
const MIB_TCP_STATE_LISTEN: u32 = 2;
#[cfg(windows)]
const NO_ERROR: u32 = 0;
#[cfg(windows)]
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

#[cfg(all(windows, target_pointer_width = "64"))]
const PEB_PROCESS_PARAMETERS_OFFSET: usize = 0x20;
#[cfg(all(windows, target_pointer_width = "64"))]
const PARAMS_COMMAND_LINE_OFFSET: usize = 0x70;

#[cfg(all(windows, target_pointer_width = "32"))]
const PEB_PROCESS_PARAMETERS_OFFSET: usize = 0x10;
#[cfg(all(windows, target_pointer_width = "32"))]
const PARAMS_COMMAND_LINE_OFFSET: usize = 0x40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredWin32Process {
    pub pid: u32,
    pub command_line: String,
    pub listen_ports: Vec<u16>,
}

#[inline]
pub(crate) fn be_port_to_host(raw_dw_local_port: u32) -> Option<u16> {
    let port = u16::from_be((raw_dw_local_port & 0xFFFF) as u16);
    if port > 0 {
        Some(port)
    } else {
        None
    }
}

#[inline]
pub(crate) fn is_target_process_name(exe_name: &str) -> bool {
    exe_name.eq_ignore_ascii_case("language_server.exe")
}

/// Matches `(?:^|\s)--standalone(?:\s|=|$)` used by `discovery.ts`.
pub(crate) fn has_standalone_flag(cmd: &str) -> bool {
    const FLAG: &str = "--standalone";
    let bytes = cmd.as_bytes();
    let mut start = 0usize;
    while let Some(rel) = cmd[start..].find(FLAG) {
        let idx = start + rel;
        let left_ok = idx == 0 || bytes[idx - 1].is_ascii_whitespace();
        let after = idx + FLAG.len();
        let right_ok = after == bytes.len()
            || bytes[after].is_ascii_whitespace()
            || bytes[after] == b'=';
        if left_ok && right_ok {
            return true;
        }
        start = idx + FLAG.len();
    }
    false
}

fn push_json_escaped(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn format_processes_json(processes: &[DiscoveredWin32Process]) -> String {
    let mut out = String::with_capacity(64 + processes.len() * 192);
    out.push_str("{\"processes\":[");
    for (idx, proc_item) in processes.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        let _ = write!(out, "{{\"pid\":{},\"commandLine\":", proc_item.pid);
        push_json_escaped(&mut out, &proc_item.command_line);
        out.push_str(",\"listenPorts\":[");
        for (p_idx, port) in proc_item.listen_ports.iter().enumerate() {
            if p_idx > 0 {
                out.push(',');
            }
            let _ = write!(out, "{}", port);
        }
        out.push_str("]}");
    }
    out.push_str("]}");
    out
}

#[cfg(windows)]
struct HandleGuard(*mut c_void);

#[cfg(windows)]
impl HandleGuard {
    fn from_raw(handle: *mut c_void) -> Option<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(handle))
        }
    }

    fn as_raw(&self) -> *mut c_void {
        self.0
    }
}

#[cfg(windows)]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; 260],
}

#[cfg(windows)]
#[repr(C)]
struct ProcessBasicInformation {
    exit_status: i32,
    peb_base_address: usize,
    affinity_mask: usize,
    base_priority: isize,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MibTcpRowOwnerPid {
    dw_state: u32,
    dw_local_addr: u32,
    dw_local_port: u32,
    dw_remote_addr: u32,
    dw_remote_port: u32,
    dw_owning_pid: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MibTcp6RowOwnerPid {
    uc_local_addr: [u8; 16],
    dw_local_scope_id: u32,
    dw_local_port: u32,
    uc_remote_addr: [u8; 16],
    dw_remote_scope_id: u32,
    dw_remote_port: u32,
    dw_state: u32,
    dw_owning_pid: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> *mut c_void;
    fn Process32FirstW(h_snapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(h_snapshot: *mut c_void, lppe: *mut ProcessEntry32W) -> i32;
    fn OpenProcess(dw_desired_access: u32, b_inherit_handle: i32, dw_process_id: u32)
        -> *mut c_void;
    fn ReadProcessMemory(
        h_process: *mut c_void,
        lp_base_address: *const c_void,
        lp_buffer: *mut c_void,
        n_size: usize,
        lp_number_of_bytes_read: *mut usize,
    ) -> i32;
    fn CloseHandle(h_object: *mut c_void) -> i32;
    fn GetModuleHandleA(lp_module_name: *const u8) -> *mut c_void;
    fn LoadLibraryA(lp_lib_file_name: *const u8) -> *mut c_void;
    fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const u8) -> *mut c_void;
}

#[cfg(windows)]
type FnNtQueryInformationProcess = unsafe extern "system" fn(
    process_handle: *mut c_void,
    process_information_class: u32,
    process_information: *mut c_void,
    process_information_length: u32,
    return_length: *mut u32,
) -> i32;

#[cfg(windows)]
type FnGetExtendedTcpTable = unsafe extern "system" fn(
    p_tcp_table: *mut u8,
    pdw_size: *mut u32,
    b_order: i32,
    ul_af: u32,
    table_class: u32,
    reserved: u32,
) -> u32;

#[cfg(windows)]
unsafe fn resolve_proc(dll_nul: &[u8], proc_nul: &[u8], allow_load: bool) -> Option<*mut c_void> {
    let mut module = GetModuleHandleA(dll_nul.as_ptr());
    if module.is_null() && allow_load {
        module = LoadLibraryA(dll_nul.as_ptr());
    }
    if module.is_null() {
        return None;
    }
    let addr = GetProcAddress(module, proc_nul.as_ptr());
    if addr.is_null() {
        None
    } else {
        Some(addr)
    }
}

#[cfg(windows)]
unsafe fn read_remote_bytes(handle: *mut c_void, addr: usize, buf: &mut [u8]) -> Option<usize> {
    if addr == 0 || buf.is_empty() {
        return None;
    }
    let mut read_len: usize = 0;
    let ok = ReadProcessMemory(
        handle,
        addr as *const c_void,
        buf.as_mut_ptr() as *mut c_void,
        buf.len(),
        &mut read_len,
    );
    if ok == 0 || read_len == 0 {
        None
    } else {
        Some(read_len.min(buf.len()))
    }
}

#[cfg(windows)]
unsafe fn read_remote_struct<T: Copy>(handle: *mut c_void, addr: usize) -> Option<T> {
    if addr == 0 {
        return None;
    }
    let mut val: T = zeroed();
    let mut read_len: usize = 0;
    let ok = ReadProcessMemory(
        handle,
        addr as *const c_void,
        (&mut val as *mut T) as *mut c_void,
        size_of::<T>(),
        &mut read_len,
    );
    if ok == 0 || read_len != size_of::<T>() {
        None
    } else {
        Some(val)
    }
}

#[cfg(windows)]
unsafe fn read_process_command_line(
    pid: u32,
    nt_query: FnNtQueryInformationProcess,
) -> Option<String> {
    let handle = HandleGuard::from_raw(OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
        0,
        pid,
    ))?;

    let mut pbi: ProcessBasicInformation = zeroed();
    let mut ret_len: u32 = 0;
    let status = nt_query(
        handle.as_raw(),
        0, // ProcessBasicInformation
        (&mut pbi as *mut ProcessBasicInformation) as *mut c_void,
        size_of::<ProcessBasicInformation>() as u32,
        &mut ret_len,
    );
    if status < 0 || pbi.peb_base_address == 0 {
        return None;
    }

    let params_ptr_addr = pbi
        .peb_base_address
        .checked_add(PEB_PROCESS_PARAMETERS_OFFSET)?;
    let params_ptr: usize = read_remote_struct(handle.as_raw(), params_ptr_addr)?;
    if params_ptr == 0 {
        return None;
    }

    let cmd_unicode_addr = params_ptr.checked_add(PARAMS_COMMAND_LINE_OFFSET)?;
    let cmd_unicode: UnicodeString = read_remote_struct(handle.as_raw(), cmd_unicode_addr)?;
    if cmd_unicode.length == 0 || cmd_unicode.buffer == 0 {
        return None;
    }

    let capped_bytes = (cmd_unicode.length as usize).min(MAX_CMDLINE_BYTES) & !1;
    if capped_bytes < 2 {
        return None;
    }

    let mut raw = vec![0u8; capped_bytes];
    let read_len = read_remote_bytes(handle.as_raw(), cmd_unicode.buffer, &mut raw)? & !1;
    if read_len < 2 {
        return None;
    }

    let utf16: Vec<u16> = raw[..read_len]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let decoded = String::from_utf16_lossy(&utf16);
    Some(decoded.trim_end_matches('\0').to_string())
}

fn push_unique_port(map: &mut HashMap<u32, Vec<u16>>, pid: u32, port: u16) {
    if pid == 0 || port == 0 {
        return;
    }
    let list = map.entry(pid).or_default();
    if !list.contains(&port) {
        list.push(port);
    }
}

pub(crate) fn parse_tcp_v4_table(buf: &[u8], ports: &mut HashMap<u32, Vec<u16>>) {
    if buf.len() < 4 {
        return;
    }
    let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let row_size = std::mem::size_of::<MibTcpRowOwnerPid>();
    let max_rows = (buf.len() - 4) / row_size;
    let safe_count = count.min(max_rows);
    for idx in 0..safe_count {
        let off = 4 + idx * row_size;
        let row = unsafe { (buf.as_ptr().add(off) as *const MibTcpRowOwnerPid).read_unaligned() };
        if row.dw_state != MIB_TCP_STATE_LISTEN {
            continue;
        }
        if let Some(port) = be_port_to_host(row.dw_local_port) {
            push_unique_port(ports, row.dw_owning_pid, port);
        }
    }
}

pub(crate) fn parse_tcp_v6_table(buf: &[u8], ports: &mut HashMap<u32, Vec<u16>>) {
    if buf.len() < 4 {
        return;
    }
    let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let row_size = std::mem::size_of::<MibTcp6RowOwnerPid>();
    let max_rows = (buf.len() - 4) / row_size;
    let safe_count = count.min(max_rows);
    for idx in 0..safe_count {
        let off = 4 + idx * row_size;
        let row = unsafe { (buf.as_ptr().add(off) as *const MibTcp6RowOwnerPid).read_unaligned() };
        if row.dw_state != MIB_TCP_STATE_LISTEN {
            continue;
        }
        if let Some(port) = be_port_to_host(row.dw_local_port) {
            push_unique_port(ports, row.dw_owning_pid, port);
        }
    }
}

#[cfg(windows)]
unsafe fn query_tcp_listener_table(
    get_table: FnGetExtendedTcpTable,
    af: u32,
) -> Option<Vec<u8>> {
    let mut size: u32 = 0;
    let first = get_table(
        ptr::null_mut(),
        &mut size,
        0,
        af,
        TCP_TABLE_OWNER_PID_LISTENER,
        0,
    );
    if first != ERROR_INSUFFICIENT_BUFFER && first != NO_ERROR {
        return None;
    }
    if size == 0 || (size as usize) > MAX_TCP_TABLE_BYTES {
        return None;
    }

    for _ in 0..4 {
        let cap = (size as usize).min(MAX_TCP_TABLE_BYTES);
        let mut buf = vec![0u8; cap];
        let mut actual_size = cap as u32;
        let rc = get_table(
            buf.as_mut_ptr(),
            &mut actual_size,
            0,
            af,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if rc == NO_ERROR {
            let valid_len = (actual_size as usize).min(buf.len());
            if valid_len >= 4 {
                buf.truncate(valid_len);
            }
            return Some(buf);
        }
        if rc == ERROR_INSUFFICIENT_BUFFER && actual_size > size && (actual_size as usize) <= MAX_TCP_TABLE_BYTES {
            size = actual_size;
            continue;
        }
        return None;
    }
    None
}

#[cfg(windows)]
unsafe fn collect_listening_tcp_ports() -> Result<HashMap<u32, Vec<u16>>, String> {
    let mut ports = HashMap::new();
    let Some(proc_addr) = resolve_proc(b"iphlpapi.dll\0", b"GetExtendedTcpTable\0", true) else {
        return Err("GetExtendedTcpTable unavailable".to_string());
    };
    let get_table = std::mem::transmute::<*mut c_void, FnGetExtendedTcpTable>(proc_addr);

    let mut any_ok = false;
    if let Some(v4_buf) = query_tcp_listener_table(get_table, AF_INET) {
        parse_tcp_v4_table(&v4_buf, &mut ports);
        any_ok = true;
    }
    if let Some(v6_buf) = query_tcp_listener_table(get_table, AF_INET6) {
        parse_tcp_v6_table(&v6_buf, &mut ports);
        any_ok = true;
    }
    if !any_ok {
        return Err("GetExtendedTcpTable failed for both IPv4 and IPv6".to_string());
    }
    Ok(ports)
}

#[cfg(windows)]
fn discover_win32_processes_impl() -> Result<Vec<DiscoveredWin32Process>, String> {
    unsafe {
        let nt_addr = resolve_proc(b"ntdll.dll\0", b"NtQueryInformationProcess\0", false)
            .ok_or_else(|| "NtQueryInformationProcess unavailable".to_string())?;
        let nt_query = std::mem::transmute::<*mut c_void, FnNtQueryInformationProcess>(nt_addr);

        let snapshot = HandleGuard::from_raw(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0))
            .ok_or_else(|| "CreateToolhelp32Snapshot failed".to_string())?;

        let mut entry: ProcessEntry32W = zeroed();
        entry.dw_size = size_of::<ProcessEntry32W>() as u32;

        if Process32FirstW(snapshot.as_raw(), &mut entry) == 0 {
            return Ok(Vec::new());
        }

        let mut candidates: Vec<(u32, String)> = Vec::new();
        let mut saw_target_exe = false;
        let mut unreadable_target_error = false;
        loop {
            let nul_pos = entry
                .sz_exe_file
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.sz_exe_file.len());
            let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..nul_pos]);
            if entry.th32_process_id > 0 && is_target_process_name(&exe_name) {
                saw_target_exe = true;
                match read_process_command_line(entry.th32_process_id, nt_query) {
                    Some(cmd) => {
                        if has_standalone_flag(&cmd) {
                            candidates.push((entry.th32_process_id, cmd));
                        }
                    }
                    None => {
                        unreadable_target_error = true;
                    }
                }
            }

            entry.dw_size = size_of::<ProcessEntry32W>() as u32;
            if Process32NextW(snapshot.as_raw(), &mut entry) == 0 {
                break;
            }
        }

        if candidates.is_empty() {
            if saw_target_exe && unreadable_target_error {
                return Err("failed to inspect candidate language_server.exe command lines".to_string());
            }
            return Ok(Vec::new());
        }

        let mut tcp_ports = collect_listening_tcp_ports()?;
        let results = candidates
            .into_iter()
            .map(|(pid, command_line)| DiscoveredWin32Process {
                pid,
                command_line,
                listen_ports: tcp_ports.remove(&pid).unwrap_or_default(),
            })
            .collect();
        Ok(results)
    }
}

/// Discovers running `language_server.exe --standalone` processes and their listening TCP ports
/// directly via Win32 Toolhelp32, PEB CommandLine inspection, and `GetExtendedTcpTable`.
pub fn discover_win32_processes_json() -> Result<String, String> {
    #[cfg(windows)]
    {
        let processes = discover_win32_processes_impl()?;
        Ok(format_processes_json(&processes))
    }
    #[cfg(not(windows))]
    {
        Ok("{\"processes\":[]}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_network_byte_order_ports_and_masks_upper_bits() {
        assert_eq!(be_port_to_host(u32::from(80u16.to_be())), Some(80));
        assert_eq!(be_port_to_host(u32::from(443u16.to_be())), Some(443));
        assert_eq!(be_port_to_host(u32::from(42123u16.to_be())), Some(42123));
        assert_eq!(be_port_to_host(u32::from(65535u16.to_be())), Some(65535));
        assert_eq!(be_port_to_host(0xFFFF_0000 | u32::from(8080u16.to_be())), Some(8080));
        assert_eq!(be_port_to_host(0), None);
    }

    #[test]
    fn matches_standalone_filter_and_process_name() {
        assert!(is_target_process_name("language_server.exe"));
        assert!(is_target_process_name("LANGUAGE_SERVER.EXE"));
        assert!(!is_target_process_name("node.exe"));

        assert!(has_standalone_flag("language_server.exe --standalone --csrf_token=abc"));
        assert!(has_standalone_flag("--standalone=true"));
        assert!(has_standalone_flag("--foo --standalone"));
        assert!(!has_standalone_flag("language_server.exe --sidecar"));
        assert!(!has_standalone_flag("language_server.exe --standalone-extra"));
        assert!(!has_standalone_flag("language_server.exe --not--standalone"));
    }

    #[test]
    fn parses_synthetic_v4_and_v6_tcp_tables_with_bounds_safety() {
        let row_v4 = MibTcpRowOwnerPid {
            dw_state: MIB_TCP_STATE_LISTEN,
            dw_local_addr: 0x0100_007F,
            dw_local_port: u32::from(1234u16.to_be()),
            dw_remote_addr: 0,
            dw_remote_port: 0,
            dw_owning_pid: 42,
        };
        let mut buf_v4 = Vec::new();
        buf_v4.extend_from_slice(&10u32.to_ne_bytes()); // intentionally larger than actual rows
        let row_bytes_v4 = unsafe {
            std::slice::from_raw_parts(
                (&row_v4 as *const MibTcpRowOwnerPid) as *const u8,
                std::mem::size_of::<MibTcpRowOwnerPid>(),
            )
        };
        buf_v4.extend_from_slice(row_bytes_v4);

        let mut ports = HashMap::new();
        parse_tcp_v4_table(&buf_v4, &mut ports);
        assert_eq!(ports.get(&42), Some(&vec![1234]));

        let row_v6 = MibTcp6RowOwnerPid {
            uc_local_addr: [0; 16],
            dw_local_scope_id: 0,
            dw_local_port: u32::from(4321u16.to_be()),
            uc_remote_addr: [0; 16],
            dw_remote_scope_id: 0,
            dw_remote_port: 0,
            dw_state: MIB_TCP_STATE_LISTEN,
            dw_owning_pid: 42,
        };
        let mut buf_v6 = Vec::new();
        buf_v6.extend_from_slice(&1u32.to_ne_bytes());
        let row_bytes_v6 = unsafe {
            std::slice::from_raw_parts(
                (&row_v6 as *const MibTcp6RowOwnerPid) as *const u8,
                std::mem::size_of::<MibTcp6RowOwnerPid>(),
            )
        };
        buf_v6.extend_from_slice(row_bytes_v6);
        parse_tcp_v6_table(&buf_v6, &mut ports);
        assert_eq!(ports.get(&42), Some(&vec![1234, 4321]));
    }

    #[test]
    fn formats_escaped_json_and_discovers_without_crash() {
        let sample = vec![DiscoveredWin32Process {
            pid: 99,
            command_line: "\"C:\\Program Files\\ls.exe\" --standalone --csrf_token=x".to_string(),
            listen_ports: vec![1234, 5678],
        }];
        let formatted = format_processes_json(&sample);
        let parsed: serde_json::Value = serde_json::from_str(&formatted).expect("valid json");
        assert_eq!(parsed["processes"][0]["pid"], 99);
        assert_eq!(parsed["processes"][0]["listenPorts"][1], 5678);

        let live_json = discover_win32_processes_json().expect("win32 discovery should not fail");
        let live_parsed: serde_json::Value =
            serde_json::from_str(&live_json).expect("live discovery must return valid JSON");
        assert!(live_parsed["processes"].is_array());
    }
}
