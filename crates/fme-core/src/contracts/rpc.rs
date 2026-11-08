//! The RPC method names and the payload and error types `rpc.ts` declares inline. Methods
//! without a payload or success schema use `Schema.Void`, which encodes as `null`: `()` here.

use serde::{Deserialize, Serialize};

use super::base_schemas::PidId;
use super::emulator::{
    ConnectTarget, EmulatorCommandError, EmulatorNotConnectedError, EmulatorOperationError,
    ObdProtocol,
};
use super::firmware::{
    FirmwareImageError, FirmwareUpdateError, VendorDownloadError, VendorImportError,
};
use super::presets::{PresetId, PresetNotFoundError};
use super::reader::ReaderTarget;

pub mod ws_methods {
    pub const LIST_PORTS: &str = "emulator.listPorts";
    pub const CONNECT: &str = "emulator.connect";
    pub const DISCONNECT: &str = "emulator.disconnect";
    pub const SET_IGNITION: &str = "emulator.setIgnition";
    pub const SET_PROTOCOL: &str = "emulator.setProtocol";
    pub const SET_VIN_ENABLED: &str = "emulator.setVinEnabled";
    pub const SET_VIN: &str = "emulator.setVin";
    pub const SET_CALIBRATION_ID: &str = "emulator.setCalibrationId";
    pub const SET_PID: &str = "emulator.setPid";
    pub const SET_DTCS: &str = "emulator.setDtcs";
    pub const CLEAR_DTCS: &str = "emulator.clearDtcs";
    pub const SET_READINESS: &str = "emulator.setReadiness";
    pub const SEND_RAW: &str = "emulator.sendRaw";
    pub const SUBSCRIBE_STATE: &str = "emulator.subscribeState";
    pub const SUBSCRIBE_TRAFFIC: &str = "emulator.subscribeTraffic";
    pub const READER_CONNECT: &str = "reader.connect";
    pub const READER_DISCONNECT: &str = "reader.disconnect";
    pub const READER_WATCH: &str = "reader.watch";
    pub const READER_READ_DTCS: &str = "reader.readDtcs";
    pub const READER_READ_VIN: &str = "reader.readVin";
    pub const READER_CLEAR_DTCS: &str = "reader.clearDtcs";
    pub const READER_SET_POLLING: &str = "reader.setPolling";
    pub const READER_READ_ONCE: &str = "reader.readOnce";
    pub const READER_SUBSCRIBE_STATE: &str = "reader.subscribeState";
    pub const SUBSCRIBE_PRESETS: &str = "presets.subscribe";
    pub const APPLY_PRESET: &str = "presets.apply";
    pub const SAVE_PRESET: &str = "presets.save";
    pub const DELETE_PRESET: &str = "presets.delete";
    pub const INSPECT_FIRMWARE: &str = "firmware.inspect";
    pub const UPDATE_FIRMWARE: &str = "firmware.update";
    pub const SUBSCRIBE_FIRMWARE_UPDATE: &str = "firmware.subscribeUpdate";
    pub const SUBSCRIBE_WIRE_KEY: &str = "firmware.subscribeWireKey";
    pub const IMPORT_VENDOR_FILES: &str = "firmware.importVendorFiles";
    pub const DOWNLOAD_VENDOR_FIRMWARE: &str = "firmware.downloadVendorFirmware";
    pub const SUBSCRIBE_FIRMWARE_LIBRARY: &str = "firmware.subscribeLibrary";
    pub const FORGET_WIRE_KEY: &str = "firmware.forgetWireKey";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectPayload {
    pub target: ConnectTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetIgnitionPayload {
    pub on: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetProtocolPayload {
    pub protocol: ObdProtocol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetVinEnabledPayload {
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClearDtcsPayload {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReaderConnectPayload {
    pub target: ReaderTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReaderWatchPayload {
    pub pids: Vec<PidId>,
}

/// The payload of `presets.apply` and `presets.delete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetIdPayload {
    pub id: PresetId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(untagged)]
pub enum ApplyPresetError {
    #[error(transparent)]
    PresetNotFound(#[from] PresetNotFoundError),
    #[error(transparent)]
    NotConnected(#[from] EmulatorNotConnectedError),
    #[error(transparent)]
    Command(#[from] EmulatorCommandError),
}

impl From<EmulatorOperationError> for ApplyPresetError {
    fn from(error: EmulatorOperationError) -> Self {
        match error {
            EmulatorOperationError::NotConnected(error) => Self::NotConnected(error),
            EmulatorOperationError::Command(error) => Self::Command(error),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(untagged)]
pub enum UpdateFirmwareError {
    #[error(transparent)]
    Image(#[from] FirmwareImageError),
    #[error(transparent)]
    Update(#[from] FirmwareUpdateError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(untagged)]
pub enum DownloadVendorFirmwareError {
    #[error(transparent)]
    Download(#[from] VendorDownloadError),
    #[error(transparent)]
    Import(#[from] VendorImportError),
}
