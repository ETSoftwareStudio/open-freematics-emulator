//! Reading an application image the user picked and describing it.

use fme_core::contracts::firmware::{
    FirmwareImageError, FirmwareImageReason, FirmwareImageSummary,
};

use super::flash_plan::APPLICATION_BASE;
use super::intel_hex::{FirmwareImage, parse_intel_hex};

fn image_end(image: &FirmwareImage) -> Option<u64> {
    let last = image.segments.last()?;
    Some(last.address + last.data.len() as u64)
}

/// Parses an Intel HEX application image and checks it starts at the application address.
pub fn read_firmware_image(text: &str) -> Result<FirmwareImage, FirmwareImageError> {
    let image = parse_intel_hex(text).map_err(|error| FirmwareImageError {
        reason: FirmwareImageReason::Unreadable,
        line: Some(error.line),
    })?;
    let starts_at_application = image
        .segments
        .first()
        .is_some_and(|first| first.address == u64::from(APPLICATION_BASE));
    // The summary is 32-bit; nothing past 4 GiB is in the application area either.
    let ends_in_range = image_end(&image).is_some_and(|end| end <= u64::from(u32::MAX));
    if starts_at_application && ends_in_range {
        Ok(image)
    } else {
        Err(FirmwareImageError {
            reason: FirmwareImageReason::OutsideApplication,
            line: None,
        })
    }
}

pub fn image_bytes(image: &FirmwareImage) -> u32 {
    let total: usize = image
        .segments
        .iter()
        .map(|segment| segment.data.len())
        .sum();
    u32::try_from(total).unwrap_or(u32::MAX)
}

/// For an image [`read_firmware_image`] accepted.
pub fn summarize_image(image: &FirmwareImage) -> FirmwareImageSummary {
    FirmwareImageSummary {
        start: APPLICATION_BASE,
        end: image_end(image).map_or(APPLICATION_BASE, |end| {
            u32::try_from(end).unwrap_or(u32::MAX)
        }),
        bytes: image_bytes(image),
    }
}

/// `/EMULATOR V(\d+(?:\.\d+)*)/` over one character per byte.
fn banner_in(data: &[u8]) -> Option<String> {
    const PREFIX: &[u8] = b"EMULATOR V";
    let mut from = 0;
    while let Some(at) = data[from..]
        .windows(PREFIX.len())
        .position(|window| window == PREFIX)
    {
        let start = from + at + PREFIX.len();
        let digits = |at: usize| {
            data[at..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count()
        };
        let mut end = start + digits(start);
        if end > start {
            while data.get(end) == Some(&b'.') && digits(end + 1) > 0 {
                end += 1 + digits(end + 1);
            }
            return Some(String::from_utf8_lossy(&data[start..end]).into_owned());
        }
        from = from + at + 1;
    }
    None
}

/// The version in the "OBD-II EMULATOR V1.3" banner the application prints on reset.
pub fn banner_version(image: &FirmwareImage) -> Option<String> {
    image
        .segments
        .iter()
        .find_map(|segment| banner_in(&segment.data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_first_banner_version_with_its_dotted_parts() {
        for (data, version) in [
            (&b"xx OBD-II EMULATOR V1.3\0"[..], Some("1.3")),
            (b"EMULATOR V2.10.4.", Some("2.10.4")),
            (b"EMULATOR Vx EMULATOR V7", Some("7")),
            (b"EMULATOR V", None),
            (b"emulator v1.3", None),
        ] {
            assert_eq!(banner_in(data).as_deref(), version, "{data:?}");
        }
    }
}
