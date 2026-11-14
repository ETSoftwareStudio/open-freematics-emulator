use effect_rpc::{schema, string_enum, tagged_struct};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};

use super::base_schemas::{CalibrationId, DtcCode, PidId, Vin};
use super::presets::PresetRef;

string_enum! {
    pub enum ObdProtocol {
        Can11b500k => "CAN_11B_500K",
        Can11b250k => "CAN_11B_250K",
        Can29b500k => "CAN_29B_500K",
        Can29b250k => "CAN_29B_250K",
        Iso9141_2 => "ISO9141_2",
        Kwp2000Fast => "KWP2000_FAST",
        Kwp2000_5bps => "KWP2000_5BPS",
        J1850Pwm => "J1850_PWM",
        J1850Vpw => "J1850_VPW",
        J1939 => "J1939",
    }
}

string_enum! {
    /// Service modes that report trouble codes: stored (03), pending (07), permanent (0A).
    pub enum DtcMode {
        Stored => "03",
        Pending => "07",
        Permanent => "0A",
    }
}

pub const MAX_DTCS_PER_MODE: usize = 6;

pub type DtcList = Vec<DtcCode>;

fn dtc_list<'de, D: Deserializer<'de>>(deserializer: D) -> Result<DtcList, D::Error> {
    schema::checked(deserializer, "DtcList", |codes: &DtcList| {
        codes.len() <= MAX_DTCS_PER_MODE
    })
}

string_enum! {
    pub enum ReadinessMonitorId {
        Misfire => "misfire",
        FuelSystem => "fuelSystem",
        Components => "components",
        Catalyst => "catalyst",
        HeatedCatalyst => "heatedCatalyst",
        EvaporativeSystem => "evaporativeSystem",
        SecondaryAirSystem => "secondaryAirSystem",
        AcRefrigerant => "acRefrigerant",
        OxygenSensor => "oxygenSensor",
        OxygenSensorHeater => "oxygenSensorHeater",
        EgrSystem => "egrSystem",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ReadinessMonitor {
    pub supported: bool,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum ConnectTarget {
    Serial {
        #[serde(deserialize_with = "schema::non_empty_string")]
        path: String,
    },
    Simulated,
}

string_enum! {
    pub enum SerialPortTransport {
        Usb => "usb",
        Bluetooth => "bluetooth",
        Other => "other",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    pub transport: SerialPortTransport,
    /// USB VID/PID matches a bridge the MK2 ships with (CP2102 or CH340).
    pub likely_emulator: bool,
}

/// What the firmware prints on reset: `OBD-II EMULATOR V1.2` and a comma-separated info line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub banner: String,
    pub details: Option<String>,
}

/// What the connected firmware accepts, probed on connect. V1.2 takes Mode 03 codes only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilities {
    pub dtc_modes: Vec<DtcMode>,
    pub calibration_id: bool,
}

/// An edit staged while disconnected that the firmware can't take, so connect didn't send it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "_tag",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UnsentEdit {
    Dtcs {
        mode: DtcMode,
        #[serde(deserialize_with = "dtc_list")]
        codes: DtcList,
    },
    CalibrationId {
        calibration_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum Connection {
    Disconnected,
    Connecting {
        target: ConnectTarget,
    },
    Connected {
        target: ConnectTarget,
        device: Option<DeviceInfo>,
        unsent: Vec<UnsentEdit>,
    },
    Failed {
        target: ConnectTarget,
        reason: String,
    },
}

/// `Schema.Struct({ "03": DtcList, "07": DtcList, "0A": DtcList })`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dtcs {
    #[serde(rename = "03", deserialize_with = "dtc_list")]
    pub stored: DtcList,
    #[serde(rename = "07", deserialize_with = "dtc_list")]
    pub pending: DtcList,
    #[serde(rename = "0A", deserialize_with = "dtc_list")]
    pub permanent: DtcList,
}

impl Dtcs {
    pub fn get(&self, mode: DtcMode) -> &DtcList {
        match mode {
            DtcMode::Stored => &self.stored,
            DtcMode::Pending => &self.pending,
            DtcMode::Permanent => &self.permanent,
        }
    }

    pub fn get_mut(&mut self, mode: DtcMode) -> &mut DtcList {
        match mode {
            DtcMode::Stored => &mut self.stored,
            DtcMode::Pending => &mut self.pending,
            DtcMode::Permanent => &mut self.permanent,
        }
    }
}

/// `Schema.Record(ReadinessMonitorId, ReadinessMonitor)`: every monitor has an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub misfire: ReadinessMonitor,
    pub fuel_system: ReadinessMonitor,
    pub components: ReadinessMonitor,
    pub catalyst: ReadinessMonitor,
    pub heated_catalyst: ReadinessMonitor,
    pub evaporative_system: ReadinessMonitor,
    pub secondary_air_system: ReadinessMonitor,
    pub ac_refrigerant: ReadinessMonitor,
    pub oxygen_sensor: ReadinessMonitor,
    pub oxygen_sensor_heater: ReadinessMonitor,
    pub egr_system: ReadinessMonitor,
}

impl Readiness {
    pub const fn all(monitor: ReadinessMonitor) -> Self {
        Self {
            misfire: monitor,
            fuel_system: monitor,
            components: monitor,
            catalyst: monitor,
            heated_catalyst: monitor,
            evaporative_system: monitor,
            secondary_air_system: monitor,
            ac_refrigerant: monitor,
            oxygen_sensor: monitor,
            oxygen_sensor_heater: monitor,
            egr_system: monitor,
        }
    }

    pub fn get(&self, id: ReadinessMonitorId) -> ReadinessMonitor {
        let mut copy = *self;
        *copy.get_mut(id)
    }

    pub fn get_mut(&mut self, id: ReadinessMonitorId) -> &mut ReadinessMonitor {
        match id {
            ReadinessMonitorId::Misfire => &mut self.misfire,
            ReadinessMonitorId::FuelSystem => &mut self.fuel_system,
            ReadinessMonitorId::Components => &mut self.components,
            ReadinessMonitorId::Catalyst => &mut self.catalyst,
            ReadinessMonitorId::HeatedCatalyst => &mut self.heated_catalyst,
            ReadinessMonitorId::EvaporativeSystem => &mut self.evaporative_system,
            ReadinessMonitorId::SecondaryAirSystem => &mut self.secondary_air_system,
            ReadinessMonitorId::AcRefrigerant => &mut self.ac_refrigerant,
            ReadinessMonitorId::OxygenSensor => &mut self.oxygen_sensor,
            ReadinessMonitorId::OxygenSensorHeater => &mut self.oxygen_sensor_heater,
            ReadinessMonitorId::EgrSystem => &mut self.egr_system,
        }
    }
}

/// Everything the server believes is configured on the device. Values are the
/// last ones the device acknowledged; the firmware cannot report most of them back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorState {
    pub connection: Connection,
    /// What the firmware took on the last connect; kept after disconnect, null before the first.
    pub capabilities: Option<DeviceCapabilities>,
    pub ignition: bool,
    pub protocol: ObdProtocol,
    pub vin_enabled: bool,
    /// Read from the device on connect; the firmware keeps it across resets.
    pub vin: Option<String>,
    pub calibration_id: Option<String>,
    pub dtcs: Dtcs,
    #[serde(with = "schema::number_record")]
    pub pids: IndexMap<PidId, f64>,
    pub readiness: Readiness,
    /// Kept when PIDs are edited afterwards; compare against the preset to show the edits.
    pub last_preset: Option<PresetRef>,
}

string_enum! {
    /// The emulator's control port, or the OBD-II adapter reading it.
    pub enum TrafficChannel {
        Emulator => "emulator",
        Reader => "reader",
    }
}

string_enum! {
    pub enum TrafficDirection {
        Tx => "tx",
        Rx => "rx",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrafficEntry {
    pub sequence: u64,
    pub channel: TrafficChannel,
    pub at: u64,
    pub direction: TrafficDirection,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetPidInput {
    pub pid: PidId,
    #[serde(with = "schema::finite")]
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetDtcsInput {
    pub mode: DtcMode,
    #[serde(deserialize_with = "dtc_list")]
    pub codes: DtcList,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetReadinessInput {
    pub monitor: ReadinessMonitorId,
    pub supported: bool,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetVinInput {
    pub vin: Vin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCalibrationIdInput {
    pub calibration_id: CalibrationId,
}

fn raw_command<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    schema::checked(deserializer, "SendRawInput.command", |command: &String| {
        command.len() >= 2
            && command[..2].eq_ignore_ascii_case("AT")
            && command.bytes().all(|b| (0x20..=0x7e).contains(&b))
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendRawInput {
    #[serde(deserialize_with = "raw_command")]
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendRawResult {
    pub lines: Vec<String>,
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("The emulator is not connected.")]
    pub struct EmulatorNotConnectedError("EmulatorNotConnectedError") {}
}

string_enum! {
    pub enum EmulatorCommandReason {
        Rejected => "rejected",
        Timeout => "timeout",
        Link => "link",
    }
}

impl EmulatorCommandReason {
    fn message(self, command: &str) -> String {
        match self {
            Self::Rejected => format!("The emulator rejected {command}."),
            Self::Timeout => format!("The emulator did not answer {command} in time."),
            Self::Link => format!("The connection to the emulator failed while sending {command}."),
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message(.command))]
    pub struct EmulatorCommandError("EmulatorCommandError") {
        pub command: String,
        pub reason: EmulatorCommandReason,
    }
}

string_enum! {
    pub enum EmulatorConnectReason {
        OpenFailed => "open-failed",
        NoHandshake => "no-handshake",
        SetupFailed => "setup-failed",
        UpdateRunning => "update-running",
    }
}

impl EmulatorConnectReason {
    fn message(self) -> &'static str {
        match self {
            Self::OpenFailed => "Could not open the serial port.",
            Self::NoHandshake => "The device did not answer like a Freematics emulator.",
            Self::SetupFailed => "The emulator rejected its initial configuration.",
            Self::UpdateRunning => "A firmware update is running. Connect when it finishes.",
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message())]
    pub struct EmulatorConnectError("EmulatorConnectError") {
        pub target: ConnectTarget,
        pub reason: EmulatorConnectReason,
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("Could not list serial ports.")]
    pub struct SerialPortListError("SerialPortListError") {}
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(untagged)]
pub enum EmulatorOperationError {
    #[error(transparent)]
    NotConnected(#[from] EmulatorNotConnectedError),
    #[error(transparent)]
    Command(#[from] EmulatorCommandError),
}
