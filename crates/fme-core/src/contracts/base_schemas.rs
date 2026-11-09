fn is_upper_hex(c: char) -> bool {
    matches!(c, '0'..='9' | 'A'..='F')
}

fn is_pid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 4 && value.starts_with("01") && value[2..].chars().all(is_upper_hex)
}

fn is_dtc_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && matches!(bytes[0], b'P' | b'C' | b'B' | b'U')
        && matches!(bytes[1], b'0'..=b'3')
        && value[2..].chars().all(is_upper_hex)
}

fn is_vin(value: &str) -> bool {
    value.len() == 17
        && value.chars().all(|c| {
            c.is_ascii_digit() || (c.is_ascii_uppercase() && !matches!(c, 'I' | 'O' | 'Q'))
        })
}

fn is_calibration_id(value: &str) -> bool {
    (1..=16).contains(&value.len()) && value.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

branded_string! {
    /// A Mode 01 PID as the emulator addresses it: mode byte + PID byte, e.g. `010C`.
    pub struct PidId;
    check = is_pid_id;
}

branded_string! {
    /// SAE J2012 trouble code, e.g. `P0105`.
    pub struct DtcCode;
    check = is_dtc_code;
}

branded_string! {
    /// ISO 3779 VIN: 17 characters, no I, O or Q.
    pub struct Vin;
    check = is_vin;
}

branded_string! {
    /// Calibration ID (Mode 09 PID 04); the firmware stores it as ASCII, 16 characters max.
    pub struct CalibrationId;
    check = is_calibration_id;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_branded_patterns() {
        assert!(PidId::new("010C").is_ok());
        assert!(PidId::new("010c").is_err());
        assert!(PidId::new("020C").is_err());
        assert!(DtcCode::new("U3FFF").is_ok());
        assert!(DtcCode::new("P4000").is_err());
        assert!(DtcCode::new("P010").is_err());
        assert!(Vin::new("1HGCD5654VA061985").is_ok());
        assert!(Vin::new("1HGCD5654VA06198O").is_err());
        assert!(Vin::new("1HGCD5654VA06198").is_err());
        assert!(CalibrationId::new("JMB*36761500").is_ok());
        assert!(CalibrationId::new("").is_err());
        assert!(CalibrationId::new("ABCDEFGHIJKLMNOPQ").is_err());
        assert!(CalibrationId::new("tab\there").is_err());
    }

    #[test]
    fn rejects_invalid_values_when_decoding() {
        assert!(serde_json::from_str::<PidId>("\"010C\"").is_ok());
        assert!(serde_json::from_str::<PidId>("\"P0105\"").is_err());
    }
}
