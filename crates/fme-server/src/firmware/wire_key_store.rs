//! Holds the MK2 wire key, extracted from the user's own copy of the vendor tool and saved locally
//! (never in the repo, never shipped). Updates read it from here so the key is entered once.

use std::path::PathBuf;
use std::sync::Arc;

use fme_core::contracts::firmware::{WireKeyError, WireKeyReason, WireKeyStatus};
use tokio::sync::{Mutex, OwnedMutexGuard, watch};

use super::bootloader_frame::{
    VENDOR_WIRE_KEY_SHA256, WIRE_KEY_LENGTH, WireKey, find_wire_key, wire_key_fingerprint,
};
use super::disk::{SharedDisk, write_file_atomic};

const FILE_NAME: &str = "wire-key.bin";

fn status_of(key: Option<&WireKey>) -> WireKeyStatus {
    match key {
        None => WireKeyStatus::Absent,
        Some(key) => WireKeyStatus::Present {
            fingerprint: wire_key_fingerprint(key),
        },
    }
}

struct Inner {
    disk: SharedDisk,
    data_dir: PathBuf,
    file: PathBuf,
    key_sha256: String,
    key: watch::Sender<Option<WireKey>>,
    status: watch::Sender<WireKeyStatus>,
    // One lock over both mutations, and each commit (disk, then memory) runs to the end once
    // started, so the file and the in-memory key always agree.
    lock: Arc<Mutex<()>>,
}

impl Inner {
    fn set(&self, key: Option<WireKey>) {
        self.status.send_replace(status_of(key.as_ref()));
        self.key.send_replace(key);
    }

    async fn persist(&self, key: Option<WireKey>) -> std::io::Result<()> {
        match key {
            Some(key) => {
                self.disk.create_dir_all(self.data_dir.clone()).await?;
                write_file_atomic(&*self.disk, &self.file, key.to_vec(), true).await
            }
            None => match self.disk.remove(self.file.clone()).await {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                result => result,
            },
        }
    }
}

/// Cheap to clone; clones share one store.
#[derive(Clone)]
pub struct WireKeyStore {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for WireKeyStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WireKeyStore").finish_non_exhaustive()
    }
}

impl WireKeyStore {
    /// Stores the key found by the vendor key's hash.
    pub async fn new(disk: SharedDisk, data_dir: impl Into<PathBuf>) -> Self {
        Self::with_key_sha256(disk, data_dir, VENDOR_WIRE_KEY_SHA256).await
    }

    /// Tests plant a stand-in key and look for its hash instead.
    pub async fn with_key_sha256(
        disk: SharedDisk,
        data_dir: impl Into<PathBuf>,
        key_sha256: &str,
    ) -> Self {
        let data_dir = data_dir.into();
        let file = data_dir.join(FILE_NAME);
        // A missing or unreadable file is simply "no key stored"; a wrong size is ignored too.
        let key: Option<WireKey> = disk
            .read(file.clone())
            .await
            .ok()
            .filter(|bytes| bytes.len() == WIRE_KEY_LENGTH)
            .and_then(|bytes| bytes.try_into().ok());
        let (status, _) = watch::channel(status_of(key.as_ref()));
        let (key, _) = watch::channel(key);
        Self {
            inner: Arc::new(Inner {
                disk,
                data_dir,
                file,
                key_sha256: key_sha256.to_owned(),
                key,
                status,
                lock: Arc::new(Mutex::new(())),
            }),
        }
    }

    /// Current status, then every change. The key itself never leaves the server.
    pub fn changes(&self) -> watch::Receiver<WireKeyStatus> {
        self.inner.status.subscribe()
    }

    /// The stored 16-byte key, or `None` when none is stored.
    pub fn read(&self) -> Option<WireKey> {
        *self.inner.key.borrow()
    }

    /// Writes the change, then publishes it, in a task the caller can't stop halfway.
    async fn commit(&self, permit: OwnedMutexGuard<()>, key: Option<WireKey>) -> bool {
        let inner = Arc::clone(&self.inner);
        let commit = tokio::spawn(async move {
            let _permit = permit;
            let persisted = inner.persist(key).await;
            if persisted.is_ok() {
                inner.set(key);
            }
            persisted.is_ok()
        });
        commit.await.unwrap_or(false)
    }

    /// Scans the vendor binary for the key, saves it, and returns the new status.
    #[tracing::instrument(name = "WireKeyStore.importBinary", skip_all, fields(bytes = binary.len()))]
    pub async fn import_binary(&self, binary: &[u8]) -> Result<WireKeyStatus, WireKeyError> {
        let Some(found) = find_wire_key(binary, &self.inner.key_sha256).await else {
            return Err(WireKeyError {
                reason: WireKeyReason::NotFound,
            });
        };
        let permit = Arc::clone(&self.inner.lock).lock_owned().await;
        if !self.commit(permit, Some(found)).await {
            return Err(WireKeyError {
                reason: WireKeyReason::Persist,
            });
        }
        Ok(status_of(Some(&found)))
    }

    #[tracing::instrument(name = "WireKeyStore.forget", skip_all)]
    pub async fn forget(&self) -> Result<(), WireKeyError> {
        let permit = Arc::clone(&self.inner.lock).lock_owned().await;
        if self.commit(permit, None).await {
            Ok(())
        } else {
            Err(WireKeyError {
                reason: WireKeyReason::Persist,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmware::bootloader_frame::tests::hex;
    use crate::firmware::disk::LocalDisk;
    use crate::firmware::disk::memory::{Gate, MemoryDisk, Method, gated};

    /// A directory that doesn't exist yet, as on a first run.
    fn temp_data_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        (root, data_dir)
    }

    fn key() -> WireKey {
        std::array::from_fn(|i| ((i * 37 + 11) & 0xff) as u8)
    }

    const KEY_FILE: &str = "/data/wire-key.bin";

    fn vendor_binary() -> Vec<u8> {
        [vec![1; 300], key().to_vec(), vec![2, 3]].concat()
    }

    async fn memory_store(disk: &MemoryDisk) -> WireKeyStore {
        WireKeyStore::with_key_sha256(disk.shared(), "/data", &wire_key_fingerprint(&key())).await
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Seen {
        memory: Option<String>,
        status: &'static str,
        disk: Option<String>,
        restarted: Option<String>,
    }

    fn tag(status: &WireKeyStatus) -> &'static str {
        match status {
            WireKeyStatus::Absent => "absent",
            WireKeyStatus::Present { .. } => "present",
        }
    }

    /// What the running store, the disk and a restarted store each say.
    async fn seen(store: &WireKeyStore, disk: &MemoryDisk) -> Seen {
        Seen {
            memory: store.read().map(|key| hex(&key)),
            status: tag(&store.changes().borrow()),
            disk: disk.get(KEY_FILE).map(|bytes| hex(&bytes)),
            restarted: memory_store(disk).await.read().map(|key| hex(&key)),
        }
    }

    fn present() -> Seen {
        Seen {
            memory: Some(hex(&key())),
            status: "present",
            disk: Some(hex(&key())),
            restarted: Some(hex(&key())),
        }
    }

    fn absent() -> Seen {
        Seen {
            memory: None,
            status: "absent",
            disk: None,
            restarted: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn has_no_key_on_a_fresh_dir_and_rejects_a_file_without_the_key() {
        let (_root, data_dir) = temp_data_dir();
        let store = WireKeyStore::new(LocalDisk::shared(), &data_dir).await;
        assert_eq!(*store.changes().borrow(), WireKeyStatus::Absent);
        assert_eq!(store.read(), None);
        let noise: Vec<u8> = (0..1000).map(|i| ((i * 7) & 0xff) as u8).collect();
        let error = store.import_binary(&noise).await.unwrap_err();
        assert_eq!(error.reason, WireKeyReason::NotFound);
        assert_eq!(*store.changes().borrow(), WireKeyStatus::Absent);
    }

    #[tokio::test(start_paused = true)]
    async fn loads_a_stored_key_reports_it_and_forgets_it() {
        let (_root, data_dir) = temp_data_dir();
        let file = data_dir.join("wire-key.bin");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(&file, key()).unwrap();

        let store = WireKeyStore::new(LocalDisk::shared(), &data_dir).await;
        assert_eq!(
            *store.changes().borrow(),
            WireKeyStatus::Present {
                fingerprint: wire_key_fingerprint(&key())
            }
        );
        assert_eq!(store.read().map(|key| hex(&key)), Some(hex(&key())));

        store.forget().await.unwrap();
        assert_eq!(*store.changes().borrow(), WireKeyStatus::Absent);
        assert_eq!(store.read(), None);
        assert!(!file.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn saves_an_imported_key_for_its_owner_only() {
        let (_root, data_dir) = temp_data_dir();
        let store = WireKeyStore::with_key_sha256(
            LocalDisk::shared(),
            &data_dir,
            &wire_key_fingerprint(&key()),
        )
        .await;
        let status = store.import_binary(&vendor_binary()).await.unwrap();
        assert_eq!(status, *store.changes().borrow());
        let file = data_dir.join("wire-key.bin");
        assert_eq!(std::fs::read(&file).unwrap(), key());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let names: Vec<_> = std::fs::read_dir(&data_dir).unwrap().collect();
        assert_eq!(names.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_forget_during_an_import_wins_on_disk_and_in_memory() {
        // Stops the import with its key file in place but not yet in memory.
        let gate = Arc::new(Gate::default());
        let disk = gated(Method::Rename, &gate);
        let store = memory_store(&disk).await;
        let importing = tokio::spawn({
            let store = store.clone();
            async move { store.import_binary(&vendor_binary()).await }
        });
        gate.entered().await;
        let forgetting = tokio::spawn({
            let store = store.clone();
            async move { store.forget().await }
        });
        tokio::task::yield_now().await;
        gate.open();
        importing.await.unwrap().unwrap();
        forgetting.await.unwrap().unwrap();
        assert_eq!(seen(&store, &disk).await, absent());
    }

    #[tokio::test(start_paused = true)]
    async fn an_import_during_a_forget_wins_on_disk_and_in_memory() {
        let gate = Arc::new(Gate::default());
        let disk = gated(Method::Remove, &gate);
        disk.set(KEY_FILE, &key());
        let store = memory_store(&disk).await;
        let forgetting = tokio::spawn({
            let store = store.clone();
            async move { store.forget().await }
        });
        gate.entered().await;
        let importing = tokio::spawn({
            let store = store.clone();
            async move { store.import_binary(&vendor_binary()).await }
        });
        tokio::task::yield_now().await;
        gate.open();
        forgetting.await.unwrap().unwrap();
        importing.await.unwrap().unwrap();
        assert_eq!(seen(&store, &disk).await, present());
    }

    #[tokio::test(start_paused = true)]
    async fn finishes_a_started_import_or_forget_when_dropped() {
        for (stop_at, stored, import, expected) in [
            (Method::Rename, false, true, present()),
            (Method::Remove, true, false, absent()),
        ] {
            let gate = Arc::new(Gate::default());
            let disk = gated(stop_at, &gate);
            if stored {
                disk.set(KEY_FILE, &key());
            }
            let store = memory_store(&disk).await;
            let mut changes = store.changes();
            let running = tokio::spawn({
                let store = store.clone();
                async move {
                    if import {
                        store.import_binary(&vendor_binary()).await.map(drop)
                    } else {
                        store.forget().await
                    }
                }
            });
            gate.entered().await;
            running.abort();
            assert!(running.await.unwrap_err().is_cancelled());
            gate.open();
            changes
                .wait_for(|status| tag(status) == expected.status)
                .await
                .unwrap();
            assert_eq!(seen(&store, &disk).await, expected, "{stop_at:?}");
        }
    }
}
