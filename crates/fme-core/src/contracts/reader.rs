use effect_rpc::{schema, string_enum, tagged_struct};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::base_schemas::PidId;

fn tcp_port<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    schema::checked(deserializer, "ReaderTarget.port", |port: &u16| *port >= 1)
}

/// Where the OBD-II adapter (ELM327-compatible) plugged into the emulator is reachable.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum ReaderTarget {
    /// Bluetooth SPP or USB adapters show up as serial ports.
    Serial {
        #[serde(deserialize_with = "schema::non_empty_string")]
        path: String,
    },
    /// Wi-Fi adapters, usually 192.168.0.10:35000.
    Tcp {
        #[serde(deserialize_with = "schema::non_empty_string")]
        host: String,
        #[serde(deserialize_with = "tcp_port")]
        port: u16,
    },
    /// A simulated adapter reading the simulated emulator.
    Simulated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum ReaderConnection {
    Disconnected,
    Connecting {
        target: ReaderTarget,
    },
    Connected {
        target: ReaderTarget,
        adapter: String,
        /// ATDPN, e.g. `A6`; null until the vehicle side answers.
        protocol: Option<String>,
    },
    Failed {
        target: ReaderTarget,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PidReading {
    #[serde(with = "schema::number")]
    pub value: f64,
    pub raw: Vec<u8>,
    pub at: u64,
}

/// How often each watched PID is read, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PollInterval {
    Ms250,
    Ms500,
    Ms1000,
    Ms2000,
}

impl PollInterval {
    pub const ALL: &'static [Self] = &[Self::Ms250, Self::Ms500, Self::Ms1000, Self::Ms2000];

    pub const fn millis(self) -> u16 {
        match self {
            Self::Ms250 => 250,
            Self::Ms500 => 500,
            Self::Ms1000 => 1000,
            Self::Ms2000 => 2000,
        }
    }
}

impl TryFrom<u16> for PollInterval {
    type Error = schema::InvalidValue;

    fn try_from(millis: u16) -> Result<Self, Self::Error> {
        Self::ALL
            .iter()
            .copied()
            .find(|interval| interval.millis() == millis)
            .ok_or_else(|| schema::InvalidValue::new("PollInterval", millis.to_string()))
    }
}

impl Serialize for PollInterval {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u16(self.millis())
    }
}

impl<'de> Deserialize<'de> for PollInterval {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::try_from(u16::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PollingSettings {
    pub paused: bool,
    pub interval: PollInterval,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderState {
    pub connection: ReaderConnection,
    /// PIDs polled continuously while connected.
    pub watching: Vec<PidId>,
    pub polling: PollingSettings,
    /// Requests per second over the last poll cycle; 0 while paused or idle.
    pub poll_rate: u32,
    pub readings: IndexMap<PidId, PidReading>,
    /// Watched PIDs whose last poll got no answer (`NO DATA`) from the vehicle side.
    pub unanswered: Vec<PidId>,
    /// Whether the last poll got an answer from the vehicle side.
    pub vehicle_responding: bool,
    /// Supply voltage the adapter measures on the OBD port (`ATRV`).
    #[serde(with = "schema::number_or_null")]
    pub voltage: Option<f64>,
    pub dtcs: Option<Vec<String>>,
    /// When the codes were last read, with PID 0101 (MIL and readiness) read alongside.
    pub dtcs_at: Option<u64>,
    pub monitor_status: Option<Vec<u8>>,
    pub vin: Option<String>,
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("The OBD-II adapter is not connected.")]
    pub struct ReaderNotConnectedError("ReaderNotConnectedError") {}
}

string_enum! {
    pub enum ReaderCommandReason {
        NoAnswer => "no-answer",
        Rejected => "rejected",
        Timeout => "timeout",
        Link => "link",
    }
}

impl ReaderCommandReason {
    fn message(self, command: &str) -> String {
        match self {
            Self::NoAnswer => format!("The vehicle did not answer {command}. Is the ignition on?"),
            Self::Rejected => format!("The vehicle refused {command}."),
            Self::Timeout => format!("The OBD-II adapter did not answer {command} in time."),
            Self::Link => {
                format!("The connection to the OBD-II adapter failed while sending {command}.")
            }
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message(.command))]
    pub struct ReaderCommandError("ReaderCommandError") {
        pub command: String,
        pub reason: ReaderCommandReason,
    }
}

string_enum! {
    pub enum ReaderConnectReason {
        OpenFailed => "open-failed",
        NoAdapter => "no-adapter",
        BluetoothStale => "bluetooth-stale",
        LinkLost => "link-lost",
    }
}

impl ReaderConnectReason {
    fn message(self) -> &'static str {
        match self {
            Self::OpenFailed => "Could not reach the OBD-II adapter.",
            Self::NoAdapter => "The device did not answer like an ELM327 OBD-II adapter.",
            Self::BluetoothStale => {
                "The Bluetooth adapter didn't answer. macOS stops serving a Bluetooth serial port after it's closed once. Forget the adapter in System Settings → Bluetooth, pair it again, then connect."
            }
            Self::LinkLost => "The connection to the OBD-II adapter dropped while connecting.",
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message())]
    pub struct ReaderConnectError("ReaderConnectError") {
        pub target: ReaderTarget,
        pub reason: ReaderConnectReason,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(untagged)]
pub enum ReaderOperationError {
    #[error(transparent)]
    NotConnected(#[from] ReaderNotConnectedError),
    #[error(transparent)]
    Command(#[from] ReaderCommandError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_only_the_listed_poll_intervals() {
        assert_eq!(
            serde_json::from_str::<PollInterval>("500").ok(),
            Some(PollInterval::Ms500)
        );
        assert!(serde_json::from_str::<PollInterval>("750").is_err());
    }

    #[test]
    fn rejects_port_zero() {
        let target = r#"{"_tag":"tcp","host":"192.168.0.10","port":0}"#;
        assert!(serde_json::from_str::<ReaderTarget>(target).is_err());
    }
}
