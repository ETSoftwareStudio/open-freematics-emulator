use serde::{Deserialize, Deserializer, Serialize};

use super::emulator::ConnectTarget;
use crate::{js, json};

string_enum! {
    pub enum FirmwareUpdateStage {
        Entering => "entering",
        Handshake => "handshake",
        Reading => "reading",
        Erasing => "erasing",
        Writing => "writing",
        Finishing => "finishing",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "_tag",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FirmwareUpdateState {
    Idle,
    Running {
        target: ConnectTarget,
        stage: FirmwareUpdateStage,
        written: u32,
        total: u32,
    },
    Succeeded {
        target: ConnectTarget,
        bytes: u32,
        /// From the application info the bootloader reports, e.g. "1.3".
        version: Option<String>,
    },
    Failed {
        target: ConnectTarget,
        stage: FirmwareUpdateStage,
        reason: String,
        /// The application area was erased; the bootloader is intact and can take a new image.
        application_erased: bool,
    },
}

pub const MAX_FIRMWARE_IMAGE_LENGTH: usize = 2_000_000;

/// The Intel HEX file's text.
fn firmware_image_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    json::checked(deserializer, "FirmwareImageText", |text: &String| {
        js::length(text) <= MAX_FIRMWARE_IMAGE_LENGTH
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectFirmwareInput {
    #[serde(deserialize_with = "firmware_image_text")]
    pub image: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirmwareImageSummary {
    pub start: u32,
    /// Exclusive.
    pub end: u32,
    pub bytes: u32,
}

/// A firmware file name as stored in the local library, e.g. "Firmware_MK2_20250311.hex".
fn is_library_image_name(name: &str) -> bool {
    let Some(stem) = name
        .len()
        .checked_sub(4)
        .filter(|split| name.is_char_boundary(*split))
        .map(|split| name.split_at(split))
        .filter(|(_, extension)| extension.eq_ignore_ascii_case(".hex"))
        .map(|(stem, _)| stem)
    else {
        return false;
    };
    (1..=100).contains(&stem.len())
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn library_image_name<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    json::checked(deserializer, "LibraryImageName", |name: &String| {
        is_library_image_name(name)
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum FirmwareImageSource {
    File {
        #[serde(deserialize_with = "firmware_image_text")]
        text: String,
    },
    Library {
        #[serde(deserialize_with = "library_image_name")]
        name: String,
    },
}

fn wire_key<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    json::checked(
        deserializer,
        "FirmwareUpdateInput.wireKey",
        |key: &Option<String>| {
            key.as_ref()
                .is_none_or(|key| key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit()))
        },
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareUpdateInput {
    pub target: ConnectTarget,
    pub image: FirmwareImageSource,
    /// The bootloader's 16-byte wire key as hex. When omitted, the stored key is used.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire_key"
    )]
    pub wire_key: Option<String>,
}

string_enum! {
    pub enum FirmwareImageReason {
        Unreadable => "unreadable",
        OutsideApplication => "outsideApplication",
        NotInLibrary => "notInLibrary",
    }
}

fn firmware_image_message(reason: FirmwareImageReason, line: Option<u32>) -> String {
    match (reason, line) {
        (FirmwareImageReason::Unreadable, None) => "This isn't a valid Intel HEX file.".to_owned(),
        (FirmwareImageReason::Unreadable, Some(line)) => {
            format!("This isn't a valid Intel HEX file (line {line}).")
        }
        (FirmwareImageReason::OutsideApplication, _) => {
            "This image doesn't start at the MK2's application address.".to_owned()
        }
        (FirmwareImageReason::NotInLibrary, _) => {
            "That firmware image isn't in the library any more.".to_owned()
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", firmware_image_message(*.reason, *.line))]
    pub struct FirmwareImageError("FirmwareImageError") {
        pub reason: FirmwareImageReason,
        pub line: Option<u32>,
    }
}

string_enum! {
    pub enum FirmwareUpdateReason {
        Busy => "busy",
        WrongKey => "wrongKey",
        NoKey => "noKey",
        NoBootloader => "noBootloader",
        DoesNotFit => "doesNotFit",
        Rejected => "rejected",
        NoReply => "noReply",
        UnexpectedReply => "unexpectedReply",
        Link => "link",
    }
}

impl FirmwareUpdateReason {
    fn message(self) -> &'static str {
        match self {
            Self::Busy => "A firmware update is already running.",
            Self::WrongKey => "That isn't the MK2 bootloader's wire key.",
            Self::NoKey => "No wire key is available. Import one from the vendor tool first.",
            Self::NoBootloader => "The bootloader didn't answer.",
            Self::DoesNotFit => "The image doesn't fit this device's flash.",
            Self::Rejected => "The bootloader rejected a command.",
            Self::NoReply => "The bootloader stopped answering.",
            Self::UnexpectedReply => "The bootloader sent a reply the updater doesn't understand.",
            Self::Link => "The connection to the device failed.",
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message())]
    pub struct FirmwareUpdateError("FirmwareUpdateError") {
        pub reason: FirmwareUpdateReason,
    }
}

/// The Freematics firmware updater binary (FirmwareUpdater.exe) the key is extracted from.
pub const MAX_VENDOR_BINARY_LENGTH: usize = 16_000_000;

fn vendor_binary<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let bytes = json::bytes::deserialize(deserializer)?;
    if bytes.len() > MAX_VENDOR_BINARY_LENGTH {
        Err(serde::de::Error::custom("the vendor binary is too large"))
    } else {
        Ok(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportWireKeyInput {
    #[serde(
        serialize_with = "json::bytes::serialize",
        deserialize_with = "vendor_binary"
    )]
    pub binary: Vec<u8>,
}

/// Whether a wire key is stored, and its fingerprint when it is. The key itself never leaves the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum WireKeyStatus {
    Absent,
    Present { fingerprint: String },
}

string_enum! {
    pub enum WireKeyReason {
        NotFound => "notFound",
        Persist => "persist",
    }
}

impl WireKeyReason {
    fn message(self) -> &'static str {
        match self {
            Self::NotFound => {
                "No MK2 wire key is in this file. Point at FirmwareUpdater.exe from the Freematics GUI."
            }
            Self::Persist => "The wire key couldn't be saved.",
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message())]
    pub struct WireKeyError("WireKeyError") {
        pub reason: WireKeyReason,
    }
}

/// A firmware image kept locally after it was imported from the user's Freematics folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryImage {
    #[serde(deserialize_with = "library_image_name")]
    pub name: String,
    /// From the banner inside the image, e.g. "1.3".
    pub version: Option<String>,
    /// YYYY-MM-DD from the file name, e.g. Firmware_MK2_20250311.hex.
    pub released: Option<String>,
    pub start: u32,
    pub end: u32,
    pub bytes: u32,
}

fn vendor_file_name<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    json::checked(deserializer, "VendorFile.name", |name: &String| {
        js::length(name) <= 255
    })
}

/// A file from the user's Freematics folder: FirmwareUpdater.exe or a firmware .hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VendorFile {
    #[serde(deserialize_with = "vendor_file_name")]
    pub name: String,
    #[serde(
        serialize_with = "json::bytes::serialize",
        deserialize_with = "vendor_binary"
    )]
    pub bytes: Vec<u8>,
}

fn vendor_files<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<VendorFile>, D::Error> {
    json::checked(
        deserializer,
        "ImportVendorFilesInput.files",
        |files: &Vec<VendorFile>| files.len() <= 32,
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportVendorFilesInput {
    #[serde(deserialize_with = "vendor_files")]
    pub files: Vec<VendorFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorImportResult {
    pub key_found: bool,
    pub images_added: u32,
}

string_enum! {
    pub enum VendorDownloadReason {
        Network => "network",
        Checksum => "checksum",
        Extract => "extract",
        Busy => "busy",
        Timeout => "timeout",
    }
}

impl VendorDownloadReason {
    fn message(self) -> &'static str {
        match self {
            Self::Network => {
                "The Freematics download failed. Try again or import a Freematics folder."
            }
            Self::Checksum => {
                "The download doesn't match the verified Freematics package. Nothing was imported. Use folder import instead."
            }
            Self::Extract => {
                "The Freematics package couldn't be unpacked. Try importing an unpacked folder instead."
            }
            Self::Busy => "A Freematics download is already running.",
            Self::Timeout => {
                "The Freematics download or extraction timed out. Try again or import a folder."
            }
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message())]
    pub struct VendorDownloadError("VendorDownloadError") {
        pub reason: VendorDownloadReason,
    }
}

string_enum! {
    pub enum VendorImportReason {
        NoKey => "noKey",
        DuplicateName => "duplicateName",
        Persist => "persist",
    }
}

impl VendorImportReason {
    fn message(self) -> &'static str {
        match self {
            Self::NoKey => {
                "No MK2 wire key was found. Choose the Freematics folder that has FirmwareUpdater.exe."
            }
            Self::DuplicateName => {
                "Two different firmware images share a name. Choose a folder with one copy of each."
            }
            Self::Persist => "The Freematics files couldn't be saved.",
        }
    }
}

tagged_struct! {
    #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
    #[error("{}", .reason.message())]
    pub struct VendorImportError("VendorImportError") {
        pub reason: VendorImportReason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_library_image_names() {
        assert!(is_library_image_name("Firmware_MK2_20250311.hex"));
        assert!(is_library_image_name("a.b-c.HEX"));
        assert!(!is_library_image_name(".hex"));
        assert!(!is_library_image_name("../escape.hex"));
        assert!(!is_library_image_name("firmware.bin"));
        assert!(!is_library_image_name(&format!("{}.hex", "x".repeat(101))));
    }

    #[test]
    fn writes_the_error_messages() {
        let error = FirmwareImageError {
            reason: FirmwareImageReason::Unreadable,
            line: Some(12),
        };
        assert_eq!(
            error.to_string(),
            "This isn't a valid Intel HEX file (line 12)."
        );
    }
}
