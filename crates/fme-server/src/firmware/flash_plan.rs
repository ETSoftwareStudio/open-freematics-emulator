//! The MK2's STM32 flash layout.

pub const FLASH_BASE: u32 = 0x0800_0000;
/// The vendor bootloader lives below this and is the only recovery path, so nothing may erase or
/// write under it.
pub const APPLICATION_BASE: u32 = 0x0800_3800;
