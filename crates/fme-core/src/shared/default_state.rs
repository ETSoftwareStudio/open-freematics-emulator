use crate::contracts::emulator::{
    Connection, Dtcs, EmulatorState, ObdProtocol, Readiness, ReadinessMonitor,
};
use crate::shared::pids::PIDS;

pub fn make_default_state() -> EmulatorState {
    EmulatorState {
        connection: Connection::Disconnected,
        capabilities: None,
        ignition: true,
        protocol: ObdProtocol::Can11b500k,
        vin_enabled: true,
        vin: None,
        calibration_id: None,
        dtcs: Dtcs::default(),
        pids: PIDS
            .iter()
            .map(|definition| (definition.id.clone(), definition.default_value))
            .collect(),
        readiness: Readiness::all(ReadinessMonitor {
            supported: true,
            complete: true,
        }),
        last_preset: None,
    }
}
