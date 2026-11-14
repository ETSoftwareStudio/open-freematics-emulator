//! Flashes the MK2 through its bootloader: `ATR`, the vendor updater's handshake, then encrypted
//! command frames that erase and rewrite the application area.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use fme_core::contracts::emulator::{ConnectTarget, TrafficChannel, TrafficDirection};
use fme_core::contracts::firmware::{
    FirmwareImageError, FirmwareImageSource, FirmwareImageSummary, FirmwareUpdateError,
    FirmwareUpdateInput, FirmwareUpdateReason, FirmwareUpdateStage, FirmwareUpdateState,
};
use fme_core::contracts::rpc::UpdateFirmwareError;
use futures_util::FutureExt;
use tokio::sync::{Mutex, watch};

use super::bootloader_frame::{
    BootloaderFrameError, PROBE_FRAME, ReplyFrame, VENDOR_WIRE_KEY_SHA256, WireKey, command,
    command_name, decode_reply_frame, encode_command_frame, random_padding, wire_key_fingerprint,
};
use super::firmware_image::{image_bytes, read_firmware_image, summarize_image};
use super::firmware_library::FirmwareLibrary;
use super::flash_plan::{
    FlashPayloadError, erase_payload, finalizer_crc, finalizer_payload, plan_flash, run_payload,
    write_payload,
};
use super::intel_hex::FirmwareImage;
use super::wire_key_store::WireKeyStore;
use crate::device::device_link::{DeviceLink, latin1, latin1_bytes};
use crate::device::serial_ports::SerialPorts;
use crate::device::simulated_device::SimulatedDevice;
use crate::emulator::emulator_session::{EmulatorSession, UpdateHold};
use crate::traffic::traffic_log::TrafficLog;

// The vendor updater's waits, except the erase: it allows 3 s, and waiting longer is harmless.
pub const RESTART_DELAY: Duration = Duration::from_secs(1);
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(1);
pub const HANDSHAKE_ATTEMPTS: usize = 5;
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(2);
const FINISH_TIMEOUT: Duration = Duration::from_secs(1);
pub const ERASE_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
pub const RUN_SETTLE: Duration = Duration::from_millis(200);
// Acks don't name their command, so a repeat could pass for the next command's ack. Whatever lands
// this soon after a reply is dropped before the next command: about 38 byte-times at 38400 baud,
// several ack frames (1.3 ms each) plus USB-serial and timer latency.
pub const REPLY_SETTLE: Duration = Duration::from_millis(10);

const STOPPED_UNEXPECTEDLY: &str = "The update stopped unexpectedly.";

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error(transparent)]
    Failed(#[from] UpdateFirmwareError),
    /// A broken invariant, such as a payload that would address the bootloader: a bug, never a
    /// request. The transport reports it as a defect.
    #[error("The update stopped unexpectedly.")]
    Defect,
}

impl From<FirmwareImageError> for UpdateError {
    fn from(error: FirmwareImageError) -> Self {
        Self::Failed(error.into())
    }
}

impl From<FirmwareUpdateError> for UpdateError {
    fn from(error: FirmwareUpdateError) -> Self {
        Self::Failed(error.into())
    }
}

fn update_error(reason: FirmwareUpdateReason) -> FirmwareUpdateError {
    FirmwareUpdateError { reason }
}

#[derive(Debug)]
enum FlashError {
    Update(FirmwareUpdateError),
    Defect,
}

impl From<FirmwareUpdateError> for FlashError {
    fn from(error: FirmwareUpdateError) -> Self {
        Self::Update(error)
    }
}

impl From<FlashPayloadError> for FlashError {
    fn from(_: FlashPayloadError) -> Self {
        Self::Defect
    }
}

impl From<BootloaderFrameError> for FlashError {
    fn from(_: BootloaderFrameError) -> Self {
        Self::Defect
    }
}

fn link_error() -> FirmwareUpdateError {
    update_error(FirmwareUpdateReason::Link)
}

fn target_tag(target: &ConnectTarget) -> &'static str {
    match target {
        ConnectTarget::Serial { .. } => "serial",
        ConnectTarget::Simulated => "simulated",
    }
}

fn describe_command(code: u8) -> String {
    command_name(code).map_or_else(|| format!("0x{code:x}"), str::to_owned)
}

fn describe_request(code: u8, payload: &[u8]) -> String {
    let address = || {
        payload
            .first_chunk::<4>()
            .map_or(0, |bytes| u32::from_be_bytes(*bytes))
    };
    match code {
        command::WRITE => format!(
            "bootloader write 0x{:x} ({} bytes)",
            address(),
            payload.len().saturating_sub(6)
        ),
        command::ERASE => {
            let pages = payload
                .get(4..6)
                .map_or(0, |bytes| u16::from_be_bytes([bytes[0], bytes[1]]));
            format!("bootloader erase 0x{:x} ({pages} pages)", address())
        }
        _ => format!("bootloader {}", describe_command(code)),
    }
}

fn describe_reply(reply: &ReplyFrame) -> String {
    format!(
        "bootloader reply {} ({} bytes)",
        describe_command(reply.command),
        reply.payload.len()
    )
}

fn expect_reply(
    reply: &ReplyFrame,
    code: u8,
    min_length: usize,
) -> Result<&[u8], FirmwareUpdateError> {
    if reply.command == code && reply.payload.len() >= min_length {
        Ok(&reply.payload)
    } else {
        Err(update_error(FirmwareUpdateReason::UnexpectedReply))
    }
}

/// `/<VER>([^<]*)<\/VER>/`
fn app_version(text: &str) -> Option<String> {
    text.match_indices("<VER>").find_map(|(at, open)| {
        let rest = &text[at + open.len()..];
        let end = rest.find('<').unwrap_or(rest.len());
        rest[end..]
            .starts_with("</VER>")
            .then(|| rest[..end].to_owned())
    })
}

fn parse_wire_key(hex: &str) -> Option<WireKey> {
    if hex.len() != 32 {
        return None;
    }
    let mut key = [0; 16];
    for (byte, pair) in key.iter_mut().zip(hex.as_bytes().chunks(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(key)
}

fn record(traffic: &TrafficLog, direction: TrafficDirection, text: &str) {
    traffic.record(TrafficChannel::Emulator, direction, text);
}

async fn write(
    traffic: &TrafficLog,
    link: &mut dyn DeviceLink,
    data: &[u8],
    note: &str,
) -> Result<(), FirmwareUpdateError> {
    record(traffic, TrafficDirection::Tx, note);
    link.write(data).await.map_err(|_| link_error())
}

async fn within<T>(
    timeout: Duration,
    work: impl Future<Output = Result<T, FirmwareUpdateError>>,
) -> Result<T, FirmwareUpdateError> {
    tokio::time::timeout(timeout, work)
        .await
        .unwrap_or(Err(update_error(FirmwareUpdateReason::NoReply)))
}

/// The bootloader side of the port. Bytes are read only while a reply is awaited, and what the
/// link has buffered meanwhile is read next.
struct Bootloader {
    link: Box<dyn DeviceLink>,
    pending: Vec<u8>,
    closed: bool,
    wire_key: WireKey,
    traffic: TrafficLog,
}

impl Bootloader {
    async fn send(&mut self, data: &[u8], note: &str) -> Result<(), FirmwareUpdateError> {
        write(&self.traffic, &mut *self.link, data, note).await
    }

    async fn pull(&mut self) -> Result<(), FirmwareUpdateError> {
        if self.closed {
            return Err(link_error());
        }
        match self.link.next_chunk().await {
            Some(Ok(text)) => {
                self.pending.extend(latin1_bytes(&text));
                Ok(())
            }
            _ => {
                self.closed = true;
                Err(link_error())
            }
        }
    }

    /// False when the text doesn't arrive in time.
    async fn await_text(
        &mut self,
        text: &str,
        timeout: Duration,
    ) -> Result<bool, FirmwareUpdateError> {
        let wanted = text.as_bytes();
        let arrived = tokio::time::timeout(timeout, async {
            loop {
                if let Some(at) = self
                    .pending
                    .windows(wanted.len())
                    .position(|window| window == wanted)
                {
                    self.pending.drain(..at + wanted.len());
                    return Ok(());
                }
                self.pull().await?;
            }
        })
        .await;
        match arrived {
            Err(_) => Ok(false),
            Ok(Err(error)) => Err(error),
            Ok(Ok(())) => {
                record(&self.traffic, TrafficDirection::Rx, text);
                Ok(true)
            }
        }
    }

    // Garbled frames are dropped, as the vendor's reader does; the caller's timeout still applies.
    async fn next_reply(&mut self) -> Result<ReplyFrame, FirmwareUpdateError> {
        loop {
            match self.pending.iter().position(|&byte| byte == 0xbb) {
                Some(start) => drop(self.pending.drain(..start)),
                None => self.pending.clear(),
            }
            let Some(end) = self.pending.iter().position(|&byte| byte == 0xee) else {
                self.pull().await?;
                continue;
            };
            let frame: Vec<u8> = self.pending.drain(..=end).collect();
            let reply = match decode_reply_frame(&frame) {
                Ok(reply) => reply,
                Err(_) => {
                    let shown: String = frame
                        .iter()
                        .take(32)
                        .map(|byte| format!("{byte:02x}"))
                        .collect();
                    let note = format!("bootloader unreadable frame {shown}");
                    record(&self.traffic, TrafficDirection::Rx, &note);
                    continue;
                }
            };
            record(&self.traffic, TrafficDirection::Rx, &describe_reply(&reply));
            if reply.command == command::ERROR {
                return Err(update_error(FirmwareUpdateReason::Rejected));
            }
            return Ok(reply);
        }
    }

    /// Drops everything received so far, buffered chunks too, so no late frame from an earlier
    /// command is read as the reply to the next one.
    fn discard_received(&mut self) {
        self.pending.clear();
        while !self.closed {
            match self.link.next_chunk().now_or_never() {
                Some(Some(Ok(_))) => {}
                Some(_) => self.closed = true,
                None => break,
            }
        }
    }

    /// Sends a command that gets no reply.
    async fn post(&mut self, code: u8, payload: &[u8]) -> Result<(), FlashError> {
        self.discard_received();
        let frame = encode_command_frame(
            code,
            payload,
            &self.wire_key,
            &random_padding(payload.len()),
        )?;
        Ok(self.send(&frame, &describe_request(code, payload)).await?)
    }

    /// Sends a command and returns the first reply.
    async fn request(
        &mut self,
        code: u8,
        payload: &[u8],
        timeout: Duration,
    ) -> Result<ReplyFrame, FlashError> {
        self.post(code, payload).await?;
        let reply = within(timeout, self.next_reply()).await?;
        tokio::time::sleep(REPLY_SETTLE).await;
        Ok(reply)
    }

    /// Sends a command and waits for its acknowledgement, skipping other frames as the vendor does.
    async fn command(
        &mut self,
        code: u8,
        payload: &[u8],
        timeout: Duration,
    ) -> Result<(), FlashError> {
        self.post(code, payload).await?;
        let acknowledged = async {
            loop {
                let reply = self.next_reply().await?;
                if reply.command == command::ACK && reply.payload.first() == Some(&0) {
                    return Ok(());
                }
            }
        };
        within(timeout, acknowledged).await?;
        tokio::time::sleep(REPLY_SETTLE).await;
        Ok(())
    }

    async fn close(self) {
        self.link.close().await;
    }
}

/// The running job's progress. Whatever ends the job, a panic included, the state never stays at
/// "running".
struct Progress<'a> {
    state: &'a watch::Sender<FirmwareUpdateState>,
    target: ConnectTarget,
    stage: FirmwareUpdateStage,
    written: u32,
    total: u32,
    application_erased: bool,
    finished: bool,
}

impl Progress<'_> {
    fn set(&mut self, stage: FirmwareUpdateStage) {
        self.stage = stage;
        self.state.send_replace(FirmwareUpdateState::Running {
            target: self.target.clone(),
            stage,
            written: self.written,
            total: self.total,
        });
    }

    fn fail(&mut self, reason: String) {
        self.finished = true;
        self.state.send_replace(FirmwareUpdateState::Failed {
            target: self.target.clone(),
            stage: self.stage,
            reason,
            application_erased: self.application_erased,
        });
    }

    fn finish(&mut self, result: &Result<Option<String>, FlashError>) {
        match result {
            Ok(version) => {
                self.finished = true;
                self.state.send_replace(FirmwareUpdateState::Succeeded {
                    target: self.target.clone(),
                    bytes: self.total,
                    version: version.clone(),
                });
            }
            Err(FlashError::Update(error)) => self.fail(error.to_string()),
            Err(FlashError::Defect) => self.fail(STOPPED_UNEXPECTEDLY.to_owned()),
        }
    }
}

impl Drop for Progress<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.fail(STOPPED_UNEXPECTEDLY.to_owned());
        }
    }
}

struct Inner {
    serial_ports: SerialPorts,
    simulated: SimulatedDevice,
    session: EmulatorSession,
    traffic: TrafficLog,
    wire_key_store: WireKeyStore,
    library: FirmwareLibrary,
    state: watch::Sender<FirmwareUpdateState>,
    lock: Arc<Mutex<()>>,
}

impl Inner {
    async fn open_link(
        &self,
        target: &ConnectTarget,
    ) -> Result<Box<dyn DeviceLink>, FirmwareUpdateError> {
        Ok(match target {
            ConnectTarget::Simulated => Box::new(self.simulated.open()),
            ConnectTarget::Serial { path } => Box::new(
                self.serial_ports
                    .open(path)
                    .await
                    .map_err(|_| link_error())?,
            ),
        })
    }

    /// Opens the port, writes once and closes it again.
    async fn write_once(
        &self,
        target: &ConnectTarget,
        data: &[u8],
        note: &str,
    ) -> Result<(), FirmwareUpdateError> {
        let mut link = self.open_link(target).await?;
        let written = write(&self.traffic, &mut *link, data, note).await;
        link.close().await;
        written
    }

    /// The vendor updater probes, closes and reopens the port, then sends `***` for `>>>`.
    #[tracing::instrument(name = "FirmwareUpdater.handshake", skip_all)]
    async fn handshake(
        &self,
        target: &ConnectTarget,
        wire_key: WireKey,
    ) -> Result<Bootloader, FirmwareUpdateError> {
        for attempt in 1..=HANDSHAKE_ATTEMPTS {
            self.write_once(target, &PROBE_FRAME, "bootloader probe")
                .await?;
            let mut bootloader = Bootloader {
                link: self.open_link(target).await?,
                pending: Vec::new(),
                closed: false,
                wire_key,
                traffic: self.traffic.clone(),
            };
            let answered = async {
                bootloader.send(b"***", "***").await?;
                if !bootloader.await_text(">>>", HANDSHAKE_TIMEOUT).await? {
                    return Ok(false);
                }
                bootloader.send(b"Download?", "Download?").await?;
                bootloader.await_text("OK.", HANDSHAKE_TIMEOUT).await
            }
            .await;
            match answered {
                Ok(true) => return Ok(bootloader),
                Ok(false) => tracing::debug!(attempt, "the bootloader didn't answer"),
                Err(error) => {
                    bootloader.close().await;
                    return Err(error);
                }
            }
            bootloader.close().await;
        }
        Err(update_error(FirmwareUpdateReason::NoBootloader))
    }

    async fn steps(
        &self,
        progress: &mut Progress<'_>,
        connection: &mut Option<Bootloader>,
        image: &FirmwareImage,
        wire_key: WireKey,
    ) -> Result<Option<String>, FlashError> {
        let target = progress.target.clone();
        progress.set(FirmwareUpdateStage::Entering);
        // As the vendor GUI does before it hands the port to its updater.
        self.write_once(&target, b"ATR\r", "ATR").await?;
        tokio::time::sleep(RESTART_DELAY).await;
        progress.set(FirmwareUpdateStage::Handshake);
        let bootloader = connection.insert(self.handshake(&target, wire_key).await?);

        progress.set(FirmwareUpdateStage::Reading);
        let reply = bootloader
            .request(command::READ_CHIP_ID, &[], REPLY_TIMEOUT)
            .await?;
        let info = expect_reply(&reply, command::READ_CHIP_ID, 14)?;
        let flash_kib = u32::from(u16::from_be_bytes([info[0], info[1]]));
        let chip_id: [u8; 12] = info[2..14].try_into().map_err(|_| FlashError::Defect)?;
        for code in [
            command::READ_SERIAL,
            command::READ_VERSION,
            command::READ_BOOT_INFO,
        ] {
            let reply = bootloader.request(code, &[], REPLY_TIMEOUT).await?;
            expect_reply(&reply, code, 0)?;
        }
        let plan = plan_flash(image, flash_kib)
            .map_err(|_| update_error(FirmwareUpdateReason::DoesNotFit))?;

        // From here a stop before the last write leaves no application to boot.
        progress.set(FirmwareUpdateStage::Erasing);
        progress.application_erased = true;
        bootloader
            .command(command::ERASE, &erase_payload(&plan.erase)?, ERASE_TIMEOUT)
            .await?;
        progress.set(FirmwareUpdateStage::Writing);
        for block in &plan.writes {
            bootloader
                .command(command::WRITE, &write_payload(block)?, WRITE_TIMEOUT)
                .await?;
            progress.written += u32::try_from(block.data.len()).unwrap_or(u32::MAX);
            progress.set(FirmwareUpdateStage::Writing);
        }
        progress.set(FirmwareUpdateStage::Finishing);
        // The vendor updater needs some reply to these two, whatever it says.
        bootloader
            .request(command::WRITE_DONE, &[], FINISH_TIMEOUT)
            .await?;
        // Its serial-number check: zeros when it has no DevSerialNum.txt, and it ships none.
        bootloader
            .request(command::READ_CHECK, &[0; 8], FINISH_TIMEOUT)
            .await?;
        bootloader
            .command(
                command::WRITE_CRC,
                &finalizer_payload(finalizer_crc(&chip_id)),
                FINISH_TIMEOUT,
            )
            .await?;
        // A real V1.2 bootloader answers this with a bare `BB 00 EE`, so it's informational.
        let app_info = match bootloader
            .request(command::READ_APP_INFO, &[], REPLY_TIMEOUT)
            .await
        {
            Ok(reply) => Some(reply),
            Err(FlashError::Update(_)) => None,
            Err(FlashError::Defect) => return Err(FlashError::Defect),
        };
        // The bootloader jumps to the application without answering.
        bootloader
            .post(command::RUN, &run_payload(plan.run_address)?)
            .await?;
        tokio::time::sleep(RUN_SETTLE).await;
        Ok(app_info
            .filter(|reply| reply.command == command::READ_APP_INFO)
            .and_then(|reply| app_version(&latin1(&reply.payload))))
    }

    #[tracing::instrument(name = "FirmwareUpdater.flash", skip_all)]
    async fn flash(
        &self,
        target: ConnectTarget,
        image: &FirmwareImage,
        wire_key: WireKey,
        hold: UpdateHold,
    ) -> Result<(), FlashError> {
        let mut progress = Progress {
            state: &self.state,
            target,
            stage: FirmwareUpdateStage::Entering,
            written: 0,
            total: image_bytes(image),
            application_erased: false,
            finished: false,
        };
        let mut connection = None;
        let result = self
            .steps(&mut progress, &mut connection, image, wire_key)
            .await;
        if let Some(bootloader) = connection {
            bootloader.close().await;
        }
        // Whoever sees the final state can connect at once.
        drop(hold);
        progress.finish(&result);
        result.map(drop)
    }
}

/// Cheap to clone; clones share one updater.
#[derive(Clone)]
pub struct FirmwareUpdater {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for FirmwareUpdater {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FirmwareUpdater").finish_non_exhaustive()
    }
}

impl FirmwareUpdater {
    pub fn new(
        serial_ports: SerialPorts,
        simulated: SimulatedDevice,
        session: EmulatorSession,
        traffic: TrafficLog,
        wire_key_store: WireKeyStore,
        library: FirmwareLibrary,
    ) -> Self {
        let (state, _) = watch::channel(FirmwareUpdateState::Idle);
        Self {
            inner: Arc::new(Inner {
                serial_ports,
                simulated,
                session,
                traffic,
                wire_key_store,
                library,
                state,
                lock: Arc::new(Mutex::new(())),
            }),
        }
    }

    /// The current state, then every change.
    pub fn state(&self) -> watch::Receiver<FirmwareUpdateState> {
        self.inner.state.subscribe()
    }

    #[tracing::instrument(name = "FirmwareUpdater.inspect", skip_all)]
    pub fn inspect(&self, image: &str) -> Result<FirmwareImageSummary, FirmwareImageError> {
        Ok(summarize_image(&read_firmware_image(image)?))
    }

    /// Takes the device from the session and flashes the image through the bootloader. Once
    /// started, the update runs to the end even if the caller goes away; `state` reports its
    /// progress, and the session refuses connects until it ends.
    #[tracing::instrument(
        name = "FirmwareUpdater.update",
        skip_all,
        fields(target = target_tag(&input.target))
    )]
    pub async fn update(&self, input: FirmwareUpdateInput) -> Result<(), UpdateError> {
        let FirmwareUpdateInput {
            target,
            image,
            wire_key,
        } = input;
        let text = match image {
            FirmwareImageSource::File { text } => text,
            FirmwareImageSource::Library { name } => self.inner.library.read(&name)?,
        };
        let image = read_firmware_image(&text)?;
        // A supplied key is used as-is; otherwise the one stored from the vendor tool.
        let wire_key = match wire_key {
            Some(hex) => {
                Some(parse_wire_key(&hex).ok_or(update_error(FirmwareUpdateReason::WrongKey))?)
            }
            None => self.inner.wire_key_store.read(),
        }
        .ok_or(update_error(FirmwareUpdateReason::NoKey))?;
        // A real unit only ever sees frames under the vendor key.
        if matches!(target, ConnectTarget::Serial { .. })
            && wire_key_fingerprint(&wire_key) != VENDOR_WIRE_KEY_SHA256
        {
            return Err(update_error(FirmwareUpdateReason::WrongKey).into());
        }
        let Ok(permit) = Arc::clone(&self.inner.lock).try_lock_owned() else {
            return Err(update_error(FirmwareUpdateReason::Busy).into());
        };
        let inner = Arc::clone(&self.inner);
        let job = tokio::spawn(async move {
            let _permit = permit;
            let hold = inner.session.hold_for_update().await;
            // The simulated unit has no real key; it takes the one this update uses.
            if target == ConnectTarget::Simulated {
                inner.simulated.lock().bootloader.wire_key = wire_key;
            }
            inner.flash(target, &image, wire_key, hold).await
        });
        match job.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(FlashError::Update(error))) => Err(error.into()),
            Ok(Err(FlashError::Defect)) | Err(_) => Err(UpdateError::Defect),
        }
    }
}

#[cfg(test)]
mod tests {
    use fme_core::contracts::emulator::{Connection, EmulatorConnectReason};
    use fme_core::contracts::firmware::{FirmwareImageReason, VendorImportResult};

    use super::*;
    use crate::device::simulated_device::{
        BootloaderMode, SIMULATED_BOOTLOADER_BYTE, SimulatedVersion,
    };
    use crate::firmware::bootloader_frame::tests::started;
    use crate::firmware::disk::LocalDisk;
    use crate::firmware::firmware_library::tests::file;
    use crate::firmware::flash_plan::{APPLICATION_BASE, FLASH_BASE};
    use crate::firmware::intel_hex::tests::hex_file;

    // The FIPS-197 example key; the simulated bootloader takes whichever key the update uses.
    const TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f";

    fn application() -> Vec<u8> {
        (0..2500u32).map(|i| ((i * 7) & 0xff) as u8).collect()
    }

    fn image_text() -> String {
        hex_file(APPLICATION_BASE, &application())
    }

    fn simulated_update() -> FirmwareUpdateInput {
        FirmwareUpdateInput {
            target: ConnectTarget::Simulated,
            image: FirmwareImageSource::File { text: image_text() },
            wire_key: Some(TEST_KEY.to_owned()),
        }
    }

    struct Fixture {
        updater: FirmwareUpdater,
        session: EmulatorSession,
        simulated: SimulatedDevice,
        library: FirmwareLibrary,
        _root: tempfile::TempDir,
    }

    impl Fixture {
        fn state(&self) -> FirmwareUpdateState {
            self.updater.state().borrow().clone()
        }

        fn received(&self) -> Vec<u8> {
            self.simulated.lock().bootloader.received.clone()
        }

        fn flash(&self, from: u32, length: usize) -> Vec<u8> {
            let start = (from - FLASH_BASE) as usize;
            self.simulated.lock().bootloader.flash[start..start + length].to_vec()
        }
    }

    async fn fixture_on(version: SimulatedVersion, stored_key: Option<WireKey>) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        if let Some(key) = stored_key {
            std::fs::create_dir_all(&data_dir).unwrap();
            std::fs::write(data_dir.join("wire-key.bin"), key).unwrap();
        }
        let simulated = SimulatedDevice::new(version);
        let traffic = TrafficLog::new();
        let session =
            EmulatorSession::new(SerialPorts::default(), simulated.clone(), traffic.clone());
        let disk = LocalDisk::shared();
        let keys = WireKeyStore::new(Arc::clone(&disk), &data_dir).await;
        let library = FirmwareLibrary::new(disk, &data_dir, keys.clone()).await;
        let updater = FirmwareUpdater::new(
            SerialPorts::default(),
            simulated.clone(),
            session.clone(),
            traffic,
            keys,
            library.clone(),
        );
        Fixture {
            updater,
            session,
            simulated,
            library,
            _root: root,
        }
    }

    async fn fixture() -> Fixture {
        fixture_on(SimulatedVersion::V1_3, None).await
    }

    fn update_reason(error: UpdateError) -> FirmwareUpdateReason {
        match error {
            UpdateError::Failed(UpdateFirmwareError::Update(error)) => error.reason,
            error => panic!("unexpected {error:?}"),
        }
    }

    fn image_reason(error: UpdateError) -> FirmwareImageReason {
        match error {
            UpdateError::Failed(UpdateFirmwareError::Image(error)) => error.reason,
            error => panic!("unexpected {error:?}"),
        }
    }

    fn failed(state: &FirmwareUpdateState) -> (FirmwareUpdateStage, &str, bool) {
        match state {
            FirmwareUpdateState::Failed {
                stage,
                reason,
                application_erased,
                ..
            } => (*stage, reason.as_str(), *application_erased),
            state => panic!("not failed: {state:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn flashes_the_simulated_unit_and_leaves_its_bootloader_untouched() {
        let fixture = fixture().await;
        fixture.updater.update(simulated_update()).await.unwrap();

        let application = application();
        assert_eq!(
            fixture.flash(APPLICATION_BASE, application.len()),
            application
        );
        let flash_end = FLASH_BASE + 128 * 1024;
        let after = APPLICATION_BASE + application.len() as u32;
        assert!(
            fixture
                .flash(after, (flash_end - after) as usize)
                .iter()
                .all(|&byte| byte == 0xff)
        );
        assert!(
            fixture
                .flash(FLASH_BASE, (APPLICATION_BASE - FLASH_BASE) as usize)
                .iter()
                .all(|&byte| byte == SIMULATED_BOOTLOADER_BYTE)
        );
        assert_eq!(
            fixture.received(),
            [
                0x00, 0x02, 0x04, 0x05, 0x06, 0x07, 0x07, 0x07, 0x08, 0x03, 0x01, 0x0b, 0x09
            ]
        );
        assert_eq!(
            fixture.simulated.lock().bootloader.mode,
            BootloaderMode::Off
        );
        assert_eq!(
            fixture.state(),
            FirmwareUpdateState::Succeeded {
                target: ConnectTarget::Simulated,
                bytes: 2500,
                version: None,
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn leaves_a_simulated_v1_2_unit_on_v1_3_with_v1_3s_defaults() {
        let fixture = fixture_on(SimulatedVersion::V1_2, None).await;
        fixture.updater.update(simulated_update()).await.unwrap();
        let mut hardware = fixture.simulated.lock();
        assert_eq!(
            (hardware.firmware.version, hardware.firmware.vin.as_str()),
            (SimulatedVersion::V1_3, "LSGGG54EXE105928")
        );
        assert_eq!(hardware.firmware.handle("ATGET CALID"), "JMB*36761500\r\n");
    }

    #[tokio::test(start_paused = true)]
    async fn skips_other_frames_drops_late_ones_and_doesnt_wait_on_run() {
        let fixture = fixture().await;
        {
            let mut hardware = fixture.simulated.lock();
            hardware.bootloader.chatty_command = Some(command::WRITE);
            // A second chip-ID reply must not be read as the answer to the serial-number request.
            hardware.bootloader.late_command = Some(command::READ_CHIP_ID);
            hardware.bootloader.silent_command = Some(command::RUN);
        }
        fixture.updater.update(simulated_update()).await.unwrap();
        assert_eq!(fixture.received().last(), Some(&command::RUN));
    }

    #[tokio::test(start_paused = true)]
    async fn waits_out_a_repeated_ack_before_the_next_command() {
        let fixture = fixture().await;
        fixture.simulated.lock().bootloader.duplicate_acks = true;
        fixture.updater.update(simulated_update()).await.unwrap();
        assert_eq!(fixture.simulated.lock().bootloader.commands_before_ack, 0);
        let application = application();
        assert_eq!(
            fixture.flash(APPLICATION_BASE, application.len()),
            application
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retries_the_handshake_while_the_unit_is_still_restarting() {
        let fixture = fixture().await;
        fixture.simulated.lock().bootloader.ignore_handshakes = 2;
        fixture.updater.update(simulated_update()).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_before_erasing_anything_when_the_bootloader_never_answers() {
        let fixture = fixture().await;
        fixture.simulated.lock().bootloader.ignore_handshakes = HANDSHAKE_ATTEMPTS as u32;
        let error = fixture
            .updater
            .update(simulated_update())
            .await
            .unwrap_err();
        assert_eq!(update_reason(error), FirmwareUpdateReason::NoBootloader);
        assert!(fixture.received().is_empty());
        let state = fixture.state();
        let (stage, _, erased) = failed(&state);
        assert_eq!((stage, erased), (FirmwareUpdateStage::Handshake, false));
    }

    #[tokio::test(start_paused = true)]
    async fn reports_an_erased_application_when_the_bootloader_rejects_a_write() {
        let fixture = fixture().await;
        fixture.simulated.lock().bootloader.reject_command = Some(command::WRITE);
        let error = fixture
            .updater
            .update(simulated_update())
            .await
            .unwrap_err();
        assert_eq!(update_reason(error), FirmwareUpdateReason::Rejected);
        assert_eq!(
            failed(&fixture.state()),
            (
                FirmwareUpdateStage::Writing,
                "The bootloader rejected a command.",
                true
            )
        );
        assert_eq!(fixture.received().last(), Some(&command::WRITE));
    }

    #[tokio::test(start_paused = true)]
    async fn fails_when_the_bootloader_stops_answering_mid_update() {
        let fixture = fixture().await;
        fixture.simulated.lock().bootloader.silent_command = Some(command::ERASE);
        let error = fixture
            .updater
            .update(simulated_update())
            .await
            .unwrap_err();
        assert_eq!(update_reason(error), FirmwareUpdateReason::NoReply);
        assert_eq!(
            failed(&fixture.state()),
            (
                FirmwareUpdateStage::Erasing,
                "The bootloader stopped answering.",
                true
            )
        );
    }

    #[tokio::test(start_paused = true)]
    async fn can_update_again_after_an_attempt_that_stopped_mid_session() {
        let fixture = fixture().await;
        let too_big = FirmwareUpdateInput {
            image: FirmwareImageSource::File {
                text: hex_file(APPLICATION_BASE, &vec![0; 0x1d000]),
            },
            ..simulated_update()
        };
        let error = fixture.updater.update(too_big).await.unwrap_err();
        assert_eq!(update_reason(error), FirmwareUpdateReason::DoesNotFit);
        fixture.updater.update(simulated_update()).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn runs_one_update_at_a_time() {
        let fixture = fixture().await;
        let first = tokio::spawn({
            let updater = fixture.updater.clone();
            async move { updater.update(simulated_update()).await }
        });
        fixture
            .updater
            .state()
            .wait_for(|state| matches!(state, FirmwareUpdateState::Running { .. }))
            .await
            .unwrap();
        let second = fixture
            .updater
            .update(simulated_update())
            .await
            .unwrap_err();
        assert_eq!(update_reason(second), FirmwareUpdateReason::Busy);
        first.await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_session_off_the_device_until_the_update_ends() {
        let fixture = fixture().await;
        fixture
            .session
            .connect(ConnectTarget::Simulated)
            .await
            .unwrap();
        let update = tokio::spawn({
            let updater = fixture.updater.clone();
            async move { updater.update(simulated_update()).await }
        });
        let mut state = fixture.updater.state();
        state
            .wait_for(|state| matches!(state, FirmwareUpdateState::Running { .. }))
            .await
            .unwrap();
        assert_eq!(
            fixture.session.state().borrow().connection,
            Connection::Disconnected
        );
        let refused = fixture
            .session
            .connect(ConnectTarget::Simulated)
            .await
            .unwrap_err();
        assert_eq!(refused.reason, EmulatorConnectReason::UpdateRunning);
        assert_eq!(
            fixture.session.state().borrow().connection,
            Connection::Disconnected
        );

        state
            .wait_for(|state| matches!(state, FirmwareUpdateState::Succeeded { .. }))
            .await
            .unwrap();
        fixture
            .session
            .connect(ConnectTarget::Simulated)
            .await
            .unwrap();
        update.await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_running_when_the_caller_goes_away() {
        let fixture = fixture().await;
        assert!(
            started(fixture.updater.update(simulated_update()))
                .await
                .is_none()
        );
        fixture
            .updater
            .state()
            .wait_for(|state| {
                !matches!(
                    state,
                    FirmwareUpdateState::Idle | FirmwareUpdateState::Running { .. }
                )
            })
            .await
            .unwrap();
        assert!(matches!(
            fixture.state(),
            FirmwareUpdateState::Succeeded { .. }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_a_real_port_without_the_vendor_key_before_opening_it() {
        let fixture = fixture().await;
        let error = fixture
            .updater
            .update(FirmwareUpdateInput {
                target: ConnectTarget::Serial {
                    path: "/dev/null".to_owned(),
                },
                ..simulated_update()
            })
            .await
            .unwrap_err();
        assert_eq!(update_reason(error), FirmwareUpdateReason::WrongKey);
        assert_eq!(fixture.state(), FirmwareUpdateState::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn summarizes_an_image_and_refuses_one_outside_the_application_area() {
        let fixture = fixture().await;
        assert_eq!(
            fixture.updater.inspect(&image_text()).unwrap(),
            FirmwareImageSummary {
                start: APPLICATION_BASE,
                end: APPLICATION_BASE + 2500,
                bytes: 2500,
            }
        );
        let error = fixture
            .updater
            .inspect(&hex_file(FLASH_BASE, &application()))
            .unwrap_err();
        assert_eq!(error.reason, FirmwareImageReason::OutsideApplication);
    }

    #[tokio::test(start_paused = true)]
    async fn never_sends_an_image_that_reaches_into_the_bootloader() {
        let fixture = fixture().await;
        for address in [FLASH_BASE, APPLICATION_BASE - 0x10] {
            let error = fixture
                .updater
                .update(FirmwareUpdateInput {
                    image: FirmwareImageSource::File {
                        text: hex_file(address, &application()),
                    },
                    ..simulated_update()
                })
                .await
                .unwrap_err();
            assert_eq!(image_reason(error), FirmwareImageReason::OutsideApplication);
        }
        assert_eq!(fixture.state(), FirmwareUpdateState::Idle);
        assert_eq!(
            fixture.simulated.lock().bootloader.mode,
            BootloaderMode::Off
        );
        assert!(fixture.received().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn flashes_an_image_from_the_library_with_the_stored_key() {
        let key = parse_wire_key(TEST_KEY).unwrap();
        let fixture = fixture_on(SimulatedVersion::V1_3, Some(key)).await;
        let name = "Firmware_MK2_20250311.hex";
        let added = fixture
            .library
            .import_vendor_files(fme_core::contracts::firmware::ImportVendorFilesInput {
                files: vec![file(name, image_text().into_bytes())],
            })
            .await
            .unwrap();
        assert_eq!(
            added,
            VendorImportResult {
                key_found: false,
                images_added: 1
            }
        );

        fixture
            .updater
            .update(FirmwareUpdateInput {
                target: ConnectTarget::Simulated,
                image: FirmwareImageSource::Library {
                    name: name.to_owned(),
                },
                wire_key: None,
            })
            .await
            .unwrap();
        let application = application();
        assert_eq!(
            fixture.flash(APPLICATION_BASE, application.len()),
            application
        );
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_a_library_image_that_isnt_there() {
        let fixture = fixture().await;
        let error = fixture
            .updater
            .update(FirmwareUpdateInput {
                target: ConnectTarget::Simulated,
                image: FirmwareImageSource::Library {
                    name: "Missing.hex".to_owned(),
                },
                wire_key: Some(TEST_KEY.to_owned()),
            })
            .await
            .unwrap_err();
        assert_eq!(image_reason(error), FirmwareImageReason::NotInLibrary);
    }

    #[tokio::test(start_paused = true)]
    async fn wont_flash_without_a_key() {
        let fixture = fixture().await;
        let error = fixture
            .updater
            .update(FirmwareUpdateInput {
                wire_key: None,
                ..simulated_update()
            })
            .await
            .unwrap_err();
        assert_eq!(update_reason(error), FirmwareUpdateReason::NoKey);
    }

    #[test]
    fn reads_the_version_from_the_application_info() {
        for (text, version) in [
            ("<APP><VER>1.3</VER></APP>", Some("1.3")),
            ("<VER>x<VER>2</VER>", Some("2")),
            ("<VER></VER>", Some("")),
            ("<VER>1.3", None),
        ] {
            assert_eq!(app_version(text).as_deref(), version, "{text}");
        }
    }
}
