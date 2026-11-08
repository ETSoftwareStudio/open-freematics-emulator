//! Firmware images from the user's own Freematics folder, kept locally (never in the repo or a
//! shipped artifact). Importing the folder also stores the wire key from FirmwareUpdater.exe.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fme_core::contracts::firmware::{
    FirmwareImageError, FirmwareImageReason, ImportVendorFilesInput, LibraryImage, VendorFile,
    VendorImportError, VendorImportReason, VendorImportResult, WireKeyReason,
    is_library_image_name,
};
use indexmap::IndexMap;
use tokio::sync::{Mutex, OwnedMutexGuard, watch};

use super::disk::{SharedDisk, write_file_atomic};
use super::firmware_image::{banner_version, read_firmware_image, summarize_image};
use super::wire_key_store::WireKeyStore;

const DIRECTORY: &str = "firmware";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    info: LibraryImage,
    text: String,
}

fn is_image_file(name: &str) -> bool {
    name.len() >= 4
        && name.is_char_boundary(name.len() - 4)
        && name[name.len() - 4..].eq_ignore_ascii_case(".hex")
}

/// Case-insensitive, as JavaScript's `toLowerCase` keys them.
fn name_key(name: &str) -> String {
    name.to_lowercase()
}

/// `path.basename` on POSIX.
fn basename(name: &str) -> &str {
    let trimmed = name.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// `/(20\d{2})(\d{2})(\d{2})/` as YYYY-MM-DD.
fn released_from(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    bytes.windows(8).find_map(|window| {
        let digits = window.iter().all(u8::is_ascii_digit);
        let date = std::str::from_utf8(window).ok()?;
        (digits && date.starts_with("20"))
            .then(|| format!("{}-{}-{}", &date[..4], &date[4..6], &date[6..]))
    })
}

/// `TextDecoder.decode`: UTF-8 with replacement characters, without a leading BOM.
fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn entry_of(name: &str, text: String) -> Option<Entry> {
    let image = read_firmware_image(&text).ok()?;
    let summary = summarize_image(&image);
    Some(Entry {
        info: LibraryImage {
            name: name.to_owned(),
            version: banner_version(&image),
            released: released_from(name),
            start: summary.start,
            end: summary.end,
            bytes: summary.bytes,
        },
        text,
    })
}

/// Where a character sorts in ICU's root collation, which `localeCompare` uses: punctuation, then
/// digits, then letters regardless of case. Library names are ASCII letters, digits and `_.-`.
fn collation_key(c: char) -> (u8, char) {
    match c {
        '_' => (0, '_'),
        '-' => (1, '-'),
        '.' => (2, '.'),
        '0'..='9' => (4, c),
        c if c.is_ascii_alphabetic() => (5, c.to_ascii_lowercase()),
        c => (3, c),
    }
}

/// `localeCompare` for library names: by collation key, then lower case before upper.
fn locale_compare(a: &str, b: &str) -> Ordering {
    a.chars()
        .map(collation_key)
        .cmp(b.chars().map(collation_key))
        .then_with(|| {
            let case = |c: char| c.is_ascii_uppercase();
            a.chars().map(case).cmp(b.chars().map(case))
        })
}

// Newest release first, so the default choice is the latest image.
fn newest_first(a: &Entry, b: &Entry) -> Ordering {
    let released = |entry: &Entry| entry.info.released.clone().unwrap_or_default();
    locale_compare(&released(b), &released(a))
        .then_with(|| locale_compare(&b.info.name, &a.info.name))
}

fn persist_error() -> VendorImportError {
    VendorImportError {
        reason: VendorImportReason::Persist,
    }
}

struct Inner {
    disk: SharedDisk,
    directory: PathBuf,
    wire_key_store: WireKeyStore,
    entries: watch::Sender<Vec<Entry>>,
    images: watch::Sender<Vec<LibraryImage>>,
    lock: Arc<Mutex<()>>,
}

impl Inner {
    fn update(&self, modify: impl FnOnce(&mut Vec<Entry>)) {
        self.entries.send_modify(|entries| {
            modify(entries);
            entries.sort_by(newest_first);
            self.images
                .send_replace(entries.iter().map(|entry| entry.info.clone()).collect());
        });
    }
}

/// Cheap to clone; clones share one library.
#[derive(Clone)]
pub struct FirmwareLibrary {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for FirmwareLibrary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FirmwareLibrary").finish_non_exhaustive()
    }
}

// Missing or unreadable files just leave the library shorter.
async fn load(disk: &SharedDisk, directory: &Path) -> Vec<Entry> {
    let names = disk
        .read_dir(directory.to_owned())
        .await
        .unwrap_or_default();
    let mut entries = Vec::new();
    for name in names.into_iter().filter(|name| is_library_image_name(name)) {
        let Ok(bytes) = disk.read(directory.join(&name)).await else {
            continue;
        };
        entries.extend(entry_of(&name, decode_text(&bytes)));
    }
    entries.sort_by(newest_first);
    entries
}

impl FirmwareLibrary {
    pub async fn new(
        disk: SharedDisk,
        data_dir: impl Into<PathBuf>,
        wire_key_store: WireKeyStore,
    ) -> Self {
        let directory = data_dir.into().join(DIRECTORY);
        let entries = load(&disk, &directory).await;
        let (images, _) = watch::channel(entries.iter().map(|entry| entry.info.clone()).collect());
        let (entries, _) = watch::channel(entries);
        Self {
            inner: Arc::new(Inner {
                disk,
                directory,
                wire_key_store,
                entries,
                images,
                lock: Arc::new(Mutex::new(())),
            }),
        }
    }

    /// Newest first; the current list, then every change.
    pub fn images(&self) -> watch::Receiver<Vec<LibraryImage>> {
        self.inner.images.subscribe()
    }

    /// The Intel HEX text of a stored image.
    #[tracing::instrument(name = "FirmwareLibrary.read", skip_all)]
    pub fn read(&self, name: &str) -> Result<String, FirmwareImageError> {
        self.inner
            .entries
            .borrow()
            .iter()
            .find(|entry| entry.info.name == name)
            .map(|entry| entry.text.clone())
            .ok_or(FirmwareImageError {
                reason: FirmwareImageReason::NotInLibrary,
                line: None,
            })
    }

    #[tracing::instrument(name = "FirmwareLibrary.findKey", skip_all, fields(files = files.len()))]
    async fn find_key(&self, files: &[VendorFile]) -> Result<bool, VendorImportError> {
        for file in files.iter().filter(|file| !is_image_file(&file.name)) {
            match self.inner.wire_key_store.import_binary(&file.bytes).await {
                Ok(_) => return Ok(true),
                Err(error) if error.reason == WireKeyReason::NotFound => {}
                Err(_) => return Err(persist_error()),
            }
        }
        Ok(false)
    }

    /// Writes one image, then lists it, in a task the caller can't stop halfway. The permit comes
    /// back once the image is committed.
    async fn commit(
        &self,
        permit: OwnedMutexGuard<()>,
        entry: Entry,
    ) -> Result<OwnedMutexGuard<()>, VendorImportError> {
        let inner = Arc::clone(&self.inner);
        let commit = tokio::spawn(async move {
            let file = inner.directory.join(&entry.info.name);
            let written =
                write_file_atomic(&*inner.disk, &file, entry.text.clone().into_bytes(), false)
                    .await;
            if written.is_ok() {
                inner.update(|entries| {
                    entries.retain(|item| item.info.name != entry.info.name);
                    entries.push(entry);
                });
            }
            written.map(|()| permit)
        });
        match commit.await {
            Ok(Ok(permit)) => Ok(permit),
            _ => Err(persist_error()),
        }
    }

    #[tracing::instrument(name = "FirmwareLibrary.importVendorFiles", skip_all, fields(files = input.files.len()))]
    pub async fn import_vendor_files(
        &self,
        input: ImportVendorFilesInput,
    ) -> Result<VendorImportResult, VendorImportError> {
        let mut permit = Arc::clone(&self.inner.lock).lock_owned().await;
        let key_found = self.find_key(&input.files).await?;
        if !key_found && self.inner.wire_key_store.read().is_none() {
            return Err(VendorImportError {
                reason: VendorImportReason::NoKey,
            });
        }
        // Keyed case-insensitively: on macOS and Windows "A.hex" and "a.hex" are one file on disk.
        let existing: IndexMap<String, String> = self
            .inner
            .entries
            .borrow()
            .iter()
            .map(|entry| (name_key(&entry.info.name), entry.info.name.clone()))
            .collect();
        let mut added: IndexMap<String, Entry> = IndexMap::new();
        for file in &input.files {
            let name = basename(&file.name);
            if !is_image_file(name) || !is_library_image_name(name) {
                continue;
            }
            let stored_name = existing.get(&name_key(name)).map_or(name, String::as_str);
            let Some(entry) = entry_of(stored_name, decode_text(&file.bytes)) else {
                continue;
            };
            if let Some(twin) = added.get(&name_key(name))
                && twin.text != entry.text
            {
                return Err(VendorImportError {
                    reason: VendorImportReason::DuplicateName,
                });
            }
            added.insert(name_key(name), entry);
        }
        self.inner
            .disk
            .create_dir_all(self.inner.directory.clone())
            .await
            .map_err(|_| persist_error())?;
        let images_added = u32::try_from(added.len()).unwrap_or(u32::MAX);
        // Each image commits on its own, disk then list: a failure keeps the images already
        // committed and leaves the failed image's previous file whole.
        for entry in added.into_values() {
            permit = self.commit(permit, entry).await?;
        }
        Ok(VendorImportResult {
            key_found,
            images_added,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::firmware::bootloader_frame::VENDOR_WIRE_KEY_SHA256;
    use crate::firmware::disk::LocalDisk;
    use crate::firmware::disk::memory::{Gate, Hook, MemoryDisk, Method, gated};
    use crate::firmware::flash_plan::APPLICATION_BASE;
    use crate::firmware::intel_hex::tests::hex_file;

    pub(crate) fn image(banner: &str) -> Vec<u8> {
        let data = [
            format!("xx OBD-II EMULATOR {banner}\0").into_bytes(),
            vec![1, 2],
        ]
        .concat();
        hex_file(APPLICATION_BASE, &data).into_bytes()
    }

    pub(crate) fn file(name: &str, bytes: Vec<u8>) -> VendorFile {
        VendorFile {
            name: name.to_owned(),
            bytes,
        }
    }

    fn import(files: Vec<VendorFile>) -> ImportVendorFilesInput {
        ImportVendorFilesInput { files }
    }

    fn temp_data_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        (root, data_dir)
    }

    async fn local_library(data_dir: &Path) -> FirmwareLibrary {
        let disk = LocalDisk::shared();
        let keys = WireKeyStore::new(Arc::clone(&disk), data_dir).await;
        FirmwareLibrary::new(disk, data_dir, keys).await
    }

    fn plant_key(data_dir: &Path) {
        std::fs::create_dir_all(data_dir).unwrap();
        std::fs::write(data_dir.join("wire-key.bin"), [7; 16]).unwrap();
    }

    const OLD: &str = "Firmware_MK2_20240328.hex";
    const NEW: &str = "Firmware_MK2_20250311.hex";

    // Which test image a stored text is, by its banner version.
    fn version_of(text: &[u8]) -> &'static str {
        ["1.1", "1.2", "1.3"]
            .into_iter()
            .find(|v| image(&format!("V{v}")) == text)
            .unwrap_or("?")
    }

    type Listing = Vec<(String, &'static str)>;

    #[derive(Debug, PartialEq, Eq)]
    struct Seen {
        running: Listing,
        disk: Listing,
        restarted: Listing,
    }

    fn listing(pairs: &[(&str, &'static str)]) -> Listing {
        pairs
            .iter()
            .map(|(name, version)| ((*name).to_owned(), *version))
            .collect()
    }

    fn same(pairs: &[(&str, &'static str)]) -> Seen {
        Seen {
            running: listing(pairs),
            disk: listing(pairs),
            restarted: listing(pairs),
        }
    }

    /// A library over an in-memory disk holding a stored key and `images`.
    struct MemoryLibrary {
        disk: MemoryDisk,
    }

    impl MemoryLibrary {
        fn new(images: &[(&str, Vec<u8>)], disk: MemoryDisk) -> Self {
            disk.set("/data/wire-key.bin", &[7; 16]);
            for (name, bytes) in images {
                disk.set(&format!("/data/firmware/{name}"), bytes);
            }
            Self { disk }
        }

        async fn open(&self) -> FirmwareLibrary {
            let keys =
                WireKeyStore::with_key_sha256(self.disk.shared(), "/data", VENDOR_WIRE_KEY_SHA256)
                    .await;
            FirmwareLibrary::new(self.disk.shared(), "/data", keys).await
        }

        fn listed(library: &FirmwareLibrary) -> Listing {
            let images = library.images().borrow().clone();
            images
                .iter()
                .map(|image| {
                    let text = library.read(&image.name).unwrap();
                    (image.name.clone(), version_of(text.as_bytes()))
                })
                .collect()
        }

        // Name and version per image: in the running list, on disk, and after a restart.
        async fn seen(&self, library: &FirmwareLibrary) -> Seen {
            let mut disk: Listing = self
                .disk
                .listing("/data/firmware/")
                .into_iter()
                .map(|(name, bytes)| (name, version_of(&bytes)))
                .collect();
            disk.sort_by(|a, b| b.0.cmp(&a.0));
            Seen {
                running: Self::listed(library),
                disk,
                restarted: Self::listed(&self.open().await),
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn needs_a_wire_key_from_the_folder_or_one_already_stored() {
        let (_root, data_dir) = temp_data_dir();
        let library = local_library(&data_dir).await;
        let error = library
            .import_vendor_files(import(vec![
                file("FirmwareUpdater.exe", vec![0; 4096]),
                file(NEW, image("V1.3")),
            ]))
            .await
            .unwrap_err();
        assert_eq!(error.reason, VendorImportReason::NoKey);
        assert!(library.images().borrow().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_valid_images_newest_first_labelled_and_across_a_restart() {
        let (_root, data_dir) = temp_data_dir();
        plant_key(&data_dir);

        let result = local_library(&data_dir)
            .await
            .import_vendor_files(import(vec![
                file(OLD, image("V1.3")),
                file(NEW, image("V1.3")),
                file("broken.hex", b":nonsense".to_vec()),
                file("notes.txt", b"hi".to_vec()),
            ]))
            .await
            .unwrap();
        assert_eq!(
            result,
            VendorImportResult {
                key_found: false,
                images_added: 2
            }
        );

        let library = local_library(&data_dir).await;
        let images = library.images().borrow().clone();
        let labels: Vec<_> = images
            .iter()
            .map(|item| {
                (
                    item.name.as_str(),
                    item.version.as_deref(),
                    item.released.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            labels,
            [
                (NEW, Some("1.3"), Some("2025-03-11")),
                (OLD, Some("1.3"), Some("2024-03-28")),
            ]
        );
        assert_eq!(images[0].start, APPLICATION_BASE);
        assert_eq!(library.read(NEW).unwrap().into_bytes(), image("V1.3"));
        let missing = library.read("nope.hex").unwrap_err();
        assert_eq!(missing.reason, FirmwareImageReason::NotInLibrary);
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_two_different_images_that_would_share_a_file_name() {
        let memory = MemoryLibrary::new(&[], MemoryDisk::new());
        let library = memory.open().await;
        let error = library
            .import_vendor_files(import(vec![
                file(NEW, image("V1.3")),
                file(&NEW.to_lowercase(), image("V1.2")),
            ]))
            .await
            .unwrap_err();
        assert_eq!(error.reason, VendorImportReason::DuplicateName);
        assert_eq!(memory.seen(&library).await, same(&[]));

        let result = library
            .import_vendor_files(import(vec![
                file(NEW, image("V1.3")),
                file(NEW, image("V1.3")),
            ]))
            .await
            .unwrap();
        assert_eq!(result.images_added, 1);
        assert_eq!(memory.seen(&library).await, same(&[(NEW, "1.3")]));
    }

    #[tokio::test(start_paused = true)]
    async fn replaces_an_image_whose_name_differs_only_in_case_keeping_one_row() {
        let memory = MemoryLibrary::new(&[(NEW, image("V1.2"))], MemoryDisk::new());
        let library = memory.open().await;
        library
            .import_vendor_files(import(vec![file(
                &NEW.to_uppercase().replace(".HEX", ".hex"),
                image("V1.3"),
            )]))
            .await
            .unwrap();
        assert_eq!(memory.seen(&library).await, same(&[(NEW, "1.3")]));
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_committed_images_and_the_failed_images_old_file_when_a_write_fails() {
        let hook: Hook = Arc::new(|method, path: &Path| {
            let fails = method == Method::Write && path.to_string_lossy().contains(NEW);
            Box::pin(async move {
                if fails {
                    Err(std::io::Error::other("test"))
                } else {
                    Ok(())
                }
            })
        });
        let memory = MemoryLibrary::new(
            &[(OLD, image("V1.1")), (NEW, image("V1.2"))],
            MemoryDisk::with_hook(hook),
        );
        let library = memory.open().await;
        let error = library
            .import_vendor_files(import(vec![
                file(OLD, image("V1.3")),
                file(NEW, image("V1.3")),
            ]))
            .await
            .unwrap_err();
        assert_eq!(error.reason, VendorImportReason::Persist);
        assert_eq!(
            memory.seen(&library).await,
            same(&[(NEW, "1.2"), (OLD, "1.3")])
        );
    }

    #[tokio::test(start_paused = true)]
    async fn finishes_publishing_an_image_whose_file_is_in_place_when_dropped() {
        let gate = Arc::new(Gate::default());
        let memory = MemoryLibrary::new(
            &[(OLD, image("V1.1")), (NEW, image("V1.2"))],
            gated(Method::Rename, &gate),
        );
        let library = memory.open().await;
        let mut images = library.images();
        let importing = tokio::spawn({
            let library = library.clone();
            async move {
                library
                    .import_vendor_files(import(vec![
                        file(OLD, image("V1.3")),
                        file(NEW, image("V1.3")),
                    ]))
                    .await
            }
        });
        gate.entered().await;
        importing.abort();
        assert!(importing.await.unwrap_err().is_cancelled());
        gate.open();
        images
            .wait_for(|images| {
                images
                    .iter()
                    .any(|image| image.name == OLD && image.version.as_deref() == Some("1.3"))
            })
            .await
            .unwrap();
        assert_eq!(
            memory.seen(&library).await,
            same(&[(NEW, "1.2"), (OLD, "1.3")])
        );
    }

    #[test]
    fn orders_names_as_locale_compare_does() {
        let mut names = vec!["b.hex", "A.hex", "a.hex", "a_1.hex", "a1.hex", "a-1.hex"];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            names,
            ["a_1.hex", "a-1.hex", "a.hex", "A.hex", "a1.hex", "b.hex"]
        );
        assert_eq!(
            released_from("Firmware_MK2_20250311.hex").as_deref(),
            Some("2025-03-11")
        );
        assert_eq!(released_from("x19990101.hex"), None);
    }
}
