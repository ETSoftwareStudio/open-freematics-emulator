//! The local data dir the firmware services keep their files in. A trait so tests can stop or
//! fail a call at an exact point.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

pub type DiskFuture<T> = Pin<Box<dyn Future<Output = io::Result<T>> + Send + 'static>>;

pub trait Disk: Send + Sync + 'static {
    fn read(&self, path: PathBuf) -> DiskFuture<Vec<u8>>;
    /// The names of the files directly in `directory`.
    fn read_dir(&self, directory: PathBuf) -> DiskFuture<Vec<String>>;
    fn create_dir_all(&self, directory: PathBuf) -> DiskFuture<()>;
    /// `private` makes a new file readable by its owner only, where the platform allows.
    fn write(&self, path: PathBuf, data: Vec<u8>, private: bool) -> DiskFuture<()>;
    fn rename(&self, from: PathBuf, to: PathBuf) -> DiskFuture<()>;
    fn remove(&self, path: PathBuf) -> DiskFuture<()>;
}

pub type SharedDisk = Arc<dyn Disk>;

#[derive(Debug, Clone, Copy, Default)]
pub struct LocalDisk;

impl LocalDisk {
    pub fn shared() -> SharedDisk {
        Arc::new(Self)
    }
}

impl Disk for LocalDisk {
    fn read(&self, path: PathBuf) -> DiskFuture<Vec<u8>> {
        Box::pin(tokio::fs::read(path))
    }

    fn read_dir(&self, directory: PathBuf) -> DiskFuture<Vec<String>> {
        Box::pin(async move {
            let mut entries = tokio::fs::read_dir(directory).await?;
            let mut names = Vec::new();
            while let Some(entry) = entries.next_entry().await? {
                if let Ok(name) = entry.file_name().into_string() {
                    names.push(name);
                }
            }
            Ok(names)
        })
    }

    fn create_dir_all(&self, directory: PathBuf) -> DiskFuture<()> {
        Box::pin(tokio::fs::create_dir_all(directory))
    }

    fn write(&self, path: PathBuf, data: Vec<u8>, private: bool) -> DiskFuture<()> {
        Box::pin(async move {
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            if private {
                options.mode(0o600);
            }
            #[cfg(not(unix))]
            let _ = private;
            let mut file = options.open(path).await?;
            tokio::io::AsyncWriteExt::write_all(&mut file, &data).await?;
            tokio::io::AsyncWriteExt::flush(&mut file).await
        })
    }

    fn rename(&self, from: PathBuf, to: PathBuf) -> DiskFuture<()> {
        Box::pin(tokio::fs::rename(from, to))
    }

    fn remove(&self, path: PathBuf) -> DiskFuture<()> {
        Box::pin(tokio::fs::remove_file(path))
    }
}

/// Writes a sibling temp file, then renames it over `file`, so readers (and a restart) see the old
/// bytes or the new ones, never a truncated mix. The temp file is removed if either step fails.
#[tracing::instrument(name = "writeFileAtomic", skip_all, fields(bytes = data.len()))]
pub async fn write_file_atomic(
    disk: &dyn Disk,
    file: &Path,
    data: Vec<u8>,
    private: bool,
) -> io::Result<()> {
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary = PathBuf::from(name);
    let written = match disk.write(temporary.clone(), data, private).await {
        Ok(()) => disk.rename(temporary.clone(), file.to_owned()).await,
        Err(error) => Err(error),
    };
    if written.is_err() && disk.remove(temporary).await.is_err() {
        tracing::debug!("the temp file was already gone");
    }
    written
}

#[cfg(test)]
pub(crate) mod memory {
    //! An in-memory disk whose calls complete without real I/O, so concurrent tasks interleave
    //! deterministically. `hook` runs before each write and remove and after each rename (the
    //! moment a new file is in place), so a test can stop or fail exactly there.

    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::Notify;

    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Method {
        Write,
        Rename,
        Remove,
    }

    pub(crate) type Hook = Arc<
        dyn Fn(Method, &Path) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> + Send + Sync,
    >;

    #[derive(Clone)]
    pub(crate) struct MemoryDisk {
        pub(crate) files: Arc<Mutex<BTreeMap<PathBuf, Vec<u8>>>>,
        hook: Hook,
    }

    fn not_found() -> io::Error {
        io::Error::from(io::ErrorKind::NotFound)
    }

    impl MemoryDisk {
        pub(crate) fn new() -> Self {
            Self::with_hook(Arc::new(|_, _| Box::pin(async { Ok(()) })))
        }

        pub(crate) fn with_hook(hook: Hook) -> Self {
            Self {
                files: Arc::default(),
                hook,
            }
        }

        pub(crate) fn shared(&self) -> SharedDisk {
            Arc::new(self.clone())
        }

        pub(crate) fn get(&self, path: &str) -> Option<Vec<u8>> {
            self.files.lock().unwrap().get(Path::new(path)).cloned()
        }

        pub(crate) fn set(&self, path: &str, data: &[u8]) {
            self.files
                .lock()
                .unwrap()
                .insert(PathBuf::from(path), data.to_vec());
        }

        /// Every file under `directory`, by name.
        pub(crate) fn listing(&self, directory: &str) -> Vec<(String, Vec<u8>)> {
            self.files
                .lock()
                .unwrap()
                .iter()
                .filter_map(|(path, data)| {
                    let name = path.strip_prefix(directory).ok()?;
                    Some((name.to_string_lossy().into_owned(), data.clone()))
                })
                .collect()
        }
    }

    impl Disk for MemoryDisk {
        fn read(&self, path: PathBuf) -> DiskFuture<Vec<u8>> {
            let data = self.files.lock().unwrap().get(&path).cloned();
            Box::pin(async move { data.ok_or_else(not_found) })
        }

        fn read_dir(&self, directory: PathBuf) -> DiskFuture<Vec<String>> {
            let names = self
                .files
                .lock()
                .unwrap()
                .keys()
                .filter(|path| path.parent() == Some(directory.as_path()))
                .filter_map(|path| Some(path.file_name()?.to_string_lossy().into_owned()))
                .collect();
            Box::pin(async move { Ok(names) })
        }

        fn create_dir_all(&self, _: PathBuf) -> DiskFuture<()> {
            Box::pin(async { Ok(()) })
        }

        fn write(&self, path: PathBuf, data: Vec<u8>, _: bool) -> DiskFuture<()> {
            let (files, hook) = (Arc::clone(&self.files), Arc::clone(&self.hook));
            Box::pin(async move {
                hook(Method::Write, &path).await?;
                files.lock().unwrap().insert(path, data);
                Ok(())
            })
        }

        fn rename(&self, from: PathBuf, to: PathBuf) -> DiskFuture<()> {
            let (files, hook) = (Arc::clone(&self.files), Arc::clone(&self.hook));
            Box::pin(async move {
                {
                    let mut files = files.lock().unwrap();
                    let data = files.remove(&from).ok_or_else(not_found)?;
                    files.insert(to.clone(), data);
                }
                hook(Method::Rename, &to).await
            })
        }

        fn remove(&self, path: PathBuf) -> DiskFuture<()> {
            let (files, hook) = (Arc::clone(&self.files), Arc::clone(&self.hook));
            Box::pin(async move {
                hook(Method::Remove, &path).await?;
                files
                    .lock()
                    .unwrap()
                    .remove(&path)
                    .map(drop)
                    .ok_or_else(not_found)
            })
        }
    }

    /// A one-shot gate: the first caller of `pass` signals `entered` and waits for `open`.
    #[derive(Default)]
    pub(crate) struct Gate {
        used: AtomicBool,
        entered: Notify,
        opened: Notify,
    }

    impl Gate {
        pub(crate) async fn pass(&self) {
            if !self.used.swap(true, Ordering::SeqCst) {
                self.entered.notify_one();
                self.opened.notified().await;
            }
        }

        pub(crate) async fn entered(&self) {
            self.entered.notified().await;
        }

        pub(crate) fn open(&self) {
            self.opened.notify_one();
        }
    }

    /// A disk whose first `method` call stops at `gate` until it opens.
    pub(crate) fn gated(method: Method, gate: &Arc<Gate>) -> MemoryDisk {
        let gate = Arc::clone(gate);
        MemoryDisk::with_hook(Arc::new(move |called, _| {
            let gate = Arc::clone(&gate);
            Box::pin(async move {
                if called == method {
                    gate.pass().await;
                }
                Ok(())
            })
        }))
    }
}
