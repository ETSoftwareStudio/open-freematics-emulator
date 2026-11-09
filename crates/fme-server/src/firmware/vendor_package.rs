//! Downloads the official Freematics GUI package, checks it against the pinned digest, takes the
//! firmware files out of it and imports them into the library.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use fme_core::contracts::firmware::{
    ImportVendorFilesInput, MAX_VENDOR_BINARY_LENGTH, VendorDownloadError, VendorDownloadReason,
    VendorFile, VendorImportResult,
};
use fme_core::contracts::rpc::DownloadVendorFirmwareError;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::firmware_library::FirmwareLibrary;
use super::nsis::extract_by_digest;

pub type HttpFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, thiserror::Error)]
#[error("The HTTP request failed.")]
pub struct HttpError {
    #[source]
    pub source: Box<dyn std::error::Error + Send + Sync>,
}

pub trait HttpBody: Send {
    /// The next run of the body, or `None` at its end.
    fn chunk(&mut self) -> HttpFuture<'_, Result<Option<Vec<u8>>, HttpError>>;
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Box<dyn HttpBody>,
}

pub trait HttpClient: Send + Sync + 'static {
    /// One GET. A redirect comes back as the response, never followed.
    fn get<'a>(&'a self, url: &'a str) -> HttpFuture<'a, Result<HttpResponse, HttpError>>;
}

/// The real client: TLS through rustls with the platform's roots, and no redirects, so only the
/// pinned URL is ever fetched.
#[derive(Debug, Clone)]
pub struct ReqwestClient {
    client: reqwest::Client,
}

impl ReqwestClient {
    pub fn new() -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(http_error)?;
        Ok(Self { client })
    }
}

fn http_error(error: reqwest::Error) -> HttpError {
    HttpError {
        source: Box::new(error),
    }
}

struct ReqwestBody(reqwest::Response);

impl HttpBody for ReqwestBody {
    fn chunk(&mut self) -> HttpFuture<'_, Result<Option<Vec<u8>>, HttpError>> {
        Box::pin(async move {
            let chunk = self.0.chunk().await.map_err(http_error)?;
            Ok(chunk.map(|bytes| bytes.to_vec()))
        })
    }
}

impl HttpClient for ReqwestClient {
    fn get<'a>(&'a self, url: &'a str) -> HttpFuture<'a, Result<HttpResponse, HttpError>> {
        Box::pin(async move {
            let response = self.client.get(url).send().await.map_err(http_error)?;
            Ok(HttpResponse {
                status: response.status().as_u16(),
                body: Box::new(ReqwestBody(response)),
            })
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorPackageFile {
    /// The path inside the package; only its base name reaches the library.
    pub name: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorPackageDescriptor {
    pub url: String,
    pub size: usize,
    pub sha256: String,
    pub files: Vec<VendorPackageFile>,
}

impl VendorPackageDescriptor {
    pub fn official() -> Self {
        let file = |name: &str, sha256: &str| VendorPackageFile {
            name: name.to_owned(),
            sha256: sha256.to_owned(),
        };
        Self {
            url: "https://freematics.com/dl/FreematicsEmulatorGUI-1.2.exe".to_owned(),
            size: 43_041_876,
            sha256: "b63577912c29276d0abe21f07d7701b4f3bd368a4d0cb52333ebdbddbd76f647".to_owned(),
            files: vec![
                file(
                    "FirmwareUpdater.exe",
                    "9b3de17f9ea6bb36bba69819b1d8ff38dbb86bc28d5ed667174208143a453d89",
                ),
                file(
                    "firmware/Firmware_MK2_20240328.hex",
                    "43532d178e08af803af6250157415cfd4180e54512f3871234dd164196c4aaf8",
                ),
                file(
                    "firmware/Firmware_MK2_20241007.hex",
                    "bda099dc0f8625832f34b390631103ec104c62c96fe85e764e0fe66dfb1c5fb7",
                ),
                file(
                    "firmware/Firmware_MK2_20250311.hex",
                    "e42589eaabbe81fc71ba282c389abd8fc721e11c1646e981aab8e76cc8f663e8",
                ),
            ],
        }
    }
}

pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

fn download_error(reason: VendorDownloadReason) -> DownloadVendorFirmwareError {
    VendorDownloadError { reason }.into()
}

fn digest_of(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut digest = [0; 32];
    for (byte, pair) in digest.iter_mut().zip(text.as_bytes().chunks(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(digest)
}

/// Stops the extraction once its caller is gone, such as after a timeout.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub struct VendorPackage {
    http: Arc<dyn HttpClient>,
    library: FirmwareLibrary,
    descriptor: VendorPackageDescriptor,
    lock: Mutex<()>,
}

impl std::fmt::Debug for VendorPackage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VendorPackage").finish_non_exhaustive()
    }
}

impl VendorPackage {
    pub fn new(http: Arc<dyn HttpClient>, library: FirmwareLibrary) -> Self {
        Self::with_descriptor(http, library, VendorPackageDescriptor::official())
    }

    pub fn with_descriptor(
        http: Arc<dyn HttpClient>,
        library: FirmwareLibrary,
        descriptor: VendorPackageDescriptor,
    ) -> Self {
        Self {
            http,
            library,
            descriptor,
            lock: Mutex::new(()),
        }
    }

    #[tracing::instrument(name = "VendorPackage.download", skip_all)]
    pub async fn download(&self) -> Result<VendorImportResult, DownloadVendorFirmwareError> {
        let Ok(_permit) = self.lock.try_lock() else {
            return Err(download_error(VendorDownloadReason::Busy));
        };
        tokio::time::timeout(DOWNLOAD_TIMEOUT, self.fetch_and_import())
            .await
            .unwrap_or(Err(download_error(VendorDownloadReason::Timeout)))
    }

    #[tracing::instrument(name = "VendorPackage.fetch", skip_all)]
    async fn fetch(&self) -> Result<Vec<u8>, DownloadVendorFirmwareError> {
        let network = |_| download_error(VendorDownloadReason::Network);
        let mut response = self.http.get(&self.descriptor.url).await.map_err(network)?;
        if !(200..300).contains(&response.status) {
            tracing::debug!(status = response.status, "the download was refused");
            return Err(download_error(VendorDownloadReason::Network));
        }
        let mut archive = Vec::with_capacity(self.descriptor.size);
        while let Some(chunk) = response.body.chunk().await.map_err(network)? {
            if archive.len() + chunk.len() > self.descriptor.size {
                return Err(download_error(VendorDownloadReason::Checksum));
            }
            archive.extend(chunk);
        }
        Ok(archive)
    }

    async fn fetch_and_import(&self) -> Result<VendorImportResult, DownloadVendorFirmwareError> {
        let archive = self.fetch().await?;
        let descriptor = self.descriptor.clone();
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let cancelled = Arc::clone(&cancel.0);
        // Hashing and unpacking tens of megabytes is blocking work.
        let unpacked = tokio::task::spawn_blocking(move || {
            let digest: [u8; 32] = Sha256::digest(&archive).into();
            if archive.len() != descriptor.size || Some(digest) != digest_of(&descriptor.sha256) {
                return Err(VendorDownloadReason::Checksum);
            }
            let wanted: Option<Vec<[u8; 32]>> = descriptor
                .files
                .iter()
                .map(|file| digest_of(&file.sha256))
                .collect();
            let wanted = wanted.ok_or(VendorDownloadReason::Extract)?;
            extract_by_digest(&archive, &wanted, MAX_VENDOR_BINARY_LENGTH, &cancelled).map_err(
                |error| {
                    tracing::debug!(reason = error.reason.as_str(), "the package didn't unpack");
                    VendorDownloadReason::Extract
                },
            )
        })
        .await;
        drop(cancel);
        let contents = match unpacked {
            Ok(Ok(contents)) => contents,
            Ok(Err(reason)) => return Err(download_error(reason)),
            Err(_) => return Err(download_error(VendorDownloadReason::Extract)),
        };
        let files = self
            .descriptor
            .files
            .iter()
            .zip(contents)
            .map(|(file, bytes)| VendorFile {
                name: file
                    .name
                    .rsplit('/')
                    .next()
                    .unwrap_or(&file.name)
                    .to_owned(),
                bytes,
            })
            .collect();
        Ok(self
            .library
            .import_vendor_files(ImportVendorFilesInput { files })
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use fme_core::contracts::firmware::{LibraryImage, WireKeyStatus};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Notify;

    use super::*;
    use crate::firmware::bootloader_frame::wire_key_fingerprint;
    use crate::firmware::disk::LocalDisk;
    use crate::firmware::firmware_library::tests::image;
    use crate::firmware::nsis::tests::{installer, sha256};
    use crate::firmware::wire_key_store::WireKeyStore;

    const URL: &str = "https://example.invalid/vendor.exe";

    fn to_hex(digest: [u8; 32]) -> String {
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    // A stand-in key inside a stand-in updater; the store looks for its hash.
    fn key() -> Vec<u8> {
        (0..16u32).map(|i| ((i * 37 + 11) & 0xff) as u8).collect()
    }

    fn updater() -> Vec<u8> {
        [vec![0x4d, 0x5a], vec![1; 300], key(), vec![2; 40]].concat()
    }

    fn sample() -> Vec<u8> {
        image("V1.3")
    }

    fn fixture() -> Vec<u8> {
        installer(&[b"ignored.txt contents", &updater(), &sample()])
    }

    #[derive(Default)]
    struct Fake {
        body: Option<Vec<u8>>,
        status: Option<u16>,
        entered: Option<Arc<Notify>>,
        release: Option<Arc<Notify>>,
    }

    struct FakeBody(Vec<Vec<u8>>);

    impl HttpBody for FakeBody {
        fn chunk(&mut self) -> HttpFuture<'_, Result<Option<Vec<u8>>, HttpError>> {
            let next = (!self.0.is_empty()).then(|| self.0.remove(0));
            Box::pin(async move { Ok(next) })
        }
    }

    struct FakeHttp {
        body: Vec<u8>,
        status: u16,
        entered: Option<Arc<Notify>>,
        release: Option<Arc<Notify>>,
    }

    impl HttpClient for FakeHttp {
        fn get<'a>(&'a self, url: &'a str) -> HttpFuture<'a, Result<HttpResponse, HttpError>> {
            Box::pin(async move {
                assert_eq!(url, URL);
                if let Some(entered) = &self.entered {
                    entered.notify_one();
                }
                if let Some(release) = &self.release {
                    release.notified().await;
                }
                let half = self.body.len() / 2;
                let chunks = vec![self.body[..half].to_vec(), self.body[half..].to_vec()];
                Ok(HttpResponse {
                    status: self.status,
                    body: Box::new(FakeBody(chunks)),
                })
            })
        }
    }

    struct Setup {
        vendor: Arc<VendorPackage>,
        library: FirmwareLibrary,
        keys: WireKeyStore,
        _root: tempfile::TempDir,
    }

    impl Setup {
        fn imported(&self) -> (Vec<LibraryImage>, WireKeyStatus) {
            (
                self.library.images().borrow().clone(),
                self.keys.changes().borrow().clone(),
            )
        }

        fn nothing_imported(&self) -> bool {
            let (images, status) = self.imported();
            images.is_empty() && status == WireKeyStatus::Absent
        }
    }

    async fn setup(archive: Vec<u8>, fake: Fake, files: Vec<VendorPackageFile>) -> Setup {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        let disk = LocalDisk::shared();
        let keys = WireKeyStore::with_key_sha256(
            Arc::clone(&disk),
            &data_dir,
            &wire_key_fingerprint(&key()),
        )
        .await;
        let library = FirmwareLibrary::new(disk, &data_dir, keys.clone()).await;
        let http = FakeHttp {
            body: fake.body.unwrap_or_else(|| archive.clone()),
            status: fake.status.unwrap_or(200),
            entered: fake.entered,
            release: fake.release,
        };
        let descriptor = VendorPackageDescriptor {
            url: URL.to_owned(),
            size: archive.len(),
            sha256: to_hex(sha256(&archive)),
            files,
        };
        let vendor = VendorPackage::with_descriptor(Arc::new(http), library.clone(), descriptor);
        Setup {
            vendor: Arc::new(vendor),
            library,
            keys,
            _root: root,
        }
    }

    fn allowlist() -> Vec<VendorPackageFile> {
        vec![
            VendorPackageFile {
                name: "FirmwareUpdater.exe".to_owned(),
                sha256: to_hex(sha256(&updater())),
            },
            VendorPackageFile {
                name: "firmware/Firmware_MK2_20250311.hex".to_owned(),
                sha256: to_hex(sha256(&sample())),
            },
        ]
    }

    fn reason(error: DownloadVendorFirmwareError) -> VendorDownloadReason {
        match error {
            DownloadVendorFirmwareError::Download(error) => error.reason,
            DownloadVendorFirmwareError::Import(error) => panic!("unexpected {error:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn extracts_only_allowlisted_files_and_imports_their_verified_bytes() {
        let setup = setup(fixture(), Fake::default(), allowlist()).await;
        let result = setup.vendor.download().await.unwrap();
        assert_eq!(
            result,
            VendorImportResult {
                key_found: true,
                images_added: 1
            }
        );
        let (images, status) = setup.imported();
        let names: Vec<_> = images.iter().map(|image| image.name.as_str()).collect();
        assert_eq!(names, ["Firmware_MK2_20250311.hex"]);
        assert_eq!(
            setup
                .library
                .read("Firmware_MK2_20250311.hex")
                .unwrap()
                .into_bytes(),
            sample()
        );
        assert_eq!(
            status,
            WireKeyStatus::Present {
                fingerprint: wire_key_fingerprint(&key())
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_a_truncated_oversized_or_changed_download_without_importing() {
        let archive = fixture();
        for (name, body) in [
            ("truncated", archive[..archive.len() - 1].to_vec()),
            ("oversized", vec![0; archive.len() + 1]),
            ("changed", vec![0; archive.len()]),
        ] {
            let fake = Fake {
                body: Some(body),
                ..Fake::default()
            };
            let setup = setup(archive.clone(), fake, allowlist()).await;
            let error = setup.vendor.download().await.unwrap_err();
            assert_eq!(reason(error), VendorDownloadReason::Checksum, "{name}");
            assert!(setup.nothing_imported(), "{name}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_redirects_and_http_errors_without_importing() {
        for status in [302, 404, 500] {
            let fake = Fake {
                status: Some(status),
                ..Fake::default()
            };
            let setup = setup(fixture(), fake, allowlist()).await;
            let error = setup.vendor.download().await.unwrap_err();
            assert_eq!(reason(error), VendorDownloadReason::Network, "{status}");
            assert!(setup.nothing_imported(), "{status}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_import_extracted_files_with_an_unexpected_digest() {
        let mut files = allowlist();
        files[1].sha256 = "0".repeat(64);
        let setup = setup(fixture(), Fake::default(), files).await;
        let error = setup.vendor.download().await.unwrap_err();
        assert_eq!(reason(error), VendorDownloadReason::Extract);
        assert!(setup.nothing_imported());
    }

    #[tokio::test(start_paused = true)]
    async fn returns_an_extraction_error_for_a_verified_but_unreadable_archive() {
        let setup = setup(sample(), Fake::default(), allowlist()).await;
        let error = setup.vendor.download().await.unwrap_err();
        assert_eq!(reason(error), VendorDownloadReason::Extract);
        assert!(setup.nothing_imported());
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_a_stalled_download_and_allows_another_attempt() {
        let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        let fake = Fake {
            status: Some(500),
            entered: Some(Arc::clone(&entered)),
            release: Some(Arc::clone(&release)),
            ..Fake::default()
        };
        let setup = setup(fixture(), fake, allowlist()).await;
        let first = tokio::spawn({
            let vendor = Arc::clone(&setup.vendor);
            async move { vendor.download().await }
        });
        entered.notified().await;
        tokio::time::advance(DOWNLOAD_TIMEOUT).await;
        assert_eq!(
            reason(first.await.unwrap().unwrap_err()),
            VendorDownloadReason::Timeout
        );
        assert!(setup.nothing_imported());
        release.notify_one();
        let again = setup.vendor.download().await.unwrap_err();
        assert_eq!(reason(again), VendorDownloadReason::Network);
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_concurrent_downloads_and_releases_the_lock_after_failure() {
        let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        let fake = Fake {
            status: Some(500),
            entered: Some(Arc::clone(&entered)),
            release: Some(Arc::clone(&release)),
            ..Fake::default()
        };
        let setup = setup(fixture(), fake, allowlist()).await;
        let first = tokio::spawn({
            let vendor = Arc::clone(&setup.vendor);
            async move { vendor.download().await }
        });
        entered.notified().await;
        let busy = setup.vendor.download().await.unwrap_err();
        assert_eq!(reason(busy), VendorDownloadReason::Busy);
        release.notify_one();
        assert_eq!(
            reason(first.await.unwrap().unwrap_err()),
            VendorDownloadReason::Network
        );
        release.notify_one();
        let again = setup.vendor.download().await.unwrap_err();
        assert_eq!(reason(again), VendorDownloadReason::Network);
    }

    /// A real socket on the loopback interface, so this runs on the wall clock.
    #[tokio::test]
    async fn the_real_client_never_follows_a_redirect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                }
                let response: &[u8] = if request.starts_with(b"GET /moved ") {
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                } else {
                    b"HTTP/1.1 302 Found\r\nLocation: /moved\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                socket.write_all(response).await.unwrap();
            }
        });
        let client = ReqwestClient::new().unwrap();
        let url = format!("http://{address}/vendor.exe");
        let mut response = client.get(&url).await.unwrap();
        assert_eq!(response.status, 302);
        assert_eq!(response.body.chunk().await.unwrap(), None);
        server.abort();
    }
}
