pub const WIRE_VARINT: u8 = 0;
pub const WIRE_64BIT: u8 = 1;
pub const WIRE_LEN: u8 = 2;
pub const WIRE_START_GROUP: u8 = 3;
pub const WIRE_END_GROUP: u8 = 4;
pub const WIRE_32BIT: u8 = 5;

/// Reads a standard base-128 varint (up to 10 bytes), advancing `*pos`.
/// Returns `None` on EOF or overflow.
#[inline]
pub fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift: u32 = 0;
    for i in 0..10 {
        if *pos >= buf.len() {
            return None;
        }
        let byte = buf[*pos];
        *pos += 1;
        if i == 9 && byte > 1 {
            return None;
        }
        result |= ((byte & 0x7F) as u64) << shift;
        if (byte & 0x80) == 0 {
            return Some(result);
        }
        shift += 7;
    }
    None
}

#[inline]
pub fn read_varint_i32(buf: &[u8], pos: &mut usize) -> Option<i32> {
    read_varint(buf, pos).map(|v| v as i32)
}

#[inline]
pub fn read_varint_i64(buf: &[u8], pos: &mut usize) -> Option<i64> {
    read_varint(buf, pos).map(|v| v as i64)
}

pub const MAX_PROTO_DEPTH: usize = 64;

/// Reads tag varint, returns `(field_number, wire_type)`.
/// Returns `None` if at EOF, `field_num == 0`, or `field_num` exceeds 29-bit Protobuf max.
#[inline]
pub fn read_tag(buf: &[u8], pos: &mut usize) -> Option<(u32, u8)> {
    if *pos >= buf.len() {
        return None;
    }
    let tag = read_varint(buf, pos)?;
    let raw_field = tag >> 3;
    if raw_field == 0 || raw_field > 0x1FFF_FFFF {
        return None;
    }
    let field_num = raw_field as u32;
    let wire_type = (tag & 0x07) as u8;
    Some((field_num, wire_type))
}

/// Reads length varint `len`, checks `*pos + len <= buf.len()`, advances `*pos`,
/// and returns `&buf[start..start + len]`.
#[inline]
pub fn read_len_delimited<'a>(buf: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let len_u64 = read_varint(buf, pos)?;
    let len = usize::try_from(len_u64).ok()?;
    let end = (*pos).checked_add(len)?;
    if end > buf.len() {
        return None;
    }
    let slice = &buf[*pos..end];
    *pos = end;
    Some(slice)
}

/// Reads length-delimited bytes and converts via `std::str::from_utf8(bytes).ok()`.
#[inline]
pub fn read_str<'a>(buf: &'a [u8], pos: &mut usize) -> Option<&'a str> {
    let bytes = read_len_delimited(buf, pos)?;
    std::str::from_utf8(bytes).ok()
}

/// Reads length-delimited bytes and converts via `String::from_utf8_lossy(bytes).into_owned()`.
#[inline]
pub fn read_string_lossy(buf: &[u8], pos: &mut usize) -> Option<String> {
    let bytes = read_len_delimited(buf, pos)?;
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// Skips a field of the given wire type, advancing `*pos`.
#[inline]
pub fn skip_field(buf: &[u8], pos: &mut usize, wire_type: u8) -> bool {
    skip_field_depth(buf, pos, wire_type, 0)
}

pub fn skip_field_depth(buf: &[u8], pos: &mut usize, wire_type: u8, depth: usize) -> bool {
    if depth >= MAX_PROTO_DEPTH {
        return false;
    }
    match wire_type {
        WIRE_VARINT => read_varint(buf, pos).is_some(),
        WIRE_64BIT => {
            if let Some(end) = (*pos).checked_add(8) {
                if end <= buf.len() {
                    *pos = end;
                    return true;
                }
            }
            false
        }
        WIRE_LEN => read_len_delimited(buf, pos).is_some(),
        WIRE_32BIT => {
            if let Some(end) = (*pos).checked_add(4) {
                if end <= buf.len() {
                    *pos = end;
                    return true;
                }
            }
            false
        }
        WIRE_START_GROUP => {
            while let Some((_field, wt)) = read_tag(buf, pos) {
                if wt == WIRE_END_GROUP {
                    return true;
                }
                if !skip_field_depth(buf, pos, wt, depth + 1) {
                    return false;
                }
            }
            false
        }
        _ => false,
    }
}

/// Iterates through `buf` reading varints and pushing `v as u32` into `out`.
pub fn read_packed_u32(buf: &[u8], out: &mut Vec<u32>) {
    let mut pos = 0;
    while pos < buf.len() {
        if let Some(v) = read_varint(buf, &mut pos) {
            out.push(v as u32);
        } else {
            break;
        }
    }
}

/// Parses `google.protobuf.Timestamp` (`1: seconds` int64 varint, `2: nanos` int32 varint)
/// and formats it as an ISO-8601 UTC string matching Go `protojson`.
pub fn parse_timestamp_iso(buf: &[u8]) -> Option<String> {
    let mut pos = 0;
    let mut seconds: i64 = 0;
    let mut nanos: i32 = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_VARINT) => {
                seconds = read_varint_i64(buf, &mut pos)?;
            }
            (2, WIRE_VARINT) => {
                nanos = read_varint_i32(buf, &mut pos)?;
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    return None;
                }
            }
        }
    }
    if seconds <= 0 && nanos <= 0 {
        return None;
    }

    let days = seconds.div_euclid(86400);
    let sec_of_day = seconds.rem_euclid(86400) as u32;
    let hour = sec_of_day / 3600;
    let minute = (sec_of_day % 3600) / 60;
    let second = sec_of_day % 60;

    // Howard Hinnant's civil-from-days algorithm
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    if nanos <= 0 {
        Some(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            year, m, d, hour, minute, second
        ))
    } else {
        let frac_full = format!("{:09}", nanos);
        let frac = frac_full.trim_end_matches('0');
        Some(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{}Z",
            year, m, d, hour, minute, second, frac
        ))
    }
}

/// Parses `google.protobuf.Duration` (`1: seconds` int64 varint, `2: nanos` int32 varint)
/// and formats it as a Go `protojson` duration string (`"<seconds>.<frac>s"` or `"<seconds>s"`).
pub fn parse_duration_string(buf: &[u8]) -> Option<String> {
    let mut pos = 0;
    let mut seconds: i64 = 0;
    let mut nanos: i32 = 0;
    while let Some((field_num, wire_type)) = read_tag(buf, &mut pos) {
        match (field_num, wire_type) {
            (1, WIRE_VARINT) => {
                seconds = read_varint_i64(buf, &mut pos)?;
            }
            (2, WIRE_VARINT) => {
                nanos = read_varint_i32(buf, &mut pos)?;
            }
            _ => {
                if !skip_field(buf, &mut pos, wire_type) {
                    return None;
                }
            }
        }
    }
    if nanos == 0 {
        Some(format!("{}s", seconds))
    } else {
        let frac_full = format!("{:09}", nanos.unsigned_abs());
        let frac = frac_full.trim_end_matches('0');
        if seconds == 0 && nanos < 0 {
            Some(format!("-0.{}s", frac))
        } else {
            Some(format!("{}.{}s", seconds, frac))
        }
    }
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

    #[test]
    fn test_varint_and_tags() {
        let mut buf = Vec::new();
        encode_varint(0, &mut buf);
        encode_varint(127, &mut buf);
        encode_varint(128, &mut buf);
        encode_varint(300, &mut buf);
        encode_varint(u64::MAX, &mut buf);

        let mut pos = 0;
        assert_eq!(read_varint(&buf, &mut pos), Some(0));
        assert_eq!(read_varint(&buf, &mut pos), Some(127));
        assert_eq!(read_varint(&buf, &mut pos), Some(128));
        assert_eq!(read_varint(&buf, &mut pos), Some(300));
        assert_eq!(read_varint(&buf, &mut pos), Some(u64::MAX));
        assert_eq!(read_varint(&buf, &mut pos), None);

        // Tag test: field 15, wire type 2 (len-delimited) -> (15 << 3) | 2 = 122
        let tag_buf = [122u8];
        let mut tpos = 0;
        assert_eq!(read_tag(&tag_buf, &mut tpos), Some((15, WIRE_LEN)));
    }

    #[test]
    fn test_skip_field_and_packed_u32() {
        let mut packed = Vec::new();
        encode_varint(1, &mut packed);
        encode_varint(14, &mut packed);
        encode_varint(1035, &mut packed);
        let mut out = Vec::new();
        read_packed_u32(&packed, &mut out);
        assert_eq!(out, vec![1, 14, 1035]);

        // Skip 64-bit, 32-bit, len-delimited, group
        let mut skip_buf = Vec::new();
        skip_buf.extend_from_slice(&[0u8; 8]); // 64-bit
        skip_buf.extend_from_slice(&[0u8; 4]); // 32-bit
        skip_buf.extend_from_slice(&[3, b'a', b'b', b'c']); // len 3
        // Start group field 4: (4 << 3)|3 = 35, inner field 1 varint 42: 8, 42, end group field 4: (4 << 3)|4 = 36
        skip_buf.extend_from_slice(&[8, 42, 36]);

        let mut pos = 0;
        assert!(skip_field(&skip_buf, &mut pos, WIRE_64BIT));
        assert!(skip_field(&skip_buf, &mut pos, WIRE_32BIT));
        assert!(skip_field(&skip_buf, &mut pos, WIRE_LEN));
        assert!(skip_field(&skip_buf, &mut pos, WIRE_START_GROUP));
        assert_eq!(pos, skip_buf.len());
    }

    #[test]
    fn test_parse_timestamp_iso() {
        // 2026-04-17T12:34:56.789Z -> unix seconds = 1776429296, nanos = 789_000_000
        let mut buf = Vec::new();
        encode_varint((1 << 3) | (WIRE_VARINT as u64), &mut buf);
        encode_varint(1776429296, &mut buf);
        encode_varint((2 << 3) | (WIRE_VARINT as u64), &mut buf);
        encode_varint(789_000_000, &mut buf);
        assert_eq!(
            parse_timestamp_iso(&buf).as_deref(),
            Some("2026-04-17T12:34:56.789Z")
        );

        // Leap year 2024-02-29T00:00:00Z -> 1709164800, nanos = 0
        let mut leap_buf = Vec::new();
        encode_varint((1 << 3) | (WIRE_VARINT as u64), &mut leap_buf);
        encode_varint(1709164800, &mut leap_buf);
        assert_eq!(
            parse_timestamp_iso(&leap_buf).as_deref(),
            Some("2024-02-29T00:00:00Z")
        );

        // Empty / zero timestamp returns None
        assert_eq!(parse_timestamp_iso(&[]), None);
    }

    #[test]
    fn test_parse_duration_string() {
        let mut buf = Vec::new();
        encode_varint((1 << 3) | (WIRE_VARINT as u64), &mut buf);
        encode_varint(12, &mut buf);
        encode_varint((2 << 3) | (WIRE_VARINT as u64), &mut buf);
        encode_varint(340_000_000, &mut buf);
        assert_eq!(parse_duration_string(&buf).as_deref(), Some("12.34s"));

        let mut buf_exact = Vec::new();
        encode_varint((1 << 3) | (WIRE_VARINT as u64), &mut buf_exact);
        encode_varint(5, &mut buf_exact);
        assert_eq!(parse_duration_string(&buf_exact).as_deref(), Some("5s"));
    }
}
