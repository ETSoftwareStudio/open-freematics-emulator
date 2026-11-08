use crate::contracts::base_schemas::PidId;
use crate::contracts::emulator::{Readiness, ReadinessMonitorId};

/// Mode 01 PID 01, monitor status since DTCs cleared.
pub static MONITOR_STATUS_PID: PidId = PidId::from_static("0101");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorBits {
    pub label: &'static str,
    /// Byte index (B=1, C=2, D=3) and bit of the "supported" flag in PID 0101.
    pub supported: (usize, u8),
    /// Byte and bit of the "incomplete" flag; SAE sets the bit while the test has not run.
    pub incomplete: (usize, u8),
}

const fn bits(label: &'static str, supported: (usize, u8), incomplete: (usize, u8)) -> MonitorBits {
    MonitorBits {
        label,
        supported,
        incomplete,
    }
}

/// `READINESS_MONITORS[id]` in TypeScript.
pub const fn readiness_monitor(id: ReadinessMonitorId) -> MonitorBits {
    match id {
        ReadinessMonitorId::Misfire => bits("Misfire", (1, 0), (1, 4)),
        ReadinessMonitorId::FuelSystem => bits("Fuel system", (1, 1), (1, 5)),
        ReadinessMonitorId::Components => bits("Components", (1, 2), (1, 6)),
        ReadinessMonitorId::Catalyst => bits("Catalyst", (2, 0), (3, 0)),
        ReadinessMonitorId::HeatedCatalyst => bits("Heated catalyst", (2, 1), (3, 1)),
        ReadinessMonitorId::EvaporativeSystem => bits("Evaporative system", (2, 2), (3, 2)),
        ReadinessMonitorId::SecondaryAirSystem => bits("Secondary air system", (2, 3), (3, 3)),
        ReadinessMonitorId::AcRefrigerant => bits("A/C refrigerant", (2, 4), (3, 4)),
        ReadinessMonitorId::OxygenSensor => bits("Oxygen sensor", (2, 5), (3, 5)),
        ReadinessMonitorId::OxygenSensorHeater => bits("Oxygen sensor heater", (2, 6), (3, 6)),
        ReadinessMonitorId::EgrSystem => bits("EGR system", (2, 7), (3, 7)),
    }
}

pub const READINESS_MONITOR_IDS: &[ReadinessMonitorId] = ReadinessMonitorId::ALL;

/// Encodes Mode 01 PID 01 (monitor status since DTCs cleared). Byte A carries the MIL
/// and the stored DTC count, so it is derived from the Mode 03 codes.
pub fn encode_monitor_status(readiness: &Readiness, stored_dtc_count: usize) -> [u8; 4] {
    let mil = if stored_dtc_count > 0 { 0x80 } else { 0 };
    let mut bytes = [mil | (stored_dtc_count & 0x7f) as u8, 0, 0, 0];
    for &id in READINESS_MONITOR_IDS {
        let bits = readiness_monitor(id);
        let monitor = readiness.get(id);
        if monitor.supported {
            bytes[bits.supported.0] |= 1 << bits.supported.1;
        }
        if monitor.supported && !monitor.complete {
            bytes[bits.incomplete.0] |= 1 << bits.incomplete.1;
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::emulator::ReadinessMonitor;
    use crate::shared::default_state::make_default_state;

    #[test]
    fn names_the_monitor_status_pid() {
        assert_eq!(
            PidId::new(MONITOR_STATUS_PID.as_str()).ok(),
            Some(MONITOR_STATUS_PID.clone())
        );
    }

    #[test]
    fn matches_the_official_guis_defaults_with_no_dtcs() {
        assert_eq!(
            encode_monitor_status(&make_default_state().readiness, 0),
            [0x00, 0x07, 0xff, 0x00]
        );
    }

    #[test]
    fn lights_the_mil_and_counts_stored_codes() {
        assert_eq!(
            encode_monitor_status(&make_default_state().readiness, 2)[0],
            0x82
        );
    }

    #[test]
    fn flags_supported_monitors_that_have_not_completed() {
        let mut readiness = make_default_state().readiness;
        readiness.misfire = ReadinessMonitor {
            supported: true,
            complete: false,
        };
        readiness.catalyst = ReadinessMonitor {
            supported: true,
            complete: false,
        };
        readiness.egr_system = ReadinessMonitor {
            supported: false,
            complete: false,
        };
        assert_eq!(
            encode_monitor_status(&readiness, 0),
            [0x00, 0x17, 0x7f, 0x01]
        );
    }
}
