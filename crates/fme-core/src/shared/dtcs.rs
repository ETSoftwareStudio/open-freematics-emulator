use crate::contracts::base_schemas::PidId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DtcEntry {
    pub code: &'static str,
    pub description: &'static str,
}

const fn entry(code: &'static str, description: &'static str) -> DtcEntry {
    DtcEntry { code, description }
}

/// Common generic (SAE J2012) codes. Codes outside it get a category from `describe_dtc`.
pub static DTC_CATALOG: [DtcEntry; 90] = [
    entry("P0100", "Mass air flow circuit malfunction"),
    entry("P0101", "Mass air flow circuit range/performance"),
    entry("P0102", "Mass air flow circuit low input"),
    entry("P0103", "Mass air flow circuit high input"),
    entry("P0105", "Manifold absolute pressure circuit malfunction"),
    entry(
        "P0106",
        "Manifold absolute pressure circuit range/performance",
    ),
    entry("P0107", "Manifold absolute pressure circuit low input"),
    entry("P0108", "Manifold absolute pressure circuit high input"),
    entry("P0110", "Intake air temperature circuit malfunction"),
    entry("P0112", "Intake air temperature circuit low input"),
    entry("P0113", "Intake air temperature circuit high input"),
    entry("P0115", "Engine coolant temperature circuit malfunction"),
    entry(
        "P0116",
        "Engine coolant temperature circuit range/performance",
    ),
    entry("P0117", "Engine coolant temperature circuit low input"),
    entry("P0118", "Engine coolant temperature circuit high input"),
    entry("P0120", "Throttle position sensor A circuit malfunction"),
    entry(
        "P0121",
        "Throttle position sensor A circuit range/performance",
    ),
    entry("P0122", "Throttle position sensor A circuit low input"),
    entry("P0123", "Throttle position sensor A circuit high input"),
    entry(
        "P0125",
        "Insufficient coolant temperature for closed loop fuel control",
    ),
    entry("P0128", "Coolant thermostat below regulating temperature"),
    entry("P0130", "O2 sensor circuit malfunction (bank 1 sensor 1)"),
    entry("P0131", "O2 sensor circuit low voltage (bank 1 sensor 1)"),
    entry("P0132", "O2 sensor circuit high voltage (bank 1 sensor 1)"),
    entry("P0133", "O2 sensor circuit slow response (bank 1 sensor 1)"),
    entry(
        "P0134",
        "O2 sensor circuit no activity detected (bank 1 sensor 1)",
    ),
    entry(
        "P0135",
        "O2 sensor heater circuit malfunction (bank 1 sensor 1)",
    ),
    entry("P0136", "O2 sensor circuit malfunction (bank 1 sensor 2)"),
    entry(
        "P0141",
        "O2 sensor heater circuit malfunction (bank 1 sensor 2)",
    ),
    entry("P0150", "O2 sensor circuit malfunction (bank 2 sensor 1)"),
    entry(
        "P0155",
        "O2 sensor heater circuit malfunction (bank 2 sensor 1)",
    ),
    entry("P0171", "System too lean (bank 1)"),
    entry("P0172", "System too rich (bank 1)"),
    entry("P0174", "System too lean (bank 2)"),
    entry("P0175", "System too rich (bank 2)"),
    entry("P0200", "Injector circuit malfunction"),
    entry("P0201", "Injector circuit malfunction, cylinder 1"),
    entry("P0202", "Injector circuit malfunction, cylinder 2"),
    entry("P0203", "Injector circuit malfunction, cylinder 3"),
    entry("P0204", "Injector circuit malfunction, cylinder 4"),
    entry("P0217", "Engine overtemperature condition"),
    entry("P0230", "Fuel pump primary circuit malfunction"),
    entry("P0300", "Random/multiple cylinder misfire detected"),
    entry("P0301", "Cylinder 1 misfire detected"),
    entry("P0302", "Cylinder 2 misfire detected"),
    entry("P0303", "Cylinder 3 misfire detected"),
    entry("P0304", "Cylinder 4 misfire detected"),
    entry("P0305", "Cylinder 5 misfire detected"),
    entry("P0306", "Cylinder 6 misfire detected"),
    entry("P0307", "Cylinder 7 misfire detected"),
    entry("P0308", "Cylinder 8 misfire detected"),
    entry("P0325", "Knock sensor 1 circuit malfunction (bank 1)"),
    entry("P0335", "Crankshaft position sensor A circuit malfunction"),
    entry("P0340", "Camshaft position sensor circuit malfunction"),
    entry(
        "P0351",
        "Ignition coil A primary/secondary circuit malfunction",
    ),
    entry("P0400", "Exhaust gas recirculation flow malfunction"),
    entry("P0401", "Exhaust gas recirculation flow insufficient"),
    entry("P0402", "Exhaust gas recirculation flow excessive"),
    entry("P0410", "Secondary air injection system malfunction"),
    entry(
        "P0420",
        "Catalyst system efficiency below threshold (bank 1)",
    ),
    entry(
        "P0430",
        "Catalyst system efficiency below threshold (bank 2)",
    ),
    entry("P0440", "Evaporative emission system malfunction"),
    entry("P0441", "Evaporative emission system incorrect purge flow"),
    entry(
        "P0442",
        "Evaporative emission system leak detected (small leak)",
    ),
    entry(
        "P0446",
        "Evaporative emission system vent control circuit malfunction",
    ),
    entry(
        "P0455",
        "Evaporative emission system leak detected (large leak)",
    ),
    entry(
        "P0456",
        "Evaporative emission system leak detected (very small leak)",
    ),
    entry("P0500", "Vehicle speed sensor malfunction"),
    entry("P0505", "Idle control system malfunction"),
    entry("P0506", "Idle control system RPM lower than expected"),
    entry("P0507", "Idle control system RPM higher than expected"),
    entry("P0560", "System voltage malfunction"),
    entry("P0562", "System voltage low"),
    entry("P0563", "System voltage high"),
    entry("P0600", "Serial communication link malfunction"),
    entry("P0601", "Internal control module memory checksum error"),
    entry("P0700", "Transmission control system malfunction"),
    entry("P0715", "Input/turbine speed sensor circuit malfunction"),
    entry("P0720", "Output speed sensor circuit malfunction"),
    entry("P0740", "Torque converter clutch circuit malfunction"),
    entry("C0035", "Left front wheel speed sensor circuit"),
    entry("C0040", "Right front wheel speed sensor circuit"),
    entry("C0045", "Left rear wheel speed sensor circuit"),
    entry("C0050", "Right rear wheel speed sensor circuit"),
    entry("U0001", "High speed CAN communication bus"),
    entry("U0100", "Lost communication with ECM/PCM A"),
    entry("U0101", "Lost communication with TCM"),
    entry("U0121", "Lost communication with ABS control module"),
    entry("U0140", "Lost communication with body control module"),
    entry("U0155", "Lost communication with instrument panel cluster"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtcDescription {
    pub description: String,
    pub known: bool,
}

fn system(letter: Option<char>) -> &'static str {
    match letter {
        Some('P') => "Powertrain",
        Some('C') => "Chassis",
        Some('B') => "Body",
        Some('U') => "Network",
        _ => "Unknown",
    }
}

/// A catalog description, or the system and whether the code is generic or maker-specific.
pub fn describe_dtc(code: &str) -> DtcDescription {
    let upper = code.to_uppercase();
    if let Some(entry) = DTC_CATALOG.iter().find(|entry| entry.code == upper) {
        return DtcDescription {
            description: entry.description.to_owned(),
            known: true,
        };
    }
    let mut chars = code.chars();
    let first = chars.next();
    let second = chars.next();
    let system = system(first.map(|c| c.to_ascii_uppercase()));
    // The second character is 1 (and 3 for most systems) for manufacturer-defined codes.
    let maker_specific = second == Some('1') || (first != Some('P') && second == Some('3'));
    let kind = if maker_specific {
        "Manufacturer-specific"
    } else {
        "Generic"
    };
    DtcDescription {
        description: format!("{kind} {} code", system.to_lowercase()),
        known: false,
    }
}

/// Counters SAE J1979 Mode 04 (clear diagnostic information) resets to zero.
pub static PIDS_RESET_BY_CLEAR: [PidId; 5] = [
    PidId::from_static("0121"),
    PidId::from_static("014D"),
    PidId::from_static("0130"),
    PidId::from_static("0131"),
    PidId::from_static("014E"),
];

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::contracts::base_schemas::DtcCode;
    use crate::shared::pids::find_pid;

    #[test]
    fn lists_each_code_once_in_a_valid_format() {
        let codes: HashSet<&str> = DTC_CATALOG.iter().map(|entry| entry.code).collect();
        assert_eq!(codes.len(), DTC_CATALOG.len());
        for code in codes {
            assert!(DtcCode::new(code).is_ok(), "{code}");
        }
    }

    #[test]
    fn names_known_codes_regardless_of_case() {
        assert_eq!(
            describe_dtc("p0420"),
            DtcDescription {
                description: "Catalyst system efficiency below threshold (bank 1)".to_owned(),
                known: true,
            }
        );
        assert_eq!(
            describe_dtc("P0304").description,
            "Cylinder 4 misfire detected"
        );
    }

    #[test]
    fn falls_back_to_the_system_and_who_defines_the_code() {
        assert_eq!(
            describe_dtc("P1234"),
            DtcDescription {
                description: "Manufacturer-specific powertrain code".to_owned(),
                known: false,
            }
        );
        assert_eq!(describe_dtc("B0999").description, "Generic body code");
        assert_eq!(
            describe_dtc("U3001").description,
            "Manufacturer-specific network code"
        );
    }

    #[test]
    fn resets_only_counters_the_pid_catalog_knows() {
        for pid in &PIDS_RESET_BY_CLEAR {
            assert!(find_pid(pid).is_some(), "{pid}");
        }
    }
}
