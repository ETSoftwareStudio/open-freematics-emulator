//! Serial ports: the emulator's USB bridge, and Bluetooth SPP or USB OBD-II adapters.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use fme_core::contracts::emulator::{SerialPortInfo, SerialPortListError, SerialPortTransport};
use tokio::sync::oneshot;

use super::device_link::{
    ChunkSender, Chunks, DeviceLink, DeviceLinkError, LinkFuture, LinkOperation, latin1,
};

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

#[derive(Debug, Clone, Copy, Default)]
pub struct SerialPorts;

impl SerialPorts {
    #[tracing::instrument(name = "SerialPorts.list", skip_all)]
    pub async fn list(&self) -> Result<Vec<SerialPortInfo>, SerialPortListError> {
        let ports = tokio::task::spawn_blocking(serialport::available_ports)
            .await
            .map_err(|_| SerialPortListError {})?
            .map_err(|_| SerialPortListError {})?;
        let ports = ports.into_iter().map(ListedPort::from).collect();
        Ok(to_infos(ports, Platform::current()))
    }

    #[tracing::instrument(name = "SerialPorts.open", skip_all, fields(path = path))]
    pub async fn open(&self, path: &str) -> Result<SerialLink, DeviceLinkError> {
        let owned = path.to_owned();
        tokio::task::spawn_blocking(move || SerialLink::open(&owned))
            .await
            .map_err(|error| DeviceLinkError::new(LinkOperation::Open, io::Error::other(error)))?
    }
}

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// An open serial port. Reads happen on a dedicated thread, writes on the blocking pool; the port
/// and both descriptors are released on `close`, or once the link and the thread drop them.
pub struct SerialLink {
    writer: SharedWriter,
    chunks: Chunks,
    released: oneshot::Receiver<()>,
}

impl std::fmt::Debug for SerialLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialLink").finish_non_exhaustive()
    }
}

impl SerialLink {
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

impl DeviceLink for SerialLink {
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
mod tests {
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
}
