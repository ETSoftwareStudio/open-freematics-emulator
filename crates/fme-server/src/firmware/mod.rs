//! Flashing the MK2 through its bootloader, and the local wire key and firmware images it uses.

pub mod bootloader_frame;
pub mod disk;
pub mod firmware_image;
pub mod firmware_library;
pub mod firmware_updater;
pub mod flash_plan;
pub mod intel_hex;
pub mod nsis;
pub mod vendor_package;
pub mod wire_key_store;

use std::path::Path;
use std::sync::Arc;

use crate::device::serial_ports::SerialPorts;
use crate::device::simulated_device::SimulatedDevice;
use crate::emulator::emulator_session::EmulatorSession;
use crate::traffic::traffic_log::TrafficLog;
use disk::LocalDisk;
use firmware_library::FirmwareLibrary;
use firmware_updater::FirmwareUpdater;
use vendor_package::{HttpClient, VendorPackage};
use wire_key_store::WireKeyStore;

/// The firmware services over the local data dir. RPC methods map one to one: `inspectFirmware`
/// to `updater.inspect`, `updateFirmware` to `updater.update`, `subscribeFirmwareUpdate` to
/// `updater.state`, `subscribeWireKey` to `wire_keys.changes`, `forgetWireKey` to
/// `wire_keys.forget`, `importVendorFiles` to `library.import_vendor_files`,
/// `subscribeFirmwareLibrary` to `library.images`, and `downloadVendorFirmware` to
/// `vendor_package.download`.
#[derive(Debug, Clone)]
pub struct FirmwareServices {
    pub updater: FirmwareUpdater,
    pub wire_keys: WireKeyStore,
    pub library: FirmwareLibrary,
    pub vendor_package: Arc<VendorPackage>,
}

impl FirmwareServices {
    pub async fn new(
        data_dir: &Path,
        serial_ports: SerialPorts,
        simulated: SimulatedDevice,
        session: EmulatorSession,
        traffic: TrafficLog,
        http: Arc<dyn HttpClient>,
    ) -> Self {
        let disk = LocalDisk::shared();
        let wire_keys = WireKeyStore::new(Arc::clone(&disk), data_dir).await;
        let library = FirmwareLibrary::new(disk, data_dir, wire_keys.clone()).await;
        let updater = FirmwareUpdater::new(
            serial_ports,
            simulated,
            session,
            traffic,
            wire_keys.clone(),
            library.clone(),
        );
        let vendor_package = Arc::new(VendorPackage::new(http, library.clone()));
        Self {
            updater,
            wire_keys,
            library,
            vendor_package,
        }
    }
}
