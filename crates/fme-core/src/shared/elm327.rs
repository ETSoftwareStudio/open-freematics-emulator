//! Parsing for ELM327-compatible OBD-II adapters (the common Bluetooth and Wi-Fi dongles).
//! Assumes the adapter is set up with echo, line feeds and headers off (ATE0 ATL0 ATH0).

use crate::js;

/// Lines that mean the vehicle side did not answer. `ERROR` also covers `CAN ERROR`,
/// `BUS ERROR` and `BUS INIT: ...ERROR`.
fn is_no_answer_line(line: &str) -> bool {
    ["NO DATA", "UNABLE TO CONNECT", "STOPPED", "?", "ERROR"]
        .iter()
        .any(|needle| line.contains(needle))
}

pub fn is_no_answer<S: AsRef<str>>(lines: &[S]) -> bool {
    lines
        .iter()
        .map(AsRef::as_ref)
        .all(|line| is_no_answer_line(line) || line.contains("SEARCHING"))
}

fn strip_frame_index(line: &str) -> &str {
    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    match line[digits..].strip_prefix(':') {
        Some(rest) if digits > 0 => rest.trim_start_matches(js::is_whitespace),
        _ => line,
    }
}

fn hex_tokens(line: &str) -> Vec<u8> {
    strip_frame_index(line)
        .split(js::is_whitespace)
        .filter(|token| token.len() == 2 && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .filter_map(|token| u8::from_str_radix(token, 16).ok())
        .collect()
}

/// Data bytes of a Mode 01 reply (`41 0C 1F 40` → `[0x1F, 0x40]`), from the first ECU that answered.
pub fn parse_pid_reply<S: AsRef<str>>(lines: &[S], pid: &str) -> Option<Vec<u8>> {
    let pid_byte = pid.get(2..).and_then(js::parse_int_hex)?;
    lines.iter().find_map(|line| {
        let bytes = hex_tokens(line.as_ref());
        match bytes.as_slice() {
            [0x41, byte, data @ ..] if f64::from(*byte) == pid_byte => Some(data.to_vec()),
            _ => None,
        }
    })
}

const DTC_LETTERS: [char; 4] = ['P', 'C', 'B', 'U'];

pub fn decode_dtc(high: u8, low: u8) -> String {
    format!(
        "{}{}{:X}{:02X}",
        DTC_LETTERS[usize::from(high >> 6)],
        (high >> 4) & 0x3,
        high & 0xf,
        low
    )
}

/// Codes from a Mode 03/07/0A reply. CAN replies carry a count byte after the service byte
/// (`43 02 01 05 03 00`); older buses send three code slots per line, zero-padded.
pub fn parse_dtc_reply<S: AsRef<str>>(lines: &[S], service: u8, is_can: bool) -> Vec<String> {
    let reply_byte = u16::from(service) + 0x40;
    let mut codes = Vec::new();
    for line in lines {
        let bytes = hex_tokens(line.as_ref());
        if bytes.first().map(|b| u16::from(*b)) != Some(reply_byte) {
            continue;
        }
        let data = bytes.get(if is_can { 2 } else { 1 }..).unwrap_or_default();
        for &[high, low] in data.as_chunks::<2>().0 {
            if high != 0 || low != 0 {
                codes.push(decode_dtc(high, low));
            }
        }
    }
    codes
}

fn is_iso_tp_length(line: &str) -> bool {
    let line = js::trim(line);
    line.len() == 3 && line.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The VIN from a Mode 09 PID 02 reply. CAN replies arrive as an ISO-TP sequence
/// (`014`, `0: 49 02 01 31 48 47`, `1: ...`); older buses as `49 02 0N` + 4 bytes per line.
pub fn parse_vin_reply<S: AsRef<str>>(lines: &[S]) -> Option<String> {
    let mut bytes = Vec::new();
    for line in lines.iter().map(AsRef::as_ref) {
        if is_iso_tp_length(line) {
            continue;
        }
        let tokens = hex_tokens(line);
        match tokens.as_slice() {
            [0x49, 0x02, rest @ ..] => bytes.extend(rest.iter().skip(1)),
            _ => bytes.extend(tokens),
        }
    }
    let vin: String = bytes
        .into_iter()
        .filter(|byte| (0x30..=0x5a).contains(byte))
        .map(char::from)
        .collect();
    (vin.len() >= 17).then(|| vin[vin.len() - 17..].to_owned())
}

/// Protocol numbers 6–9 (ATDPN) are CAN. `A6` means chosen automatically.
pub fn is_can_protocol(describe_protocol_number: &str) -> bool {
    let value = js::trim(describe_protocol_number);
    let value = value
        .strip_prefix(['A', 'a'])
        .filter(|rest| rest.len() == 1)
        .unwrap_or(value);
    matches!(value, "6" | "7" | "8" | "9")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pid_data() {
        type Case<'a> = (&'a [&'a str], &'a str, Option<Vec<u8>>);
        let cases: [Case; 4] = [
            (&["41 0C 1F 40"], "010C", Some(vec![0x1f, 0x40])),
            (&["7E8 03 41 0D 58", "41 0D 58"], "010D", Some(vec![0x58])),
            (&["SEARCHING...", "41 05 82"], "0105", Some(vec![0x82])),
            (&["NO DATA"], "0105", None),
        ];
        for (lines, pid, bytes) in cases {
            assert_eq!(parse_pid_reply(lines, pid), bytes, "{lines:?}");
        }
    }

    #[test]
    fn decodes_dtc_bytes() {
        for (high, low, code) in [
            (0x01, 0x05, "P0105"),
            (0x03, 0x00, "P0300"),
            (0x41, 0x23, "C0123"),
            (0xc1, 0x00, "U0100"),
        ] {
            assert_eq!(decode_dtc(high, low), code);
        }
    }

    #[test]
    fn reads_dtcs_from_can_and_legacy_replies() {
        assert_eq!(
            parse_dtc_reply(&["43 02 01 05 03 00"], 0x03, true),
            ["P0105", "P0300"]
        );
        assert_eq!(
            parse_dtc_reply(&["43 01 05 03 00 00 00"], 0x03, false),
            ["P0105", "P0300"]
        );
        assert!(parse_dtc_reply(&["43 00"], 0x03, true).is_empty());
    }

    #[test]
    fn reassembles_a_multi_frame_can_vin() {
        assert_eq!(
            parse_vin_reply(&[
                "014",
                "0: 49 02 01 31 48 47",
                "1: 43 44 35 36 35 34 56",
                "2: 41 30 36 31 39 38 35",
            ])
            .as_deref(),
            Some("1HGCD5654VA061985")
        );
    }

    #[test]
    fn reassembles_a_legacy_bus_vin() {
        assert_eq!(
            parse_vin_reply(&[
                "49 02 01 00 00 00 31",
                "49 02 02 48 47 43 44",
                "49 02 03 35 36 35 34",
                "49 02 04 56 41 30 36",
                "49 02 05 31 39 38 35",
            ])
            .as_deref(),
            Some("1HGCD5654VA061985")
        );
    }

    #[test]
    fn recognizes_silence_and_can_protocols() {
        assert!(is_no_answer(&["SEARCHING...", "UNABLE TO CONNECT"]));
        assert!(!is_no_answer(&["41 0C 1F 40"]));
        assert!(is_can_protocol("A6"));
        assert!(!is_can_protocol("3"));
    }
}
