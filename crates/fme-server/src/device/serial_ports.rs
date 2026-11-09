//! Serial ports: the emulator's USB bridge, and Bluetooth SPP or USB OBD-II adapters.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use fme_core::contracts::emulator::{SerialPortInfo, SerialPortListError, SerialPortTransport};
use tokio::sync::oneshot;

use super::device_link::{
    ChunkSender, Chunks, DeviceLink, DeviceLinkError, LinkFuture, LinkOperation, latin1,
};
use super::held_ports::HeldPorts;

pub const BAUD_RATE: u32 = 38400;
/// How long a blocking read waits before the reader thread checks whether it should stop.
const READ_TIMEOUT: Duration = Duration::from_millis(100);

// CP2102 on current MK2 units, CH340 on older ones.
const EMULATOR_BRIDGES: [(u16, u16); 2] = [(0x10c4, 0xea60), (0x1a86, 0x7523)];
const IGNORED_PORTS: [&str; 3] = ["bluetooth-incoming-port", "debug-console", "wlan-debug"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
    Windows,
    Other,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

/// A port as the system enumerates it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListedPort {
    pub path: String,
    pub manufacturer: Option<String>,
    /// USB vendor and product IDs.
    pub usb: Option<(u16, u16)>,
    /// The enumerator saw a Bluetooth parent (macOS IOKit) or an rfcomm node (Linux udev).
    pub bluetooth: bool,
}

impl From<serialport::SerialPortInfo> for ListedPort {
    fn from(port: serialport::SerialPortInfo) -> Self {
        let mut listed = Self {
            path: port.port_name,
            ..Self::default()
        };
        match port.port_type {
            serialport::SerialPortType::UsbPort(usb) => {
                listed.manufacturer = usb.manufacturer;
                listed.usb = Some((usb.vid, usb.pid));
            }
            serialport::SerialPortType::BluetoothPort => listed.bluetooth = true,
            serialport::SerialPortType::PciPort | serialport::SerialPortType::Unknown => {}
        }
        listed
    }
}

// Linux binds Bluetooth SPP ports to rfcomm; macOS lists them without USB IDs, and its other
// ID-less ports are in IGNORED_PORTS.
fn transport_of(port: &ListedPort, platform: Platform) -> SerialPortTransport {
    if port.bluetooth || port.path.contains("rfcomm") {
        SerialPortTransport::Bluetooth
    } else if port.usb.is_some() {
        SerialPortTransport::Usb
    } else if platform == Platform::MacOs {
        SerialPortTransport::Bluetooth
    } else {
        SerialPortTransport::Other
    }
}

pub fn to_info(port: &ListedPort, platform: Platform) -> SerialPortInfo {
    let path = match port.path.strip_prefix("/dev/tty.") {
        // `cu` devices don't block on carrier detect; `tty` ones do.
        Some(name) if platform == Platform::MacOs => format!("/dev/cu.{name}"),
        _ => port.path.clone(),
    };
    SerialPortInfo {
        path,
        manufacturer: port.manufacturer.clone(),
        vendor_id: port.usb.map(|(vendor, _)| format!("{vendor:04x}")),
        product_id: port.usb.map(|(_, product)| format!("{product:04x}")),
        transport: transport_of(port, platform),
        likely_emulator: port.usb.is_some_and(|ids| EMULATOR_BRIDGES.contains(&ids)),
    }
}

fn is_ignored(path: &str) -> bool {
    let path = path.to_lowercase();
    IGNORED_PORTS.iter().any(|ignored| path.contains(ignored))
}

/// What the picker shows: emulator bridges first, each device once (macOS lists both its `tty`
/// and `cu` nodes).
pub fn to_infos(ports: Vec<ListedPort>, platform: Platform) -> Vec<SerialPortInfo> {
    let mut infos: Vec<SerialPortInfo> = Vec::new();
    for port in ports.iter().filter(|port| !is_ignored(&port.path)) {
        let info = to_info(port, platform);
        if !infos.iter().any(|seen| seen.path == info.path) {
            infos.push(info);
        }
    }
    infos.sort_by_key(|info| !info.likely_emulator);
    infos
}

/// Opens the system's ports and tells which are Bluetooth. Tests swap it for a fake.
pub trait PortSystem: std::fmt::Debug + Send + Sync + 'static {
    fn open<'a>(
        &'a self,
        path: &'a str,
    ) -> LinkFuture<'a, Result<Box<dyn DeviceLink>, DeviceLinkError>>;

    fn is_bluetooth<'a>(&'a self, path: &'a str) -> LinkFuture<'a, bool>;
}

async fn available_ports() -> Result<Vec<ListedPort>, SerialPortListError> {
    let ports = tokio::task::spawn_blocking(serialport::available_ports)
        .await
        .map_err(|_| SerialPortListError {})?
        .map_err(|_| SerialPortListError {})?;
    Ok(ports.into_iter().map(ListedPort::from).collect())
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemPorts;

impl PortSystem for SystemPorts {
    fn open<'a>(
        &'a self,
        path: &'a str,
    ) -> LinkFuture<'a, Result<Box<dyn DeviceLink>, DeviceLinkError>> {
        let owned = path.to_owned();
        Box::pin(async move {
            let link = tokio::task::spawn_blocking(move || PortLink::open(&owned))
                .await
                .map_err(|error| {
                    DeviceLinkError::new(LinkOperation::Open, io::Error::other(error))
                })??;
            Ok(Box::new(link) as Box<dyn DeviceLink>)
        })
    }

    fn is_bluetooth<'a>(&'a self, path: &'a str) -> LinkFuture<'a, bool> {
        Box::pin(async move {
            available_ports().await.is_ok_and(|ports| {
                to_infos(ports, Platform::current()).iter().any(|info| {
                    info.path == path && info.transport == SerialPortTransport::Bluetooth
                })
            })
        })
    }
}

/// Cheap to clone; clones share the ports held open.
#[derive(Debug, Clone)]
pub struct SerialPorts {
    platform: Platform,
    system: Arc<dyn PortSystem>,
    held: Arc<HeldPorts>,
}

impl Default for SerialPorts {
    fn default() -> Self {
        Self::with_system(Platform::current(), SystemPorts)
    }
}

impl SerialPorts {
    pub fn with_system(platform: Platform, system: impl PortSystem) -> Self {
        Self {
            platform,
            system: Arc::new(system),
            held: Arc::default(),
        }
    }

    #[tracing::instrument(name = "SerialPorts.list", skip_all)]
    pub async fn list(&self) -> Result<Vec<SerialPortInfo>, SerialPortListError> {
        Ok(to_infos(available_ports().await?, Platform::current()))
    }

    /// Opens the port until the link closes. macOS Bluetooth ports stay open for the server's
    /// lifetime instead: closing only detaches, and the next open reuses the descriptor.
    #[tracing::instrument(name = "SerialPorts.open", skip_all, fields(path = path))]
    pub async fn open(&self, path: &str) -> Result<SerialLink, DeviceLinkError> {
        if self.platform == Platform::MacOs && self.system.is_bluetooth(path).await {
            let lease = self.held.lease(path, || self.system.open(path)).await?;
            let silent_means_stale = lease.is_fresh();
            return Ok(SerialLink {
                link: Box::new(lease),
                silent_means_stale,
            });
        }
        Ok(SerialLink {
            link: self.system.open(path).await?,
            silent_means_stale: false,
        })
    }

    /// Closes the ports held open, at shutdown.
    #[tracing::instrument(name = "SerialPorts.closeHeld", skip_all)]
    pub async fn close_held(&self) {
        self.held.close_all().await;
    }
}

/// An open serial port, or a lease on a held one.
pub struct SerialLink {
    link: Box<dyn DeviceLink>,
    silent_means_stale: bool,
}

impl std::fmt::Debug for SerialLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialLink")
            .field("silent_means_stale", &self.silent_means_stale)
            .finish_non_exhaustive()
    }
}

impl SerialLink {
    /// A real open of a held macOS Bluetooth port: silence here means macOS stopped serving it.
    pub const fn silent_means_stale(&self) -> bool {
        self.silent_means_stale
    }
}

impl DeviceLink for SerialLink {
    fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
        self.link.write(data)
    }

    fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
        self.link.next_chunk()
    }

    fn close(self: Box<Self>) -> LinkFuture<'static, ()> {
        self.link.close()
    }
}

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// An open system port. Reads happen on a dedicated thread, writes on the blocking pool; the port
/// and both descriptors are released on `close`, or once the link and the thread drop them.
struct PortLink {
    writer: SharedWriter,
    chunks: Chunks,
    released: oneshot::Receiver<()>,
}

impl std::fmt::Debug for PortLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortLink").finish_non_exhaustive()
    }
}

impl PortLink {
    fn open(path: &str) -> Result<Self, DeviceLinkError> {
        let open_error = |error: io::Error| DeviceLinkError::new(LinkOperation::Open, error);
        let (reader, writer, still_there) = open_port(path).map_err(open_error)?;
        let (sender, chunks) = Chunks::channel();
        let released = spawn_reader(reader, sender, still_there).map_err(open_error)?;
        Ok(Self {
            writer: Arc::new(Mutex::new(writer)),
            chunks,
            released,
        })
    }
}

/// Blocking reads on their own thread, handed to the async side as chunks.
// The CP2102 driver on macOS never wakes kqueue (or kqueue-backed poll), so no readiness polling.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    sender: ChunkSender,
    still_there: Box<dyn Fn() -> bool + Send>,
) -> io::Result<oneshot::Receiver<()>> {
    let (released, on_released) = oneshot::channel();
    std::thread::Builder::new()
        .name("serial-read".to_owned())
        .spawn(move || {
            let mut buffer = [0; 1024];
            while !sender.is_closed() {
                match reader.read(&mut buffer) {
                    Ok(0) if !still_there() => break,
                    Ok(0) => {}
                    Ok(read) => {
                        if sender.send(Ok(latin1(&buffer[..read]))).is_err() {
                            break;
                        }
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::Interrupted
                                | io::ErrorKind::WouldBlock
                                | io::ErrorKind::TimedOut
                        ) => {}
                    Err(error) => {
                        let error = DeviceLinkError::new(LinkOperation::Read, error);
                        if sender.send(Err(error)).is_err() {
                            tracing::debug!("serial link dropped before its read failure");
                        }
                        break;
                    }
                }
            }
            drop(reader);
            if released.send(()).is_err() {
                tracing::debug!("serial link dropped before release");
            }
        })?;
    Ok(on_released)
}

type OpenedPort = (
    Box<dyn Read + Send>,
    Box<dyn Write + Send>,
    Box<dyn Fn() -> bool + Send>,
);

/// POSIX ports are opened as plain files and read with blocking reads that time out in the
/// driver (`VMIN 0`, `VTIME 1`), the same settings `stty` gave the TypeScript server.
#[cfg(unix)]
fn open_port(path: &str) -> io::Result<OpenedPort> {
    use std::os::unix::fs::OpenOptionsExt;

    use nix::fcntl::{FcntlArg, OFlag, fcntl};
    use nix::sys::termios::{
        BaudRate, ControlFlags, InputFlags, SetArg, SpecialCharacterIndices, cfmakeraw, cfsetspeed,
        tcgetattr, tcsetattr,
    };

    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags((OFlag::O_NOCTTY | OFlag::O_NONBLOCK).bits())
        .open(path)?;
    let mut termios = tcgetattr(&file)?;
    cfmakeraw(&mut termios);
    cfsetspeed(&mut termios, BaudRate::B38400)?;
    termios
        .control_flags
        .remove(ControlFlags::CSTOPB | ControlFlags::PARENB | ControlFlags::CRTSCTS);
    termios
        .control_flags
        .insert(ControlFlags::CS8 | ControlFlags::CLOCAL | ControlFlags::CREAD);
    termios
        .input_flags
        .remove(InputFlags::IXON | InputFlags::IXOFF | InputFlags::IXANY);
    termios.control_chars[SpecialCharacterIndices::VMIN as usize] = 0;
    termios.control_chars[SpecialCharacterIndices::VTIME as usize] =
        (READ_TIMEOUT.as_millis() / 100) as u8;
    tcsetattr(&file, SetArg::TCSANOW, &termios)?;
    // Opened non-blocking so carrier detect can't hold `open`; reads block from here on.
    fcntl(&file, FcntlArg::F_SETFL(OFlag::empty()))?;
    let writer = file.try_clone()?;
    let device = std::path::PathBuf::from(path);
    Ok((
        Box::new(file),
        Box::new(writer),
        Box::new(move || device.exists()),
    ))
}

#[cfg(not(unix))]
fn open_port(path: &str) -> io::Result<OpenedPort> {
    let port = serialport::new(path, BAUD_RATE)
        .timeout(READ_TIMEOUT)
        .open()?;
    let writer = port.try_clone()?;
    Ok((Box::new(port), Box::new(writer), Box::new(|| true)))
}

impl DeviceLink for PortLink {
    fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
        let writer = Arc::clone(&self.writer);
        let data = data.to_vec();
        Box::pin(async move {
            let written = tokio::task::spawn_blocking(move || {
                writer
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .write_all(&data)
            })
            .await
            .unwrap_or_else(|error| Err(io::Error::other(error)));
            written.map_err(|error| DeviceLinkError::new(LinkOperation::Write, error))
        })
    }

    fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
        Box::pin(self.chunks.next())
    }

    fn close(self: Box<Self>) -> LinkFuture<'static, ()> {
        let Self {
            writer,
            chunks,
            released,
        } = *self;
        drop(chunks);
        drop(writer);
        Box::pin(async move {
            if released.await.is_err() {
                tracing::debug!("serial reader ended without confirming release");
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::sync::{Arc, Mutex};

    use super::{
        ChunkSender, Chunks, DeviceLink, DeviceLinkError, LinkFuture, LinkOperation, PortSystem,
        io, latin1,
    };

    type Answer = Box<dyn Fn(&str) -> Option<String> + Send>;

    struct State {
        bluetooth: bool,
        answer: Answer,
        fail_writes: bool,
        events: Vec<&'static str>,
        incoming: Option<ChunkSender>,
    }

    /// A port system the test drives. Each open makes a new link that answers what is written
    /// with `answer`; `events` records every open and close of a port.
    #[derive(Clone)]
    pub(crate) struct FakeSystem(Arc<Mutex<State>>);

    impl std::fmt::Debug for FakeSystem {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("FakeSystem").finish_non_exhaustive()
        }
    }

    impl FakeSystem {
        pub(crate) fn new(
            bluetooth: bool,
            answer: impl Fn(&str) -> Option<String> + Send + 'static,
        ) -> Self {
            Self(Arc::new(Mutex::new(State {
                bluetooth,
                answer: Box::new(answer),
                fail_writes: false,
                events: Vec::new(),
                incoming: None,
            })))
        }

        pub(crate) fn silent(bluetooth: bool) -> Self {
            Self::new(bluetooth, |_| None)
        }

        fn state(&self) -> std::sync::MutexGuard<'_, State> {
            self.0.lock().unwrap()
        }

        pub(crate) fn events(&self) -> Vec<&'static str> {
            self.state().events.clone()
        }

        pub(crate) fn fail_writes(&self, fail: bool) {
            self.state().fail_writes = fail;
        }

        /// Feeds the port opened last as if the adapter sent it.
        pub(crate) fn arrive(&self, chunk: Result<String, DeviceLinkError>) {
            let incoming = self.state().incoming.clone().unwrap();
            incoming.send(chunk).unwrap();
        }
    }

    impl PortSystem for FakeSystem {
        fn open<'a>(
            &'a self,
            _path: &'a str,
        ) -> LinkFuture<'a, Result<Box<dyn DeviceLink>, DeviceLinkError>> {
            let (sender, chunks) = Chunks::channel();
            let mut state = self.state();
            state.events.push("open");
            state.incoming = Some(sender.clone());
            drop(state);
            let link = FakeLink {
                system: self.clone(),
                sender,
                chunks,
            };
            Box::pin(std::future::ready(
                Ok(Box::new(link) as Box<dyn DeviceLink>),
            ))
        }

        fn is_bluetooth<'a>(&'a self, _path: &'a str) -> LinkFuture<'a, bool> {
            Box::pin(std::future::ready(self.state().bluetooth))
        }
    }

    struct FakeLink {
        system: FakeSystem,
        sender: ChunkSender,
        chunks: Chunks,
    }

    impl DeviceLink for FakeLink {
        fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
            let state = self.system.state();
            let result = if state.fail_writes {
                Err(DeviceLinkError::new(
                    LinkOperation::Write,
                    io::Error::other("gone"),
                ))
            } else {
                if let Some(reply) = (state.answer)(&latin1(data)) {
                    self.sender.send(Ok(reply)).unwrap();
                }
                Ok(())
            };
            Box::pin(std::future::ready(result))
        }

        fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
            Box::pin(self.chunks.next())
        }
    }

    impl Drop for FakeLink {
        fn drop(&mut self) {
            self.system.state().events.push("close");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeSystem;
    use super::*;

    fn listed(path: &str, usb: Option<(u16, u16)>, bluetooth: bool) -> ListedPort {
        ListedPort {
            path: path.to_owned(),
            manufacturer: None,
            usb,
            bluetooth,
        }
    }

    #[test]
    fn classifies_ports_per_platform() {
        let cp2102 = Some((0x10c4, 0xea60));
        for (platform, port, transport) in [
            (
                Platform::MacOs,
                listed("/dev/tty.usbserial-0001", cp2102, false),
                SerialPortTransport::Usb,
            ),
            (
                Platform::MacOs,
                listed("/dev/tty.OBDII", None, false),
                SerialPortTransport::Bluetooth,
            ),
            (
                Platform::Linux,
                listed("/dev/ttyUSB0", Some((0x1a86, 0x7523)), false),
                SerialPortTransport::Usb,
            ),
            (
                Platform::Linux,
                listed("/dev/rfcomm0", None, false),
                SerialPortTransport::Bluetooth,
            ),
            (
                Platform::Linux,
                listed("/dev/ttyS0", None, false),
                SerialPortTransport::Other,
            ),
            (
                Platform::Windows,
                listed("COM5", None, true),
                SerialPortTransport::Bluetooth,
            ),
            (
                Platform::Windows,
                listed("COM3", cp2102, false),
                SerialPortTransport::Usb,
            ),
        ] {
            assert_eq!(to_info(&port, platform).transport, transport, "{port:?}");
        }
    }

    #[test]
    fn opens_macos_ports_through_their_call_up_device() {
        let info = to_info(
            &listed("/dev/tty.usbserial-0001", Some((0x10c4, 0xea60)), false),
            Platform::MacOs,
        );
        assert_eq!(info.path, "/dev/cu.usbserial-0001");
        assert_eq!(
            (info.vendor_id.as_deref(), info.product_id.as_deref()),
            (Some("10c4"), Some("ea60"))
        );
        assert!(info.likely_emulator);
    }

    #[test]
    fn lists_each_device_once_with_emulators_first() {
        let cp2102 = Some((0x10c4, 0xea60));
        let infos = to_infos(
            vec![
                listed("/dev/cu.Bluetooth-Incoming-Port", None, false),
                listed("/dev/cu.OBDII", None, true),
                listed("/dev/cu.usbserial-0001", cp2102, false),
                listed("/dev/tty.usbserial-0001", cp2102, false),
            ],
            Platform::MacOs,
        );
        let paths: Vec<&str> = infos.iter().map(|info| info.path.as_str()).collect();
        assert_eq!(paths, ["/dev/cu.usbserial-0001", "/dev/cu.OBDII"]);
    }

    const PATH: &str = "/dev/cu.OBDII";

    fn echo(written: &str) -> Option<String> {
        Some(format!("{written}>"))
    }

    async fn exchange(ports: &SerialPorts, command: &str) -> (String, bool) {
        let mut link = ports.open(PATH).await.unwrap();
        link.write(command.as_bytes()).await.unwrap();
        let reply = link.next_chunk().await.unwrap().unwrap();
        (reply, link.silent_means_stale())
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_a_macos_bluetooth_port_open_between_leases_and_reuses_it() {
        let system = FakeSystem::new(true, echo);
        let ports = SerialPorts::with_system(Platform::MacOs, system.clone());
        assert_eq!(exchange(&ports, "ATZ\r").await, ("ATZ\r>".to_owned(), true));
        assert_eq!(
            exchange(&ports, "ATI\r").await,
            ("ATI\r>".to_owned(), false)
        );
        assert_eq!(system.events(), ["open"]);
    }

    #[tokio::test(start_paused = true)]
    async fn discards_what_arrives_while_no_lease_is_open() {
        let system = FakeSystem::new(true, echo);
        let ports = SerialPorts::with_system(Platform::MacOs, system.clone());
        drop(ports.open(PATH).await.unwrap());
        system.arrive(Ok("ELM327 v1.5\r>".to_owned()));
        tokio::task::yield_now().await;
        assert_eq!(exchange(&ports, "ATI\r").await.0, "ATI\r>");
    }

    #[tokio::test(start_paused = true)]
    async fn hands_out_one_lease_at_a_time() {
        let system = FakeSystem::silent(true);
        let ports = SerialPorts::with_system(Platform::MacOs, system.clone());
        let first = ports.open(PATH).await.unwrap();
        let busy = ports.open(PATH).await.unwrap_err();
        assert_eq!(busy.operation, LinkOperation::Open);
        Box::new(first).close().await;
        ports.open(PATH).await.unwrap();
        assert_eq!(system.events(), ["open"]);
    }

    #[tokio::test(start_paused = true)]
    async fn closes_a_port_that_fails_and_really_opens_it_again_next_time() {
        let system = FakeSystem::silent(true);
        let ports = SerialPorts::with_system(Platform::MacOs, system.clone());
        let mut link = ports.open(PATH).await.unwrap();
        system.arrive(Err(DeviceLinkError::new(
            LinkOperation::Read,
            io::Error::other("gone"),
        )));
        let failure = link.next_chunk().await.unwrap().unwrap_err();
        assert_eq!(failure.operation, LinkOperation::Read);
        assert!(link.next_chunk().await.is_none());
        assert_eq!(system.events(), ["open", "close"]);
        drop(link);

        system.fail_writes(true);
        let mut link = ports.open(PATH).await.unwrap();
        assert!(link.silent_means_stale());
        let failure = link.write(b"ATZ\r").await.unwrap_err();
        assert_eq!(failure.operation, LinkOperation::Write);
        assert_eq!(system.events(), ["open", "close", "open", "close"]);
    }

    #[tokio::test(start_paused = true)]
    async fn closes_held_ports_when_the_server_stops() {
        let system = FakeSystem::silent(true);
        let ports = SerialPorts::with_system(Platform::MacOs, system.clone());
        drop(ports.open(PATH).await.unwrap());
        ports.close_held().await;
        assert_eq!(system.events(), ["open", "close"]);
    }

    #[tokio::test(start_paused = true)]
    async fn closes_usb_ports_and_every_port_off_macos_when_the_link_closes() {
        for (platform, bluetooth) in [
            (Platform::MacOs, false),
            (Platform::Linux, true),
            (Platform::Windows, true),
        ] {
            let system = FakeSystem::silent(bluetooth);
            let ports = SerialPorts::with_system(platform, system.clone());
            let link = ports.open(PATH).await.unwrap();
            assert!(!link.silent_means_stale());
            Box::new(link).close().await;
            Box::new(ports.open(PATH).await.unwrap()).close().await;
            assert_eq!(
                system.events(),
                ["open", "close", "open", "close"],
                "{platform:?}"
            );
        }
    }
}
