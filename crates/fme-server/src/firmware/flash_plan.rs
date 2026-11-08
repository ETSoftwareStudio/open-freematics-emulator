//! The MK2's STM32 flash layout, what the bootloader is asked to erase and write for an image, and
//! the payloads that carry it.

use super::intel_hex::FirmwareImage;

pub const FLASH_BASE: u32 = 0x0800_0000;
/// The vendor bootloader lives below this and is the only recovery path, so nothing may erase or
/// write under it.
pub const APPLICATION_BASE: u32 = 0x0800_3800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlashErase {
    pub address: u32,
    pub pages: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlashBlock {
    pub address: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlashPlan {
    pub page_size: u32,
    /// The whole application area up to the end of flash, as the vendor updater erases it.
    pub erase: FlashErase,
    /// Page-sized (or shorter) chunks of each segment, in address order.
    pub writes: Vec<FlashBlock>,
    pub run_address: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlashPlanReason {
    FlashSize,
    BelowApplication,
    StartAddress,
    BeyondFlash,
}

impl FlashPlanReason {
    fn message(self) -> &'static str {
        match self {
            Self::FlashSize => "The device reported a flash size the updater can't use.",
            Self::BelowApplication => "The image writes into the bootloader area.",
            Self::StartAddress => "The image doesn't start at the application base address.",
            Self::BeyondFlash => "The image is larger than the device's flash.",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{}", .reason.message())]
pub struct FlashPlanError {
    pub reason: FlashPlanReason,
}

impl From<FlashPlanReason> for FlashPlanError {
    fn from(reason: FlashPlanReason) -> Self {
        Self { reason }
    }
}

pub fn plan_flash(image: &FirmwareImage, flash_kib: u32) -> Result<FlashPlan, FlashPlanError> {
    // The vendor updater picks the page size from the reported capacity, not the image size.
    let page_size: u32 = if flash_kib < 256 { 1024 } else { 2048 };
    let flash_end = u64::from(FLASH_BASE) + u64::from(flash_kib) * 1024;
    let span = i128::from(flash_end) - i128::from(APPLICATION_BASE);
    let pages = span / i128::from(page_size);
    if span % i128::from(page_size) != 0 || !(1..=0xffff).contains(&pages) {
        return Err(FlashPlanReason::FlashSize.into());
    }
    let (Some(first), Some(last)) = (image.segments.first(), image.segments.last()) else {
        return Err(FlashPlanReason::StartAddress.into());
    };
    if first.address < u64::from(APPLICATION_BASE) {
        return Err(FlashPlanReason::BelowApplication.into());
    }
    if first.address != u64::from(APPLICATION_BASE) {
        return Err(FlashPlanReason::StartAddress.into());
    }
    if last.address + last.data.len() as u64 > flash_end {
        return Err(FlashPlanReason::BeyondFlash.into());
    }
    // Every address below is at most `flash_end`, which the page count keeps under 4 GiB.
    let writes = image
        .segments
        .iter()
        .flat_map(|segment| {
            segment
                .data
                .chunks(page_size as usize)
                .enumerate()
                .map(|(i, chunk)| FlashBlock {
                    address: (segment.address + i as u64 * u64::from(page_size)) as u32,
                    data: chunk.to_vec(),
                })
        })
        .collect();
    Ok(FlashPlan {
        page_size,
        erase: FlashErase {
            address: APPLICATION_BASE,
            pages: pages as u16,
        },
        writes,
        run_address: APPLICATION_BASE,
    })
}

/// A payload the plan never builds: it is a bug, never a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FlashPayloadError {
    #[error("Refusing to address the bootloader area.")]
    BootloaderArea,
    #[error("A bootloader write holds at most 65535 bytes.")]
    TooLong,
}

/// Last line of defence: no payload may address the bootloader.
fn application_address(address: u32) -> Result<[u8; 4], FlashPayloadError> {
    if address < APPLICATION_BASE {
        return Err(FlashPayloadError::BootloaderArea);
    }
    Ok(address.to_be_bytes())
}

pub fn erase_payload(erase: &FlashErase) -> Result<Vec<u8>, FlashPayloadError> {
    let mut payload = application_address(erase.address)?.to_vec();
    payload.extend(erase.pages.to_be_bytes());
    Ok(payload)
}

pub fn write_payload(block: &FlashBlock) -> Result<Vec<u8>, FlashPayloadError> {
    let mut payload = application_address(block.address)?.to_vec();
    let length = u16::try_from(block.data.len()).map_err(|_| FlashPayloadError::TooLong)?;
    payload.extend(length.to_be_bytes());
    payload.extend(&block.data);
    Ok(payload)
}

pub fn run_payload(address: u32) -> Result<[u8; 4], FlashPayloadError> {
    application_address(address)
}

// The updater shuffles the chip ID before its CRC; recovered from the vendor tool.
const FINALIZER_ORDER: [usize; 12] = [0, 6, 2, 8, 7, 1, 3, 9, 5, 11, 10, 4];

/// CRC-32/MPEG-2 over the shuffled 12-byte chip ID, read as three little-endian words.
pub fn finalizer_crc(chip_id: &[u8; 12]) -> u32 {
    let shuffled = FINALIZER_ORDER.map(|i| chip_id[i]);
    let mut crc: u32 = 0xffff_ffff;
    for word in shuffled.as_chunks::<4>().0 {
        let word = u32::from_le_bytes(*word);
        for bit in (0..32).rev() {
            let feedback = ((crc >> 31) ^ (word >> bit)) & 1;
            crc = (crc << 1) ^ if feedback == 1 { 0x04c1_1db7 } else { 0 };
        }
    }
    crc
}

pub fn finalizer_payload(crc: u32) -> [u8; 16] {
    let mut payload = [0; 16];
    payload[..4].copy_from_slice(&crc.to_be_bytes());
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmware::bootloader_frame::tests::{bytes, hex};
    use crate::firmware::intel_hex::FirmwareSegment;

    fn image_at(address: u32, length: usize) -> FirmwareImage {
        FirmwareImage {
            segments: vec![FirmwareSegment {
                address: u64::from(address),
                data: (0..length).map(|i| i as u8).collect(),
            }],
            entry: None,
        }
    }

    #[test]
    fn erases_the_rest_of_a_64_kib_flash_in_1_kib_pages_as_the_vendor_updater_does() {
        let plan = plan_flash(&image_at(APPLICATION_BASE, 47_364), 64).unwrap();
        assert_eq!(plan.page_size, 1024);
        assert_eq!(hex(&erase_payload(&plan.erase).unwrap()), "080038000032");
        assert_eq!(plan.writes.len(), 47);
        assert_eq!(hex(&run_payload(plan.run_address).unwrap()), "08003800");
    }

    #[test]
    fn switches_to_2_kib_pages_from_256_kib_of_flash() {
        let plan = plan_flash(&image_at(APPLICATION_BASE, 10), 256).unwrap();
        assert_eq!(plan.page_size, 2048);
        assert_eq!(
            plan.erase,
            FlashErase {
                address: APPLICATION_BASE,
                pages: 121
            }
        );
    }

    #[test]
    fn splits_each_segment_into_page_sized_writes_from_its_own_start() {
        let plan = plan_flash(&image_at(APPLICATION_BASE, 2500), 64).unwrap();
        let writes: Vec<(u32, usize)> = plan
            .writes
            .iter()
            .map(|block| (block.address, block.data.len()))
            .collect();
        assert_eq!(
            writes,
            [(0x0800_3800, 1024), (0x0800_3c00, 1024), (0x0800_4000, 452)]
        );
        assert_eq!(
            hex(&write_payload(&plan.writes[2]).unwrap()[..8]),
            "0800400001c40001"
        );
    }

    #[test]
    fn refuses_images_that_dont_fit() {
        let empty = FirmwareImage {
            segments: Vec::new(),
            entry: None,
        };
        for (name, image, flash_kib, reason) in [
            (
                "writes into the bootloader",
                image_at(0x0800_0000, 0x4000),
                64,
                FlashPlanReason::BelowApplication,
            ),
            (
                "starts after the application base",
                image_at(0x0800_4000, 16),
                64,
                FlashPlanReason::StartAddress,
            ),
            ("is empty", empty, 64, FlashPlanReason::StartAddress),
            (
                "runs past the end of flash",
                image_at(APPLICATION_BASE, 0xc801),
                64,
                FlashPlanReason::BeyondFlash,
            ),
            (
                "targets a flash too small for an application",
                image_at(APPLICATION_BASE, 1),
                14,
                FlashPlanReason::FlashSize,
            ),
        ] {
            assert_eq!(
                plan_flash(&image, flash_kib).unwrap_err().reason,
                reason,
                "{name}"
            );
        }
    }

    #[test]
    fn never_builds_a_payload_that_addresses_the_bootloader() {
        let below = APPLICATION_BASE - 0x400;
        for address in [below, FLASH_BASE, APPLICATION_BASE - 1, 0] {
            let erase = FlashErase { address, pages: 1 };
            let block = FlashBlock {
                address,
                data: vec![0],
            };
            assert_eq!(
                erase_payload(&erase),
                Err(FlashPayloadError::BootloaderArea)
            );
            assert_eq!(
                write_payload(&block),
                Err(FlashPayloadError::BootloaderArea)
            );
            assert_eq!(run_payload(address), Err(FlashPayloadError::BootloaderArea));
        }
    }

    #[test]
    fn derives_the_finalizer_crc_for_a_chip_id() {
        // The first is the CRC the vendor updater sent for this chip ID in a capture against a
        // fake bootloader.
        for (chip_id, crc) in [
            ("0123456789abcdef01234567", 0xbe48_2081),
            ("101112131415161718191a1b", 0xcd22_1227),
        ] {
            let chip_id: [u8; 12] = bytes(chip_id).try_into().unwrap();
            assert_eq!(finalizer_crc(&chip_id), crc, "{}", hex(&chip_id));
        }
    }

    #[test]
    fn sends_the_finalizer_crc_big_endian_followed_by_twelve_zero_bytes() {
        assert_eq!(
            hex(&finalizer_payload(0xbe48_2081)),
            format!("be482081{}", "00".repeat(12))
        );
    }
}
