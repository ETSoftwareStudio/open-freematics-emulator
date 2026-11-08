//! Reads the firmware identity the MK2 prints on reset and compares it with the latest release.

use crate::js;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirmwareInfo {
    /// The banner version, e.g. "1.2".
    pub version: Option<String>,
    /// Six-digit YYYYMM date from the info line, e.g. "201910". It dates the unit, not the firmware:
    /// a 2019 unit flashed to V1.3 still reports 201910.
    pub date_code: Option<String>,
    pub hardware: Option<String>,
    pub serial: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfficialFirmware {
    pub version: &'static str,
    /// Freematics' official GUI + firmware download page.
    pub download_url: &'static str,
}

/// The newest image in the official GUI package (Firmware_MK2_20250311.hex, banner V1.3). Update
/// the version when Freematics publishes a newer one; the URL is the source of truth.
pub const LATEST_OFFICIAL_FIRMWARE: OfficialFirmware = OfficialFirmware {
    version: "1.3",
    download_url: "https://freematics.com/software/freematics-obd-emulator-gui/",
};

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn label_for_date_code(code: &str) -> Option<String> {
    let month: usize = code.get(4..6)?.parse().ok()?;
    let name = MONTHS.get(month.checked_sub(1)?)?;
    Some(format!("{name} {}", code.get(..4)?))
}

fn leading_digits(text: &str) -> &str {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    &text[..end]
}

/// `major.minor` at the start of `text`, as `/^(\d+)\.(\d+)/` captures it.
fn major_minor(text: &str) -> Option<(&str, &str)> {
    let major = leading_digits(text);
    let minor = leading_digits(text[major.len()..].strip_prefix('.')?);
    (!major.is_empty() && !minor.is_empty()).then_some((major, minor))
}

/// `1.2` → `1002`, for an ordered comparison of major.minor versions.
fn version_rank(version: Option<&str>) -> Option<f64> {
    let (major, minor) = major_minor(version?)?;
    Some(major.parse::<f64>().ok()? * 1000.0 + minor.parse::<f64>().ok()?)
}

/// `/v\s*(\d+\.\d+)/i`: the first `v` followed by a version number.
fn banner_version(banner: &str) -> Option<String> {
    banner.char_indices().find_map(|(i, c)| {
        if !c.eq_ignore_ascii_case(&'v') {
            return None;
        }
        let rest = banner[i + c.len_utf8()..].trim_start_matches(js::is_whitespace);
        let (major, minor) = major_minor(rest)?;
        Some(format!("{major}.{minor}"))
    })
}

fn is_date_code(field: &str) -> bool {
    field.len() == 6 && field.bytes().all(|b| b.is_ascii_digit())
}

/// Parses the reset banner (`OBD-II EMULATOR V1.2`) and info line
/// (`<fw>,<hw>,<YYYYMM>,<serial>,<vin>`) into firmware identity.
pub fn parse_firmware_info(banner: Option<&str>, details: Option<&str>) -> FirmwareInfo {
    let fields: Vec<&str> = details
        .map(|details| details.split(',').map(js::trim).collect())
        .unwrap_or_default();
    let field = |i: usize| fields.get(i).map(|field| (*field).to_owned());
    FirmwareInfo {
        version: banner.and_then(banner_version),
        date_code: field(2).filter(|field| is_date_code(field)),
        hardware: field(1),
        serial: field(3),
    }
}

/// Freematics' changelog for GUI 1.2: "Do not update for devices before 2018".
pub const OLDEST_UPDATABLE_BUILD: &str = "201801";

/// When the unit was made, from its serial (`GH201910BN05928` → `201910`). The serial's date
/// matches the build date on the one unit we have; firmware alone can't date the hardware.
pub fn manufacture_code(info: &FirmwareInfo) -> Option<String> {
    let serial = info.serial.as_deref()?;
    let bytes = serial.as_bytes();
    let matches = bytes.len() >= 8
        && bytes[..2].iter().all(u8::is_ascii_uppercase)
        && bytes[2..8].iter().all(u8::is_ascii_digit);
    let code = matches.then(|| serial[2..8].to_owned())?;
    label_for_date_code(&code).map(|_| code)
}

pub fn manufacture_label(info: &FirmwareInfo) -> Option<String> {
    label_for_date_code(&manufacture_code(info)?)
}

/// Whether the official firmware is newer than what the device reports.
fn official_is_newer(info: &FirmwareInfo) -> Option<bool> {
    let current = version_rank(info.version.as_deref())?;
    let latest = version_rank(Some(LATEST_OFFICIAL_FIRMWARE.version))?;
    Some(current < latest)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirmwareUpdateStatus {
    /// A newer official image exists and this unit is new enough for it.
    Available,
    Current,
    /// A newer image exists, but Freematics advises against it for units made before 2018.
    TooOld,
    /// A newer image exists, but the unit's age can't be read, so it isn't suggested.
    UnknownAge,
    Unknown,
}

/// Unsure means no suggestion: a wrong flash on old hardware is the one costly mistake.
pub fn firmware_update_status(info: &FirmwareInfo) -> FirmwareUpdateStatus {
    let Some(newer) = official_is_newer(info) else {
        return FirmwareUpdateStatus::Unknown;
    };
    if !newer {
        return FirmwareUpdateStatus::Current;
    }
    if let Some(made) = manufacture_code(info) {
        return if made.as_str() < OLDEST_UPDATABLE_BUILD {
            FirmwareUpdateStatus::TooOld
        } else {
            FirmwareUpdateStatus::Available
        };
    }
    if info
        .date_code
        .as_deref()
        .is_some_and(|date_code| date_code < OLDEST_UPDATABLE_BUILD)
    {
        return FirmwareUpdateStatus::TooOld;
    }
    FirmwareUpdateStatus::UnknownAge
}

pub fn firmware_update_available(info: &FirmwareInfo) -> bool {
    firmware_update_status(info) == FirmwareUpdateStatus::Available
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_and_date_a_v1_2_unit_reports() {
        let info = parse_firmware_info(
            Some("OBD-II EMULATOR V1.2"),
            Some("00.00.02,00.01.05,201910,GH201910BN05928,1HGCD5654VA061985"),
        );
        assert_eq!(
            info,
            FirmwareInfo {
                version: Some("1.2".to_owned()),
                date_code: Some("201910".to_owned()),
                hardware: Some("00.01.05".to_owned()),
                serial: Some("GH201910BN05928".to_owned()),
            }
        );
    }

    #[test]
    fn copes_with_a_missing_or_short_info_line() {
        let info = parse_firmware_info(Some("OBD-II EMULATOR V1.3"), None);
        assert_eq!(info.version.as_deref(), Some("1.3"));
        assert_eq!(info.date_code, None);
        assert_eq!(parse_firmware_info(None, None).version, None);
    }

    #[test]
    fn flags_an_update_when_the_device_is_behind_the_latest_release() {
        assert!(firmware_update_available(&parse_firmware_info(
            Some("…V1.2"),
            Some("x,y,201910,GH201910BN05928")
        )));
    }

    #[test]
    fn dates_the_unit_from_its_serial() {
        assert_eq!(
            manufacture_label(&parse_firmware_info(
                Some("…V1.2"),
                Some("x,y,201910,GH201910BN05928")
            ))
            .as_deref(),
            Some("October 2019")
        );
        assert_eq!(
            manufacture_label(&parse_firmware_info(
                Some("…V1.2"),
                Some("x,y,201910,12345")
            )),
            None
        );
    }

    #[test]
    fn doesnt_suggest_the_update_for_units_made_before_2018() {
        assert_eq!(
            firmware_update_status(&parse_firmware_info(
                Some("…V1.2"),
                Some("x,y,201910,GH201706AA00001")
            )),
            FirmwareUpdateStatus::TooOld
        );
        assert_eq!(
            firmware_update_status(&parse_firmware_info(Some("…V1.1"), Some("x,y,201705,"))),
            FirmwareUpdateStatus::TooOld
        );
    }

    #[test]
    fn doesnt_suggest_the_update_when_the_units_age_cant_be_read() {
        let info = parse_firmware_info(Some("…V1.2"), Some("x,y,201910,"));
        assert_eq!(
            firmware_update_status(&info),
            FirmwareUpdateStatus::UnknownAge
        );
        assert!(!firmware_update_available(&info));
    }

    #[test]
    fn reports_no_update_once_the_device_is_on_the_latest_version() {
        let latest = format!("…V{}", LATEST_OFFICIAL_FIRMWARE.version);
        assert!(!firmware_update_available(&parse_firmware_info(
            Some(&latest),
            Some("x,y,202503,z")
        )));
    }

    // A real 2019 unit flashed to V1.3 still reports 201910 in the date field.
    #[test]
    fn reports_no_update_for_a_unit_flashed_to_the_latest_version() {
        let info = parse_firmware_info(
            Some("OBD-II EMULATOR V1.3"),
            Some("00.00.02,00.01.08,201910,GH201910BN05928,LSGGG54EXE105928"),
        );
        assert_eq!(firmware_update_status(&info), FirmwareUpdateStatus::Current);
    }

    #[test]
    fn stays_quiet_when_the_identity_cant_be_read() {
        assert!(!firmware_update_available(&parse_firmware_info(None, None)));
    }
}
