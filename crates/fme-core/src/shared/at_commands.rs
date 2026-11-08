//! Builders for the MK2 control command set (`AT` in TypeScript). The firmware answers
//! commands with `OK` or `ERROR`, and `ATGET` queries with a single value line.

use crate::contracts::base_schemas::{DtcCode, PidId};
use crate::contracts::emulator::{DtcMode, ObdProtocol};
use crate::js;

pub const fn echo(on: bool) -> &'static str {
    if on { "ATE1" } else { "ATE0" }
}

pub const fn debug_output(on: bool) -> &'static str {
    if on { "ATINF1" } else { "ATINF0" }
}

pub const fn ignition(on: bool) -> &'static str {
    if on { "ATACC1" } else { "ATACC0" }
}

pub const fn vin_response(on: bool) -> &'static str {
    if on { "ATVIN1" } else { "ATVIN0" }
}

pub const RESET: &str = "ATR";
pub const INIT: &str = "ATZ";
pub const GET_PROTOCOL: &str = "ATGET BUS";
pub const GET_VIN: &str = "ATGET VIN";
pub const GET_CALIBRATION_ID: &str = "ATGET CALID";
pub const CLEAR_DTCS: &str = "ATCLR DTC";

pub fn set_protocol(protocol: ObdProtocol) -> String {
    format!("ATBUS {protocol}")
}

pub fn set_vin(vin: &str) -> String {
    format!("ATSET VIN={vin}")
}

pub fn set_calibration_id(calibration_id: &str) -> String {
    format!("ATSET CALID={calibration_id}")
}

pub fn set_dtcs(mode: DtcMode, codes: &[DtcCode]) -> String {
    let key = match mode {
        DtcMode::Stored => "DTC",
        DtcMode::Pending => "DTC7",
        DtcMode::Permanent => "DTCA",
    };
    let codes: Vec<&str> = codes.iter().map(DtcCode::as_str).collect();
    format!("ATSET {key}={}", codes.join(","))
}

pub fn set_pid_decimal(pid: &PidId, value: f64) -> String {
    format!("ATSET {pid}={}", js::number_to_string(value))
}

pub fn set_pid_raw(pid: &PidId, bytes: &[u8]) -> String {
    let bytes: Vec<String> = bytes.iter().map(|byte| format!("0x{byte:02X}")).collect();
    format!("ATSET {pid}={}", bytes.join(","))
}

pub fn get_pid(pid: &PidId) -> String {
    format!("ATGET {pid}")
}

pub fn is_ok_line(line: &str) -> bool {
    line == "OK"
}

pub fn is_error_line(line: &str) -> bool {
    line.contains("ERROR")
}

fn has_hex_prefix(part: &str) -> bool {
    part.get(..2)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("0x"))
}

/// Parses `ATSET <PID>=` raw values: `0x31,0x64` or `31,64` style byte lists.
pub fn parse_raw_bytes(value: &str) -> Option<Vec<u8>> {
    let parts: Vec<&str> = value.split(',').map(js::trim).collect();
    if parts.len() < 2 && !parts.first().is_some_and(|part| has_hex_prefix(part)) {
        return None;
    }
    parts
        .iter()
        .map(|part| {
            let digits = if has_hex_prefix(part) {
                &part[2..]
            } else {
                part
            };
            js::parse_int_hex(digits)
                .filter(|byte| (0.0..=255.0).contains(byte))
                .map(|byte| byte as u8)
        })
        .collect()
}

pub fn format_hex_bytes(bytes: &[u8]) -> String {
    let bytes: Vec<String> = bytes.iter().map(|byte| format!("{byte:02X}")).collect();
    bytes.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_raw_pid_bytes_the_way_the_firmware_documents_them() {
        assert_eq!(
            set_pid_raw(&PidId::new("010C").unwrap(), &[0x1f, 0x40]),
            "ATSET 010C=0x1F,0x40"
        );
    }

    #[test]
    fn maps_each_dtc_mode_to_its_command() {
        let codes = [
            DtcCode::new("P0105").unwrap(),
            DtcCode::new("P0106").unwrap(),
        ];
        assert_eq!(set_dtcs(DtcMode::Stored, &codes), "ATSET DTC=P0105,P0106");
        assert_eq!(set_dtcs(DtcMode::Pending, &codes), "ATSET DTC7=P0105,P0106");
        assert_eq!(
            set_dtcs(DtcMode::Permanent, &codes),
            "ATSET DTCA=P0105,P0106"
        );
    }

    #[test]
    fn parses_raw_values() {
        for (input, expected) in [
            ("0x31,0x64", Some(vec![0x31, 0x64])),
            ("31,64", Some(vec![0x31, 0x64])),
            ("0xFF", Some(vec![0xff])),
            ("2000", None),
            ("0x1FF", None),
        ] {
            assert_eq!(parse_raw_bytes(input), expected, "{input}");
        }
    }

    #[test]
    fn formats_decimal_pid_values_like_javascript() {
        let pid = PidId::new("0142").unwrap();
        assert_eq!(set_pid_decimal(&pid, 14.2), "ATSET 0142=14.2");
        assert_eq!(set_pid_decimal(&pid, 1000.0), "ATSET 0142=1000");
    }
}
