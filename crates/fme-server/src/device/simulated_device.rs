//! An in-memory MK2: its firmware, its bootloader, and an ELM327 adapter plugged into its OBD
//! port. Dev mode and every server test run against it.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use fme_core::contracts::emulator::ObdProtocol;
use fme_core::js;
use fme_core::shared::at_commands::{format_hex_bytes, parse_raw_bytes};
use fme_core::shared::line_framer::LineFramer;
use fme_core::shared::pids::find_pid;
use tokio::time::Instant;

use super::device_link::{DeviceLink, DeviceLinkError, LinkFuture, latin1};
use crate::firmware::bootloader_frame::{
    WireKey, command, decode_command_frame, encode_reply_frame,
};
use crate::firmware::flash_plan::{APPLICATION_BASE, FLASH_BASE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimulatedVersion {
    V1_2,
    V1_3,
}

struct FirmwareDefaults {
    hardware: &'static str,
    vin: &'static str,
    calibration_id: Option<&'static str>,
    trailer: &'static str,
}

impl SimulatedVersion {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::V1_2 => "1.2",
            Self::V1_3 => "1.3",
        }
    }

    /// What each firmware printed and held by default on a real unit (V1.3 since 2026-10-30).
    const fn defaults(self) -> FirmwareDefaults {
        match self {
            Self::V1_2 => FirmwareDefaults {
                hardware: "00.01.05",
                vin: "1HGCD5654VA061985",
                calibration_id: None,
                trailer: "",
            },
            Self::V1_3 => FirmwareDefaults {
                hardware: "00.01.08",
                // Sixteen characters, as V1.3 ships it.
                vin: "LSGGG54EXE105928",
                calibration_id: Some("JMB*36761500"),
                trailer: "SPN:00\r\n",
            },
        }
    }
}

pub fn simulated_banner(version: SimulatedVersion) -> String {
    format!("OBD-II EMULATOR V{}", version.as_str())
}

const SUPPORT_BITMAP: [u8; 4] = [0xff, 0xff, 0xff, 0xff];
const DEFAULT_MONITOR_STATUS: [u8; 4] = [0x00, 0x07, 0x65, 0x00];
const MAX_DTCS: usize = 6;

fn normalize(line: &str) -> String {
    line.replace(' ', "").to_uppercase()
}

/// `\w` without the `u` flag.
fn is_word(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn is_upper_hex(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

/// `^01[0-9A-F]{2}$`
fn is_mode01_pid(key: &str) -> bool {
    key.len() == 4 && key.starts_with("01") && is_upper_hex(&key[2..])
}

/// `^[PCBU][0-3][0-9A-F]{3}$`
fn is_dtc(code: &str) -> bool {
    let bytes = code.as_bytes();
    bytes.len() == 5
        && b"PCBU".contains(&bytes[0])
        && (b'0'..=b'3').contains(&bytes[1])
        && is_upper_hex(&code[2..])
}

/// `^ATSET(\w+)=(.*)$`, where `.` stops at line terminators.
fn parse_set(command: &str) -> Option<(&str, &str)> {
    let (key, value) = command.strip_prefix("ATSET")?.split_once('=')?;
    let single_line = !value.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (is_word(key) && single_line).then_some((key, value))
}

/// `^ATGET(\w+)$`
fn parse_get(command: &str) -> Option<&str> {
    command.strip_prefix("ATGET").filter(|key| is_word(key))
}

/// In-memory model of the MK2 control interface, matching what real units were measured to do:
/// replies end in `\r` (VIN in `\r\n`), commands are case- and space-insensitive, and resets
/// zero every PID. V1.2 refuses CALID and Mode 07/0A DTCs; V1.3 takes them and prints an extra
/// `SPN:00` line after the info line.
#[derive(Debug, Clone)]
pub struct SimulatedFirmware {
    pub version: SimulatedVersion,
    /// The YYYYMM the unit reports in its info line; a flash doesn't change it.
    pub date_code: String,
    pub echo: bool,
    pub ignition: bool,
    pub vin_enabled: bool,
    pub protocol: ObdProtocol,
    pub vin: String,
    pub calibration_id: Option<String>,
    pub stored_dtcs: Vec<String>,
    pub pending_dtcs: Vec<String>,
    pub permanent_dtcs: Vec<String>,
    pub pids: HashMap<String, Vec<u8>>,
    /// A command to answer with `ERROR`, like firmware that lacks it.
    pub reject_command: Option<String>,
}

impl Default for SimulatedFirmware {
    fn default() -> Self {
        Self::new(SimulatedVersion::V1_3)
    }
}

impl SimulatedFirmware {
    pub fn new(version: SimulatedVersion) -> Self {
        let defaults = version.defaults();
        let mut firmware = Self {
            version,
            date_code: "201910".to_owned(),
            echo: false,
            ignition: true,
            vin_enabled: true,
            protocol: ObdProtocol::Can11b500k,
            vin: defaults.vin.to_owned(),
            calibration_id: defaults.calibration_id.map(str::to_owned),
            stored_dtcs: Vec::new(),
            pending_dtcs: Vec::new(),
            permanent_dtcs: Vec::new(),
            pids: HashMap::new(),
            reject_command: None,
        };
        firmware.reset_pids();
        firmware
    }

    /// A completed flash: the new firmware's defaults replace the old ones, as on the real unit.
    pub fn install(&mut self, version: SimulatedVersion) {
        let defaults = version.defaults();
        self.version = version;
        self.vin = defaults.vin.to_owned();
        self.calibration_id = defaults.calibration_id.map(str::to_owned);
        self.stored_dtcs.clear();
        self.pending_dtcs.clear();
        self.permanent_dtcs.clear();
        self.reset_pids();
    }

    pub fn banner(&self) -> String {
        simulated_banner(self.version)
    }

    pub fn details(&self) -> String {
        format!(
            "00.00.02,{},{},SIMULATED0000001",
            self.version.defaults().hardware,
            self.date_code
        )
    }

    fn reset_pids(&mut self) {
        self.pids.clear();
        for pid in ["0100", "0120", "0140"] {
            self.pids.insert(pid.to_owned(), SUPPORT_BITMAP.to_vec());
        }
        self.pids
            .insert("0101".to_owned(), DEFAULT_MONITOR_STATUS.to_vec());
    }

    fn boot_text(&self) -> String {
        format!(
            "{}\r\n{},{}\r\n{}",
            self.banner(),
            self.details(),
            self.vin,
            self.version.defaults().trailer
        )
    }

    /// Returns the exact text the firmware writes back for one received line.
    pub fn handle(&mut self, line: &str) -> String {
        let reply = self.respond(line);
        if self.echo {
            format!("{line}\r{reply}")
        } else {
            reply
        }
    }

    fn respond(&mut self, line: &str) -> String {
        const OK: &str = "OK\r";
        const ERROR: &str = "ERROR\r";
        let command = normalize(line);
        if self
            .reject_command
            .as_deref()
            .is_some_and(|rejected| normalize(rejected) == command)
        {
            return ERROR.to_owned();
        }
        let v13 = self.version == SimulatedVersion::V1_3;

        match command.as_str() {
            "ATZ" => {
                self.reset_pids();
                return format!("{}\r\n{}", self.banner(), self.boot_text());
            }
            "ATR" => {
                self.reset_pids();
                return format!("System Restarting...\r\n{}", self.boot_text());
            }
            "ATE0" | "ATE1" => {
                self.echo = command == "ATE1";
                return OK.to_owned();
            }
            "ATACC0" | "ATACC1" => {
                self.ignition = command == "ATACC1";
                return OK.to_owned();
            }
            "ATVIN0" | "ATVIN1" => {
                self.vin_enabled = command == "ATVIN1";
                return OK.to_owned();
            }
            "ATINF0" | "ATINF1" => return OK.to_owned(),
            "ATCLRDTC" => {
                self.stored_dtcs.clear();
                self.pending_dtcs.clear();
                self.permanent_dtcs.clear();
                return OK.to_owned();
            }
            _ => {}
        }

        if let Some(protocol) = command.strip_prefix("ATBUS") {
            return match protocol.parse() {
                Ok(protocol) => {
                    self.protocol = protocol;
                    OK.to_owned()
                }
                Err(_) => ERROR.to_owned(),
            };
        }

        if let Some((key, value)) = parse_set(&command) {
            if key == "VIN" {
                self.vin = value.to_owned();
                return OK.to_owned();
            }
            if key == "DTC" || (v13 && (key == "DTC7" || key == "DTCA")) {
                let codes: Vec<String> = value
                    .split(',')
                    .filter(|code| !code.is_empty())
                    .map(str::to_owned)
                    .collect();
                if codes.len() > MAX_DTCS || !codes.iter().all(|code| is_dtc(code)) {
                    return ERROR.to_owned();
                }
                match key {
                    "DTC" => self.stored_dtcs = codes,
                    "DTC7" => self.pending_dtcs = codes,
                    _ => self.permanent_dtcs = codes,
                }
                return OK.to_owned();
            }
            if v13 && key == "CALID" {
                self.calibration_id = Some(value.to_owned());
                return OK.to_owned();
            }
            if is_mode01_pid(key) {
                if let Some(raw) = parse_raw_bytes(value) {
                    self.pids.insert(key.to_owned(), raw);
                    return OK.to_owned();
                }
                let value = js::number(value);
                if !value.is_finite() || value < 0.0 {
                    return ERROR.to_owned();
                }
                let bytes = find_pid(key).map_or_else(Vec::new, |pid| pid.encode(value));
                self.pids.insert(key.to_owned(), bytes);
                return OK.to_owned();
            }
            return ERROR.to_owned();
        }

        if let Some(key) = parse_get(&command) {
            if key == "VIN" {
                return format!("{}\r\n", self.vin);
            }
            if key == "CALID"
                && let Some(calibration_id) = &self.calibration_id
            {
                return format!("{calibration_id}\r\n");
            }
            if is_mode01_pid(key) {
                let bytes = self.pids.get(key).cloned().unwrap_or_else(|| {
                    find_pid(key).map_or_else(Vec::new, |pid| vec![0; pid.encode(0.0).len()])
                });
                let value = if bytes.is_empty() {
                    String::new()
                } else {
                    format!("{} ", format_hex_bytes(&bytes))
                };
                return format!("{key}={value}\r");
            }
            return ERROR.to_owned();
        }

        ERROR.to_owned()
    }
}

const fn protocol_number(protocol: ObdProtocol) -> &'static str {
    match protocol {
        ObdProtocol::J1850Pwm => "1",
        ObdProtocol::J1850Vpw => "2",
        ObdProtocol::Iso9141_2 => "3",
        ObdProtocol::Kwp2000_5bps => "4",
        ObdProtocol::Kwp2000Fast => "5",
        ObdProtocol::Can11b500k => "6",
        ObdProtocol::Can29b500k => "7",
        ObdProtocol::Can11b250k => "8",
        ObdProtocol::Can29b250k => "9",
        ObdProtocol::J1939 => "A",
    }
}

fn hex(value: impl Into<u32>) -> String {
    format!("{:02X}", value.into())
}

fn encode_dtc(code: &str) -> [u8; 2] {
    let letter = "PCBU".find(&code[..1]).unwrap_or(0) as u16;
    let value = u16::from_str_radix(&code[1..], 16).unwrap_or(0);
    [((letter << 6) | (value >> 8)) as u8, (value & 0xff) as u8]
}

fn join_hex(bytes: &[u32]) -> String {
    let parts: Vec<String> = bytes.iter().copied().map(hex).collect();
    parts.join(" ")
}

/// What an ELM327 prints for a CAN reply longer than one frame: the payload length, then the
/// ISO-TP frames, numbered.
fn iso_tp_frames(length: usize, bytes: &[u32]) -> String {
    let mut frames = vec![
        format!("{length:03X}"),
        format!("0: {}", join_hex(&bytes[..bytes.len().min(6)])),
    ];
    for (n, chunk) in bytes[6.min(bytes.len())..].chunks(7).enumerate() {
        frames.push(format!("{}: {}", n + 1, join_hex(chunk)));
    }
    frames.join("\r")
}

fn list_codes(reply: u32, codes: &[String]) -> String {
    let mut bytes = vec![reply, codes.len() as u32];
    bytes.extend(
        codes
            .iter()
            .flat_map(|code| encode_dtc(code))
            .map(u32::from),
    );
    let length = bytes.len();
    if length <= 7 {
        return join_hex(&bytes);
    }
    // A vehicle pads the last frame to seven bytes.
    bytes.resize(6 + (length - 6).div_ceil(7) * 7, 0);
    iso_tp_frames(length, &bytes)
}

/// An ELM327-compatible adapter plugged into the simulated emulator's OBD port. It answers from
/// the firmware's state the way a CAN vehicle does with headers off: `41 0C 1F 40`, then `>`.
pub struct SimulatedElm327;

impl SimulatedElm327 {
    pub fn handle(vehicle: &mut SimulatedFirmware, line: &str) -> String {
        format!("{}\r\r>", Self::respond(vehicle, &normalize(line)))
    }

    fn respond(vehicle: &mut SimulatedFirmware, command: &str) -> String {
        match command {
            "ATZ" | "ATI" => return "ELM327 v1.5".to_owned(),
            "ATDPN" => return format!("A{}", protocol_number(vehicle.protocol)),
            "ATRV" => return "12.6V".to_owned(),
            _ if command.starts_with("AT") => return "OK".to_owned(),
            _ if !is_upper_hex(command) => return "?".to_owned(),
            _ if !vehicle.ignition => return "NO DATA".to_owned(),
            _ => {}
        }

        if command.starts_with("01") && command.len() == 4 {
            let bytes = vehicle
                .pids
                .get(command)
                .cloned()
                .or_else(|| find_pid(command).map(|pid| pid.encode(0.0)))
                .unwrap_or_default();
            if bytes.is_empty() {
                return "NO DATA".to_owned();
            }
            let mut parts = vec!["41".to_owned(), command[2..].to_owned()];
            parts.extend(bytes.into_iter().map(hex));
            return parts.join(" ");
        }
        match command {
            "03" => list_codes(0x43, &vehicle.stored_dtcs),
            "07" => list_codes(0x47, &vehicle.pending_dtcs),
            "0A" => list_codes(0x4a, &vehicle.permanent_dtcs),
            // Mode 04 clears stored and pending codes; permanent ones stay until the fault is gone.
            "04" => {
                vehicle.stored_dtcs.clear();
                vehicle.pending_dtcs.clear();
                "44".to_owned()
            }
            "0902" if !vehicle.vin_enabled => "NO DATA".to_owned(),
            "0902" => {
                let mut bytes: Vec<u32> = vec![0x49, 0x02, 0x01];
                bytes.extend(vehicle.vin.chars().map(|c| {
                    let mut units = [0; 2];
                    u32::from(c.encode_utf16(&mut units)[0])
                }));
                iso_tp_frames(bytes.len(), &bytes)
            }
            _ => "NO DATA".to_owned(),
        }
    }
}

pub const SIMULATED_CHIP_ID: [u8; 12] = [
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67,
];
/// Stands in for the vendor bootloader below the application, so tests can see it untouched.
pub const SIMULATED_BOOTLOADER_BYTE: u8 = 0xb1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootloaderMode {
    Off,
    Armed,
    Handshake,
    Frames,
}

/// Under `duplicate_acks`, how long an ack takes, and how much later its copy follows.
const ACK_DELAY: Duration = Duration::from_millis(5);
const DUPLICATE_DELAY: Duration = Duration::from_millis(1);

/// The MK2 bootloader as a real V1.2 unit answered a read-only probe: after `ATR` (never before) it
/// answers `***` with `>>>` and `Download?` with `OK.`, then takes encrypted command frames until
/// it's told to run the application. Erase and write follow the vendor updater's capture. The real
/// wire key can't ship here, so it decrypts with whatever key it's given, and it refuses to erase
/// or write below the application, as the real one must.
#[derive(Debug, Clone)]
pub struct SimulatedBootloader {
    pub wire_key: WireKey,
    pub flash: Vec<u8>,
    pub mode: BootloaderMode,
    /// Handshakes to ignore before answering, like a unit still restarting.
    pub ignore_handshakes: u32,
    /// A command to answer with an error frame, or to leave unanswered.
    pub reject_command: Option<u8>,
    pub silent_command: Option<u8>,
    /// A command whose reply follows an unrelated frame, which the updater must skip.
    pub chatty_command: Option<u8>,
    /// A command whose reply comes again in a later read, like one that arrived after a timeout.
    pub late_command: Option<u8>,
    /// Sends each ack `ACK_DELAY` late, then a copy that must not pass for the next command's ack.
    pub duplicate_acks: bool,
    /// Commands that arrived while an ack held back by `duplicate_acks` was still due.
    pub commands_before_ack: u32,
    pub received: Vec<u8>,
    wrote: bool,
    late: Vec<u8>,
    held_acks: u32,
    ack_due: Option<Instant>,
    flashed: bool,
    text: Vec<u8>,
    frame: Option<Vec<u8>>,
}

impl Default for SimulatedBootloader {
    fn default() -> Self {
        Self::new()
    }
}

impl SimulatedBootloader {
    pub const FLASH_KIB: u32 = 128;
    const FLASH_END: u32 = FLASH_BASE + Self::FLASH_KIB * 1024;

    pub fn new() -> Self {
        let mut flash = vec![0xff; (Self::FLASH_KIB * 1024) as usize];
        flash[..(APPLICATION_BASE - FLASH_BASE) as usize].fill(SIMULATED_BOOTLOADER_BYTE);
        Self {
            wire_key: [0; 16],
            flash,
            mode: BootloaderMode::Off,
            ignore_handshakes: 0,
            reject_command: None,
            silent_command: None,
            chatty_command: None,
            late_command: None,
            duplicate_acks: false,
            commands_before_ack: 0,
            received: Vec::new(),
            wrote: false,
            late: Vec::new(),
            held_acks: 0,
            ack_due: None,
            flashed: false,
            text: Vec::new(),
            frame: None,
        }
    }

    /// Whether the application started after a flash that wrote something, since last asked.
    pub fn take_flashed(&mut self) -> bool {
        std::mem::take(&mut self.flashed)
    }

    /// What `late_command` sends again after its reply, since last asked.
    pub fn take_late(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.late)
    }

    /// How many acks `duplicate_acks` held back since last asked; each is sent twice, later.
    pub fn take_held_acks(&mut self) -> u32 {
        std::mem::take(&mut self.held_acks)
    }

    /// Bytes in, bytes out. Text the bootloader isn't waiting for is dropped.
    pub fn receive(&mut self, bytes: &[u8]) -> Vec<u8> {
        const FRAME_START: u8 = 0xbb;
        const FRAME_END: u8 = 0xee;
        let mut out = Vec::new();
        for &byte in bytes {
            // Between frames a new `***` restarts the handshake, so an aborted update can be retried.
            if self.mode != BootloaderMode::Frames || (self.frame.is_none() && byte != FRAME_START)
            {
                self.text.push(byte);
                if self.text.len() > 16 {
                    self.text.remove(0);
                }
                if self.text.ends_with(b"***") {
                    self.text.clear();
                    if self.ignore_handshakes > 0 {
                        self.ignore_handshakes -= 1;
                    } else {
                        self.mode = BootloaderMode::Handshake;
                        out.extend(b">>>");
                    }
                } else if self.mode == BootloaderMode::Handshake
                    && self.text.ends_with(b"Download?")
                {
                    self.text.clear();
                    self.mode = BootloaderMode::Frames;
                    out.extend(b"OK.");
                }
                continue;
            }
            if byte == FRAME_START {
                self.frame = Some(vec![byte]);
            } else if let Some(frame) = &mut self.frame {
                frame.push(byte);
                if byte == FRAME_END {
                    let frame = std::mem::take(frame);
                    self.frame = None;
                    out.extend(self.handle(&frame));
                }
            }
        }
        out
    }

    fn handle(&mut self, frame: &[u8]) -> Vec<u8> {
        let Ok(decoded) = decode_command_frame(frame, &self.wire_key) else {
            return Vec::new();
        };
        self.received.push(decoded.command);
        if self.ack_due.is_some_and(|due| Instant::now() < due) {
            self.commands_before_ack += 1;
        }
        if Some(decoded.command) == self.silent_command {
            return Vec::new();
        }
        let reply = self.reply(decoded.command, &decoded.payload);
        if self.duplicate_acks && reply == encode_reply_frame(command::ACK, &[0]) {
            self.held_acks += 1;
            self.ack_due = Some(Instant::now() + ACK_DELAY);
            return Vec::new();
        }
        if Some(decoded.command) == self.late_command {
            self.late.extend(&reply);
        }
        if Some(decoded.command) == self.chatty_command {
            let mut chatty = encode_reply_frame(decoded.command, &[1]);
            chatty.extend(reply);
            return chatty;
        }
        reply
    }

    fn reply(&mut self, code: u8, payload: &[u8]) -> Vec<u8> {
        let ack = encode_reply_frame(command::ACK, &[0]);
        let error = encode_reply_frame(command::ERROR, &[code, 1]);
        if Some(code) == self.reject_command {
            return error;
        }
        let address = || {
            payload
                .get(..4)
                .map(|b| u64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]])))
        };
        let count = || {
            payload
                .get(4..6)
                .map(|b| u64::from(u16::from_be_bytes([b[0], b[1]])))
        };
        let application = u64::from(APPLICATION_BASE);
        let end = u64::from(Self::FLASH_END);
        let offset = |address: u64| (address - u64::from(FLASH_BASE)) as usize;
        match code {
            command::READ_CHIP_ID => {
                let kib = Self::FLASH_KIB;
                let mut payload = vec![(kib >> 8) as u8, (kib & 0xff) as u8];
                payload.extend(SIMULATED_CHIP_ID);
                encode_reply_frame(code, &payload)
            }
            command::READ_SERIAL => encode_reply_frame(code, b"G1901.\0\0\0\0\0\0"),
            command::READ_VERSION => {
                encode_reply_frame(code, &[b'0', b'0', b'0', b'1', 0x14, 0x05, 0, 0x20, 1, 0])
            }
            command::READ_BOOT_INFO => encode_reply_frame(code, b"USART:0002"),
            command::READ_CHECK => encode_reply_frame(code, payload),
            command::ERASE => {
                let (Some(address), Some(pages)) = (address(), count()) else {
                    return error;
                };
                let stop = address + pages * 1024;
                if payload.len() != 6 || address < application || stop > end {
                    return error;
                }
                self.flash[offset(address)..offset(stop)].fill(0xff);
                ack
            }
            command::WRITE => {
                let (Some(address), Some(length)) = (address(), count()) else {
                    return error;
                };
                let data = &payload[6..];
                if length != data.len() as u64 || address < application {
                    return error;
                }
                if address + data.len() as u64 > end {
                    return error;
                }
                let start = offset(address);
                self.flash[start..start + data.len()].copy_from_slice(data);
                self.wrote = true;
                ack
            }
            command::WRITE_CRC if payload.len() == 16 => ack,
            command::WRITE_CRC => error,
            command::WRITE_DONE => ack,
            // Not a well-formed frame: the bare reply a real unit gave after a flash.
            command::READ_APP_INFO => vec![0xbb, 0x00, 0xee],
            command::RUN => {
                self.mode = BootloaderMode::Off;
                self.flashed |= self.wrote;
                self.wrote = false;
                ack
            }
            _ => error,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SimulatedHardware {
    pub firmware: SimulatedFirmware,
    pub bootloader: SimulatedBootloader,
}

/// One simulated MK2 per server, so its state survives reconnects like a real device.
#[derive(Debug, Clone)]
pub struct SimulatedDevice {
    hardware: Arc<Mutex<SimulatedHardware>>,
}

impl Default for SimulatedDevice {
    fn default() -> Self {
        Self::new(SimulatedVersion::V1_3)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Emulator,
    Adapter,
}

impl SimulatedDevice {
    pub fn new(version: SimulatedVersion) -> Self {
        let hardware = SimulatedHardware {
            firmware: SimulatedFirmware::new(version),
            bootloader: SimulatedBootloader::new(),
        };
        Self {
            hardware: Arc::new(Mutex::new(hardware)),
        }
    }

    /// The firmware and bootloader, for tests to inspect and stage. Never held across an await.
    pub fn lock(&self) -> MutexGuard<'_, SimulatedHardware> {
        self.hardware.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The emulator's USB serial port.
    #[tracing::instrument(name = "SimulatedDevice.link", skip_all, fields(side = "emulator"))]
    pub fn open(&self) -> SimulatedLink {
        self.link(Side::Emulator)
    }

    /// An OBD-II adapter plugged into the simulated emulator.
    #[tracing::instrument(name = "SimulatedDevice.link", skip_all, fields(side = "adapter"))]
    pub fn open_adapter(&self) -> SimulatedLink {
        self.link(Side::Adapter)
    }

    fn link(&self, side: Side) -> SimulatedLink {
        SimulatedLink {
            hardware: Arc::clone(&self.hardware),
            side,
            framer: LineFramer::new(),
            output: VecDeque::new(),
        }
    }
}

/// Queues a chunk to arrive at `at`, never ahead of one queued before it, as on a serial line.
fn send_at(output: &mut VecDeque<(Instant, String)>, at: Instant, chunk: String) {
    let at = output.back().map_or(at, |&(last, _)| at.max(last));
    output.push_back((at, chunk));
}

#[derive(Debug)]
pub struct SimulatedLink {
    hardware: Arc<Mutex<SimulatedHardware>>,
    side: Side,
    framer: LineFramer,
    output: VecDeque<(Instant, String)>,
}

impl SimulatedLink {
    fn receive(&mut self, bytes: &[u8]) {
        let mut hardware = self.hardware.lock().unwrap_or_else(PoisonError::into_inner);
        let SimulatedHardware {
            firmware,
            bootloader,
        } = &mut *hardware;
        let emulator = self.side == Side::Emulator;
        let now = Instant::now();
        if emulator && bootloader.mode != BootloaderMode::Off {
            let reply = bootloader.receive(bytes);
            // The image isn't parsed: a simulated flash installs the official V1.3, as on the unit.
            if bootloader.take_flashed() {
                firmware.install(SimulatedVersion::V1_3);
            }
            for reply in [reply, bootloader.take_late()] {
                if !reply.is_empty() {
                    send_at(&mut self.output, now, latin1(&reply));
                }
            }
            let ack = latin1(&encode_reply_frame(command::ACK, &[0]));
            for _ in 0..bootloader.take_held_acks() {
                send_at(&mut self.output, now + ACK_DELAY, ack.clone());
                send_at(
                    &mut self.output,
                    now + ACK_DELAY + DUPLICATE_DELAY,
                    ack.clone(),
                );
            }
            if bootloader.mode != BootloaderMode::Armed {
                return;
            }
        }
        for line in self.framer.push(&latin1(bytes)) {
            let reply = match self.side {
                Side::Emulator => firmware.handle(&line),
                Side::Adapter => SimulatedElm327::handle(firmware, &line),
            };
            send_at(&mut self.output, now, reply);
            // A reset restarts into the bootloader, which then listens for the updater.
            if emulator && normalize(&line) == "ATR" {
                bootloader.mode = BootloaderMode::Armed;
            }
        }
    }
}

impl DeviceLink for SimulatedLink {
    fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
        self.receive(data);
        Box::pin(std::future::ready(Ok(())))
    }

    // Writes need `&mut self` too, so a pending read can only end by being dropped; the link
    // never closes on its own.
    fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
        Box::pin(async move {
            let Some(&(due, _)) = self.output.front() else {
                return std::future::pending().await;
            };
            if due > Instant::now() {
                tokio::time::sleep_until(due).await;
            }
            self.output.pop_front().map(|(_, chunk)| Ok(chunk))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmware::bootloader_frame::{decode_reply_frame, encode_command_frame};

    // Replies recorded from a real MK2 (firmware V1.2) over USB.
    #[test]
    fn answers_like_the_v1_2_firmware() {
        for (command, reply) in [
            ("ATE0", "OK\r"),
            ("ATINF0", "OK\r"),
            ("ATGET 0101", "0101=00 07 65 00 \r"),
            ("ATGET 0105", "0105=00 \r"),
            ("ATGET 0142", "0142=00 00 \r"),
            ("ATGET 0120", "0120=FF FF FF FF \r"),
            ("ATGET 01FF", "01FF=\r"),
            ("ATSET 0105=-10", "ERROR\r"),
            ("ATSET CALID=ABC123", "ERROR\r"),
            ("ATGET CALID", "ERROR\r"),
            ("ATSET DTC7=P0300", "ERROR\r"),
            ("ATSET DTCA=U0100", "ERROR\r"),
            ("ATSET DTC=X123", "ERROR\r"),
            ("ATSET DTC=P0105,P0106", "OK\r"),
            ("ATGET DTC", "ERROR\r"),
            ("ATBUS FOO", "ERROR\r"),
            ("ATGET BUS", "ERROR\r"),
            ("ATBOGUS", "ERROR\r"),
            ("ATGET VIN", "1HGCD5654VA061985\r\n"),
            ("atget vin", "1HGCD5654VA061985\r\n"),
        ] {
            let mut firmware = SimulatedFirmware::new(SimulatedVersion::V1_2);
            assert_eq!(firmware.handle(command), reply, "{command}");
        }
    }

    // Replies the same unit gave after it was flashed to V1.3 on 2026-10-30.
    #[test]
    fn answers_like_v1_3() {
        for (command, reply) in [
            ("ATGET VIN", "LSGGG54EXE105928\r\n"),
            ("ATGET CALID", "JMB*36761500\r\n"),
            ("ATSET DTC7=P0300", "OK\r"),
            ("ATSET DTCA=U0100", "OK\r"),
        ] {
            let mut firmware = SimulatedFirmware::new(SimulatedVersion::V1_3);
            assert_eq!(firmware.handle(command), reply, "{command}");
        }
    }

    #[test]
    fn prints_the_v1_3_extra_line_after_the_info_line_on_restart() {
        let reply = SimulatedFirmware::new(SimulatedVersion::V1_3).handle("ATR");
        let banner = simulated_banner(SimulatedVersion::V1_3);
        assert!(reply.contains(&format!("{banner}\r\n00.00.02,00.01.08,")));
        assert!(reply.ends_with(",LSGGG54EXE105928\r\nSPN:00\r\n"));
    }

    #[test]
    fn reports_pending_and_permanent_codes_to_a_scan_tool_on_v1_3() {
        let mut firmware = SimulatedFirmware::new(SimulatedVersion::V1_3);
        firmware.handle("ATSET DTC7=P0300,P0420");
        firmware.handle("ATSET DTCA=U0100");
        assert_eq!(
            SimulatedElm327::handle(&mut firmware, "07"),
            "47 02 03 00 04 20\r\r>"
        );
        assert_eq!(
            SimulatedElm327::handle(&mut firmware, "0A"),
            "4A 01 C1 00\r\r>"
        );
        firmware.handle("ATSET DTC=P0105,P0300,P0420,P0171");
        assert_eq!(
            SimulatedElm327::handle(&mut firmware, "03"),
            "00A\r0: 43 04 01 05 03 00\r1: 04 20 01 71 00 00 00\r\r>"
        );
        assert_eq!(SimulatedElm327::handle(&mut firmware, "04"), "44\r\r>");
        assert!(firmware.pending_dtcs.is_empty());
        assert_eq!(firmware.permanent_dtcs, ["U0100"]);
    }

    #[test]
    fn stores_raw_and_decimal_pid_values() {
        let mut firmware = SimulatedFirmware::default();
        assert_eq!(firmware.handle("ATSET 010C=0x1F,0x40"), "OK\r");
        assert_eq!(firmware.handle("ATGET 010C"), "010C=1F 40 \r");
        assert_eq!(firmware.handle("ATSET 0142=13.8"), "OK\r");
        assert_eq!(firmware.handle("ATGET 0142"), "0142=35 E8 \r");
    }

    #[test]
    fn echoes_commands_while_echo_is_on() {
        let mut firmware = SimulatedFirmware::default();
        firmware.handle("ATE1");
        assert_eq!(firmware.handle("ATGET BUS"), "ATGET BUS\rERROR\r");
    }

    #[test]
    fn zeroes_pids_and_prints_the_banner_on_reset() {
        let mut firmware = SimulatedFirmware::new(SimulatedVersion::V1_2);
        firmware.handle("ATSET 010C=2000");
        let reply = firmware.handle("ATZ");
        let banner = simulated_banner(SimulatedVersion::V1_2);
        assert!(reply.starts_with(&format!("{banner}\r\n{banner}\r\n")));
        assert!(reply.ends_with(",1HGCD5654VA061985\r\n"));
        assert_eq!(firmware.handle("ATGET 010C"), "010C=00 00 \r");
    }

    fn said(bytes: &[u8]) -> String {
        latin1(bytes)
    }

    // Replies a real MK2 V1.2 bootloader gave a read-only probe on 2026-10-30.
    #[test]
    fn answers_the_handshake_only_after_a_reset_arms_it() {
        let mut bootloader = SimulatedBootloader::new();
        assert_eq!(bootloader.mode, BootloaderMode::Off);
        bootloader.mode = BootloaderMode::Armed;
        assert_eq!(said(&bootloader.receive(b"***")), ">>>");
        assert_eq!(said(&bootloader.receive(b"Download?")), "OK.");
    }

    #[test]
    fn reports_128_kib_of_flash_and_a_12_byte_chip_id() {
        let mut bootloader = SimulatedBootloader::new();
        bootloader.mode = BootloaderMode::Armed;
        bootloader.receive(b"***Download?");
        let request =
            encode_command_frame(command::READ_CHIP_ID, &[], &bootloader.wire_key, &[0; 14])
                .unwrap();
        let reply = decode_reply_frame(&bootloader.receive(&request)).unwrap();
        assert_eq!(reply.command, command::READ_CHIP_ID);
        assert_eq!(
            (reply.payload[0], reply.payload[1], reply.payload.len()),
            (0x00, 0x80, 14)
        );
    }

    #[tokio::test]
    async fn arms_the_bootloader_after_a_reset_on_the_emulator_link_only() {
        let device = SimulatedDevice::new(SimulatedVersion::V1_2);
        let mut adapter = device.open_adapter();
        adapter.write(b"ATR\r").await.unwrap();
        assert_eq!(adapter.next_chunk().await.unwrap().unwrap(), "OK\r\r>");
        assert_eq!(device.lock().bootloader.mode, BootloaderMode::Off);

        let mut link = device.open();
        link.write(b"ATR\r").await.unwrap();
        let restart = link.next_chunk().await.unwrap().unwrap();
        assert!(restart.starts_with("System Restarting...\r\n"));
        link.write(b"***").await.unwrap();
        assert_eq!(link.next_chunk().await.unwrap().unwrap(), ">>>");
    }
}
