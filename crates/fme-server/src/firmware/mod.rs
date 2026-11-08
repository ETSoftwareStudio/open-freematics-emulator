//! Flashing the MK2 through its bootloader, and the local wire key and firmware images it uses.

pub mod bootloader_frame;
pub mod disk;
pub mod firmware_image;
pub mod firmware_library;
pub mod firmware_updater;
pub mod flash_plan;
pub mod intel_hex;
pub mod wire_key_store;
