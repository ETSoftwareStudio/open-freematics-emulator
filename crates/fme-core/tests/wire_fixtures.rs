//! Every fixture under `tests/fixtures` was encoded by the TypeScript contracts
//! (`vp run rs:fixtures`). Each value must decode into its Rust type and encode back to the same
//! JSON, keys in the same order.
#![cfg(test)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use fme_core::contracts::base_schemas::*;
use fme_core::contracts::emulator::*;
use fme_core::contracts::firmware::*;
use fme_core::contracts::presets::*;
use fme_core::contracts::reader::*;
use fme_core::contracts::rpc::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Debug, Serialize, serde::Deserialize)]
enum Never {}

fn fixtures_dir(kind: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(kind)
}

fn read(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn round_trip<T: DeserializeOwned + Serialize>(label: &str, values: &Value) -> usize {
    let values = values.as_array().unwrap();
    for (index, value) in values.iter().enumerate() {
        let decoded: T = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("{label}[{index}] did not decode: {error}"));
        let encoded = serde_json::to_value(&decoded).unwrap();
        assert_eq!(&encoded, value, "{label}[{index}] encoded differently");
        assert_eq!(
            serde_json::to_string(&encoded).unwrap(),
            serde_json::to_string(value).unwrap(),
            "{label}[{index}] encoded its keys in another order"
        );
    }
    values.len()
}

fn fixture_files(kind: &str) -> BTreeSet<String> {
    fs::read_dir(fixtures_dir(kind))
        .unwrap()
        .map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".json").unwrap().to_owned()
        })
        .collect()
}

macro_rules! type_fixtures {
    ($($name:ident),* $(,)?) => {
        const TYPE_NAMES: &[&str] = &[$(stringify!($name)),*];

        fn check_type(name: &str, values: &Value) -> usize {
            match name {
                $(stringify!($name) => round_trip::<$name>(name, values),)*
                _ => panic!("No Rust type is registered for the {name} fixture"),
            }
        }
    };
}

type_fixtures! {
    PidId,
    DtcCode,
    Vin,
    CalibrationId,
    PresetId,
    ObdProtocol,
    DtcMode,
    ReadinessMonitorId,
    ReadinessMonitor,
    ConnectTarget,
    SerialPortInfo,
    DeviceInfo,
    DeviceCapabilities,
    UnsentEdit,
    Connection,
    EmulatorState,
    TrafficEntry,
    SetPidInput,
    SetDtcsInput,
    SetReadinessInput,
    SetVinInput,
    SetCalibrationIdInput,
    SendRawInput,
    SendRawResult,
    EmulatorNotConnectedError,
    EmulatorCommandError,
    EmulatorConnectError,
    SerialPortListError,
    EmulatorOperationError,
    FirmwareUpdateStage,
    FirmwareUpdateState,
    InspectFirmwareInput,
    FirmwareImageSummary,
    FirmwareImageSource,
    FirmwareUpdateInput,
    FirmwareImageError,
    FirmwareUpdateError,
    ImportWireKeyInput,
    WireKeyStatus,
    WireKeyError,
    LibraryImage,
    ImportVendorFilesInput,
    VendorImportResult,
    VendorDownloadError,
    VendorImportError,
    Preset,
    PresetRef,
    SavePresetInput,
    PresetNotFoundError,
    PresetReadOnlyError,
    PresetPersistError,
    PresetChangeError,
    ReaderTarget,
    ReaderConnection,
    PidReading,
    PollInterval,
    PollingSettings,
    ReaderState,
    ReaderNotConnectedError,
    ReaderCommandError,
    ReaderConnectError,
    ReaderOperationError,
}

macro_rules! rpc_fixtures {
    ($($method:path => ($payload:ty, $success:ty, $error:ty)),* $(,)?) => {
        const RPC_METHODS: &[&str] = &[$($method),*];

        fn check_rpc(method: &str, fixture: &Value) -> usize {
            $(
                if method == $method {
                    return round_trip::<$payload>(&format!("{method}.payload"), &fixture["payload"])
                        + round_trip::<$success>(&format!("{method}.success"), &fixture["success"])
                        + round_trip::<$error>(&format!("{method}.error"), &fixture["error"]);
                }
            )*
            panic!("No Rust types are registered for the {method} RPC")
        }
    };
}

rpc_fixtures! {
    ws_methods::LIST_PORTS => ((), Vec<SerialPortInfo>, SerialPortListError),
    ws_methods::CONNECT => (ConnectPayload, (), EmulatorConnectError),
    ws_methods::DISCONNECT => ((), (), Never),
    ws_methods::SET_IGNITION => (SetIgnitionPayload, (), EmulatorOperationError),
    ws_methods::SET_PROTOCOL => (SetProtocolPayload, (), EmulatorOperationError),
    ws_methods::SET_VIN_ENABLED => (SetVinEnabledPayload, (), EmulatorOperationError),
    ws_methods::SET_VIN => (SetVinInput, (), EmulatorOperationError),
    ws_methods::SET_CALIBRATION_ID => (SetCalibrationIdInput, (), EmulatorOperationError),
    ws_methods::SET_PID => (SetPidInput, (), EmulatorOperationError),
    ws_methods::SET_DTCS => (SetDtcsInput, (), EmulatorOperationError),
    ws_methods::CLEAR_DTCS => (ClearDtcsPayload, (), EmulatorOperationError),
    ws_methods::SET_READINESS => (SetReadinessInput, (), EmulatorOperationError),
    ws_methods::SEND_RAW => (SendRawInput, SendRawResult, EmulatorOperationError),
    ws_methods::SUBSCRIBE_STATE => ((), EmulatorState, Never),
    ws_methods::SUBSCRIBE_TRAFFIC => ((), TrafficEntry, Never),
    ws_methods::READER_CONNECT => (ReaderConnectPayload, (), ReaderConnectError),
    ws_methods::READER_DISCONNECT => ((), (), Never),
    ws_methods::READER_WATCH => (ReaderWatchPayload, (), Never),
    ws_methods::READER_READ_DTCS => ((), (), ReaderOperationError),
    ws_methods::READER_READ_VIN => ((), (), ReaderOperationError),
    ws_methods::READER_CLEAR_DTCS => ((), (), ReaderOperationError),
    ws_methods::READER_SET_POLLING => (PollingSettings, (), Never),
    ws_methods::READER_READ_ONCE => ((), (), ReaderOperationError),
    ws_methods::READER_SUBSCRIBE_STATE => ((), ReaderState, Never),
    ws_methods::SUBSCRIBE_PRESETS => ((), Vec<Preset>, Never),
    ws_methods::APPLY_PRESET => (PresetIdPayload, (), ApplyPresetError),
    ws_methods::SAVE_PRESET => (SavePresetInput, Preset, PresetChangeError),
    ws_methods::DELETE_PRESET => (PresetIdPayload, (), PresetChangeError),
    ws_methods::INSPECT_FIRMWARE => (InspectFirmwareInput, FirmwareImageSummary, FirmwareImageError),
    ws_methods::UPDATE_FIRMWARE => (FirmwareUpdateInput, (), UpdateFirmwareError),
    ws_methods::SUBSCRIBE_FIRMWARE_UPDATE => ((), FirmwareUpdateState, Never),
    ws_methods::SUBSCRIBE_WIRE_KEY => ((), WireKeyStatus, Never),
    ws_methods::IMPORT_VENDOR_FILES => (ImportVendorFilesInput, VendorImportResult, VendorImportError),
    ws_methods::DOWNLOAD_VENDOR_FIRMWARE => ((), VendorImportResult, DownloadVendorFirmwareError),
    ws_methods::SUBSCRIBE_FIRMWARE_LIBRARY => ((), Vec<LibraryImage>, Never),
    ws_methods::FORGET_WIRE_KEY => ((), (), WireKeyError),
}

#[test]
fn every_contract_type_round_trips_its_typescript_encoding() {
    let files = fixture_files("types");
    let registered: BTreeSet<String> = TYPE_NAMES.iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(
        files, registered,
        "fixture files and registered types differ"
    );
    let checked: usize = files
        .iter()
        .map(|name| {
            check_type(
                name,
                &read(&fixtures_dir("types").join(format!("{name}.json"))),
            )
        })
        .sum();
    assert!(checked > files.len());
}

#[test]
fn every_rpc_payload_success_and_error_round_trips_its_typescript_encoding() {
    let files = fixture_files("rpc");
    let registered: BTreeSet<String> = RPC_METHODS.iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(
        files, registered,
        "fixture files and registered RPCs differ"
    );
    let checked: usize = files
        .iter()
        .map(|method| {
            check_rpc(
                method,
                &read(&fixtures_dir("rpc").join(format!("{method}.json"))),
            )
        })
        .sum();
    assert!(checked > files.len());
}

#[test]
fn tagged_errors_reject_another_tag() {
    let value =
        serde_json::json!({ "_tag": "ReaderCommandError", "command": "ATZ", "reason": "timeout" });
    assert!(serde_json::from_value::<EmulatorCommandError>(value.clone()).is_err());
    assert!(serde_json::from_value::<EmulatorOperationError>(value.clone()).is_err());
    assert!(matches!(
        serde_json::from_value::<ReaderOperationError>(value),
        Ok(ReaderOperationError::Command(_))
    ));
}

#[test]
fn rejects_payloads_the_typescript_schemas_reject() {
    for (payload, label) in [
        (r#"{"pid":"010C","value":"NaN"}"#, "a non-finite PID value"),
        (r#"{"pid":"0x0C","value":1}"#, "a malformed PID"),
    ] {
        assert!(
            serde_json::from_str::<SetPidInput>(payload).is_err(),
            "{label}"
        );
    }
    let too_many =
        r#"{"mode":"03","codes":["P0100","P0101","P0102","P0103","P0105","P0106","P0107"]}"#;
    assert!(serde_json::from_str::<SetDtcsInput>(too_many).is_err());
    assert!(serde_json::from_str::<SendRawInput>(r#"{"command":"ZZ"}"#).is_err());
    assert!(serde_json::from_str::<SendRawInput>(r#"{"command":"AT\r"}"#).is_err());
    assert!(
        serde_json::from_str::<ConnectPayload>(r#"{"target":{"_tag":"serial","path":""}}"#)
            .is_err()
    );
    let short_key = r#"{"target":{"_tag":"simulated"},"image":{"_tag":"library","name":"a.hex"},"wireKey":"00"}"#;
    assert!(serde_json::from_str::<FirmwareUpdateInput>(short_key).is_err());
    assert!(serde_json::from_str::<ImportWireKeyInput>(r#"{"binary":"Zg"}"#).is_err());
}
