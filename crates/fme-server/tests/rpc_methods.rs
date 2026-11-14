//! Every RPC method on the wire: the frames the web client's Effect `RpcClient` sends, and the
//! exact JSON the server answers, through one connection on the simulated device. Timestamps,
//! the measured poll rate, random preset ids and the temp data dir are normalized.
#![recursion_limit = "256"]
#![cfg(test)]

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use effect_rpc::Connection;
use fme_core::contracts::firmware::VendorFile;
use fme_server::device::device_link::{
    ChunkSender, Chunks, DeviceLink, DeviceLinkError, LinkFuture, LinkOperation, latin1,
};
use fme_server::device::serial_ports::{Platform, PortSystem, SerialPorts};
use fme_server::firmware::firmware_updater::FirmwareUpdater;
use fme_server::firmware::vendor_package::ReqwestClient;
use fme_server::ws::{self, Services};
use serde_json::{Value, json};
use tokio::sync::mpsc;

// The FIPS-197 example key; the simulated bootloader takes whichever key the update uses.
const TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f";
const FLASH_BASE: u32 = 0x0800_0000;
const APPLICATION_BASE: u32 = 0x0800_3800;
const MISSING_PORT: &str = "no-such-port";
const STALLED_ADAPTER: &str = "stalled-adapter";

fn hex_record(kind: u8, offset: u16, data: &[u8]) -> String {
    let [high, low] = offset.to_be_bytes();
    let mut fields = vec![data.len() as u8, high, low, kind];
    fields.extend_from_slice(data);
    let sum = fields
        .iter()
        .fold(0_u8, |sum, byte| sum.wrapping_add(*byte));
    fields.push(sum.wrapping_neg());
    let hex: String = fields.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(":{hex}")
}

fn hex_file(address: u32, data: &[u8]) -> String {
    let mut lines = Vec::new();
    for (index, chunk) in data.chunks(16).enumerate() {
        let at = address + 16 * index as u32;
        if index == 0 || at & 0xffff == 0 {
            let [upper, lower, ..] = at.to_be_bytes();
            lines.push(hex_record(0x04, 0, &[upper, lower]));
        }
        lines.push(hex_record(0x00, (at & 0xffff) as u16, chunk));
    }
    lines.push(hex_record(0x01, 0, &[]));
    lines.join("\n")
}

fn application() -> Vec<u8> {
    (0..2500_u32).map(|i| (i * 7) as u8).collect()
}

/// Serial ports for the test: one path that can't be opened and one adapter that starts its
/// reset banner and never finishes it. Each reset it hears is reported on `resets`.
#[derive(Debug)]
struct TestPorts {
    resets: mpsc::UnboundedSender<()>,
}

impl PortSystem for TestPorts {
    fn open<'a>(
        &'a self,
        path: &'a str,
    ) -> LinkFuture<'a, Result<Box<dyn DeviceLink>, DeviceLinkError>> {
        let opened: Result<Box<dyn DeviceLink>, DeviceLinkError> =
            if path.ends_with(STALLED_ADAPTER) {
                let (replies, chunks) = Chunks::channel();
                Ok(Box::new(StalledAdapter {
                    replies,
                    chunks,
                    resets: self.resets.clone(),
                }))
            } else {
                Err(DeviceLinkError::new(
                    LinkOperation::Open,
                    io::Error::from(io::ErrorKind::NotFound),
                ))
            };
        Box::pin(std::future::ready(opened))
    }

    fn is_bluetooth<'a>(&'a self, _path: &'a str) -> LinkFuture<'a, bool> {
        Box::pin(std::future::ready(false))
    }
}

struct StalledAdapter {
    replies: ChunkSender,
    chunks: Chunks,
    resets: mpsc::UnboundedSender<()>,
}

impl DeviceLink for StalledAdapter {
    fn write<'a>(&'a mut self, data: &'a [u8]) -> LinkFuture<'a, Result<(), DeviceLinkError>> {
        if latin1(data).contains("ATZ") {
            self.replies.send(Ok("ELM327 v1.5\r".to_owned())).ok();
            self.resets.send(()).ok();
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn next_chunk(&mut self) -> LinkFuture<'_, Option<Result<String, DeviceLinkError>>> {
        Box::pin(self.chunks.next())
    }
}

/// Replaces what differs from run to run, as a diff of two recordings would: wall-clock
/// timestamps, a measured poll rate, random user preset ids (numbered by first appearance) and
/// the temp data dir.
#[derive(Default)]
struct Normalizer {
    data_dir: String,
    preset_ids: HashMap<String, String>,
}

impl Normalizer {
    fn normalize(&mut self, value: &Value, key: Option<&str>) -> Value {
        match value {
            Value::Number(_) if matches!(key, Some("at" | "dtcsAt")) => json!("<time>"),
            Value::Number(rate) if key == Some("pollRate") => {
                if rate.as_f64().is_some_and(|rate| rate > 0.0) {
                    json!("<rate>")
                } else {
                    value.clone()
                }
            }
            Value::String(text) if is_user_preset_id(text) => {
                let next = format!("user:<id-{}>", self.preset_ids.len() + 1);
                json!(self.preset_ids.entry(text.clone()).or_insert(next))
            }
            Value::String(text) => json!(text.replace(&self.data_dir, "<data-dir>")),
            Value::Array(items) => items
                .iter()
                .map(|item| self.normalize(item, None))
                .collect(),
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(field, item)| (field.clone(), self.normalize(item, Some(field))))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
}

fn is_user_preset_id(text: &str) -> bool {
    text.strip_prefix("user:")
        .is_some_and(|id| id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
}

/// An RPC client as the web app's `RpcClient` speaks to one connection: requests with fresh
/// ids, an `Ack` after each chunk it takes, an `Interrupt` when it stops listening.
struct Client {
    connection: Connection,
    frames: mpsc::UnboundedReceiver<Value>,
    waiting: Vec<Value>,
    next_id: u64,
    normalizer: Normalizer,
}

impl Client {
    fn new(services: &Services, data_dir: &Path) -> Self {
        let (sender, frames) = mpsc::unbounded_channel();
        let connection = Connection::new(Arc::new(ws::handlers(services)), move |message| {
            // The text the socket sends, read back as JSON.
            let text = serde_json::to_string(&message).unwrap();
            sender.send(serde_json::from_str(&text).unwrap()).ok();
        });
        Self {
            connection,
            frames,
            waiting: Vec::new(),
            next_id: 0,
            normalizer: Normalizer {
                data_dir: data_dir.display().to_string(),
                ..Normalizer::default()
            },
        }
    }

    fn send(&self, message: &Value) {
        let flow = self.connection.receive(&message.to_string());
        assert!(flow.is_continue(), "the connection closed on {message}");
    }

    fn request(&mut self, tag: &str, payload: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.send(
            &json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] }),
        );
        id
    }

    /// The next frame for request `id`. Frames for other requests wait for their own turn.
    async fn frame(&mut self, id: u64) -> Value {
        if let Some(index) = self
            .waiting
            .iter()
            .position(|frame| frame["requestId"] == id)
        {
            return self.waiting.remove(index);
        }
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(60), self.frames.recv())
                .await
                .unwrap_or_else(|_| panic!("no frame for request {id}"))
                .unwrap();
            if frame["requestId"] == id {
                return frame;
            }
            assert!(frame.get("requestId").is_some(), "unexpected {frame}");
            self.waiting.push(frame);
        }
    }

    /// The `exit` of request `id`, normalized.
    async fn exit(&mut self, id: u64) -> Value {
        let frame = self.frame(id).await;
        assert_eq!(frame["_tag"], "Exit", "{frame}");
        self.normalizer.normalize(&frame["exit"], None)
    }

    async fn call(&mut self, tag: &str, payload: Value) -> Value {
        let id = self.request(tag, payload);
        self.exit(id).await
    }

    /// The values of the next chunk of stream `id`, raw, and acks it.
    async fn chunk(&mut self, id: u64) -> Vec<Value> {
        let frame = self.frame(id).await;
        assert_eq!(frame["_tag"], "Chunk", "{frame}");
        self.send(&json!({ "_tag": "Ack", "requestId": id }));
        frame["values"].as_array().unwrap().clone()
    }

    /// Chunk values of stream `id` until one satisfies `done`, which is returned normalized.
    async fn chunk_where(&mut self, id: u64, done: impl Fn(&Value) -> bool) -> Value {
        loop {
            if let Some(value) = self.chunk(id).await.into_iter().find(&done) {
                return self.normalizer.normalize(&value, None);
            }
        }
    }

    async fn interrupt(&mut self, id: u64) {
        self.send(&json!({ "_tag": "Interrupt", "requestId": id }));
        assert_eq!(self.exit(id).await, interrupted());
    }

    /// The first value of a stream, normalized, then stops listening as `Stream.runHead` does.
    async fn head(&mut self, tag: &str) -> Value {
        let id = self.request(tag, Value::Null);
        let frame = self.frame(id).await;
        assert_eq!(frame["_tag"], "Chunk", "{frame}");
        assert_eq!(frame["values"].as_array().map(Vec::len), Some(1), "{frame}");
        self.interrupt(id).await;
        self.normalizer.normalize(&frame["values"][0], None)
    }

    async fn traffic_until(&mut self, done: impl Fn(&Value) -> bool) -> Vec<Value> {
        let id = self.request("emulator.subscribeTraffic", Value::Null);
        let mut entries = Vec::new();
        loop {
            let values = self.chunk(id).await;
            if let Some(end) = values.iter().position(&done) {
                entries.extend_from_slice(&values[..=end]);
                break;
            }
            entries.extend(values);
        }
        self.interrupt(id).await;
        entries
            .iter()
            .map(|entry| self.normalizer.normalize(entry, None))
            .collect()
    }
}

fn ok(value: Value) -> Value {
    json!({ "_tag": "Success", "value": value })
}

fn fail(error: Value) -> Value {
    json!({ "_tag": "Failure", "cause": [{ "_tag": "Fail", "error": error }] })
}

fn interrupted() -> Value {
    json!({ "_tag": "Failure", "cause": [{ "_tag": "Interrupt" }] })
}

/// Applies a JSON merge patch (RFC 7386): objects merge, `null` removes, the rest replaces.
fn merge(target: &mut Value, patch: Value) {
    let Value::Object(fields) = patch else {
        *target = patch;
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let object = target.as_object_mut().unwrap();
    for (field, value) in fields {
        if value.is_null() {
            object.remove(&field);
        } else {
            merge(object.entry(field).or_insert(Value::Null), value);
        }
    }
}

fn patched(base: &Value, patch: Value) -> Value {
    let mut value = base.clone();
    merge(&mut value, patch);
    value
}

fn traffic(channel: &str, entries: &[(u64, &str, &str)]) -> Vec<Value> {
    entries
        .iter()
        .map(|(sequence, direction, text)| {
            json!({
                "sequence": sequence,
                "channel": channel,
                "at": "<time>",
                "direction": direction,
                "text": text,
            })
        })
        .collect()
}

const MONITORS: [&str; 11] = [
    "misfire",
    "fuelSystem",
    "components",
    "catalyst",
    "heatedCatalyst",
    "evaporativeSystem",
    "secondaryAirSystem",
    "acRefrigerant",
    "oxygenSensor",
    "oxygenSensorHeater",
    "egrSystem",
];

fn initial_emulator_state() -> Value {
    let readiness: serde_json::Map<String, Value> = MONITORS
        .iter()
        .map(|monitor| {
            (
                (*monitor).to_owned(),
                json!({ "supported": true, "complete": true }),
            )
        })
        .collect();
    let pids = json!({
        "010C": 1000, "0104": 50, "0143": 50, "010E": 0, "0161": 90, "0162": 50, "0163": 240,
        "0142": 14, "011F": 0, "010D": 50, "0121": 0, "0131": 0, "014D": 0, "014E": 0,
        "0130": 0, "0111": 20, "0145": 0, "0147": 0, "0148": 0, "0149": 0, "014A": 0,
        "014B": 0, "014C": 0, "015A": 0, "010B": 100, "0110": 80, "0133": 101, "010A": 150,
        "0122": 200, "0123": 0, "012F": 75, "0152": 0, "015D": 0, "015E": 20, "0105": 90,
        "010F": 20, "0146": 25, "015C": 95, "013C": 0, "013D": 0, "013E": 0, "013F": 0,
        "012C": 0, "012D": 0, "012E": 0
    });
    json!({
        "connection": { "_tag": "disconnected" },
        "capabilities": null,
        "ignition": true,
        "protocol": "CAN_11B_500K",
        "vinEnabled": true,
        "vin": null,
        "calibrationId": null,
        "dtcs": { "03": [], "07": [], "0A": [] },
        "pids": pids,
        "readiness": readiness,
        "lastPreset": null
    })
}

fn initial_reader_state() -> Value {
    json!({
        "connection": { "_tag": "disconnected" },
        "watching": ["010C", "010D", "0105"],
        "polling": { "paused": false, "interval": 500 },
        "pollRate": 0,
        "readings": {},
        "unanswered": [],
        "vehicleResponding": false,
        "voltage": null,
        "dtcs": null,
        "dtcsAt": null,
        "monitorStatus": null,
        "vin": null
    })
}

fn built_in_presets() -> Value {
    json!([
        {
            "id": "builtin:idle", "name": "Idle", "builtIn": true,
            "pids": {
                "010C": 750, "010D": 0, "0104": 25, "0143": 22, "0111": 14, "0149": 15,
                "010B": 30, "0110": 3.2, "015E": 1.05, "010E": 10, "0105": 90, "010F": 32,
                "015C": 95, "0146": 22
            }
        },
        {
            "id": "builtin:cruise", "name": "Cruise", "builtIn": true,
            "pids": {
                "010C": 2350, "010D": 72, "0104": 35, "0143": 31, "0111": 18, "0149": 24,
                "010B": 44, "0110": 14.5, "015E": 4.75, "010E": 32, "0105": 90, "010F": 28,
                "015C": 98, "0146": 22
            }
        },
        {
            "id": "builtin:cold-start", "name": "Cold start", "builtIn": true,
            "pids": {
                "010C": 1250, "010D": 0, "0104": 32, "0143": 28, "0111": 15, "0149": 15,
                "010B": 33, "0110": 6.4, "015E": 2.45, "010E": 4, "0105": 6, "010F": 7,
                "015C": 6, "0146": 5
            }
        },
        {
            "id": "builtin:wide-open-throttle", "name": "Wide-open throttle", "builtIn": true,
            "pids": {
                "010C": 5500, "010D": 98, "0104": 98, "0143": 92, "0111": 88, "0149": 84,
                "010B": 98, "0110": 99.8, "015E": 38.55, "010E": 24, "0105": 96, "010F": 30,
                "015C": 108, "0146": 22
            }
        },
        {
            "id": "builtin:overheat", "name": "Overheat", "builtIn": true,
            "pids": {
                "010C": 820, "010D": 0, "0104": 27, "0143": 24, "0111": 14, "0149": 15,
                "010B": 32, "0110": 3.5, "015E": 1.15, "010E": 2, "0105": 118, "010F": 55,
                "015C": 128, "0146": 35
            }
        }
    ])
}

fn connected_to_the_simulator() -> Value {
    json!({
        "_tag": "connected",
        "target": { "_tag": "simulated" },
        "device": {
            "banner": "OBD-II EMULATOR V1.3",
            "details": "00.00.02,00.01.08,201910,SIMULATED0000001,LSGGG54EXE105928"
        },
        "unsent": []
    })
}

/// What the connect handshake sends the simulated MK2 for this session's settings, up to its
/// VIN read.
fn handshake_traffic() -> Vec<Value> {
    let mut entries = vec![
        (1, "tx", "ATZ"),
        (2, "rx", "OBD-II EMULATOR V1.3"),
        (3, "rx", "OBD-II EMULATOR V1.3"),
        (
            4,
            "rx",
            "00.00.02,00.01.08,201910,SIMULATED0000001,LSGGG54EXE105928",
        ),
        (5, "rx", "SPN:00"),
    ];
    let commands = [
        "ATE0",
        "ATINF0",
        "ATSET DTC7=P0000",
        "ATSET DTCA=P0000",
        "ATCLR DTC",
        "ATBUS CAN_11B_500K",
        "ATACC0",
        "ATVIN1",
        "ATSET 010C=0x12,0xC0",
        "ATSET 0104=0x80",
        "ATSET 0143=0x00,0x80",
        "ATSET 010E=0x80",
        "ATSET 0161=0xD7",
        "ATSET 0162=0xAF",
        "ATSET 0163=0x00,0xF0",
        "ATSET 0142=0x36,0xB0",
        "ATSET 011F=0x00,0x00",
        "ATSET 010D=0x32",
        "ATSET 0121=0x00,0x00",
        "ATSET 0131=0x00,0x00",
        "ATSET 014D=0x00,0x00",
        "ATSET 014E=0x00,0x00",
        "ATSET 0130=0x00",
        "ATSET 0111=0x33",
        "ATSET 0145=0x00",
        "ATSET 0147=0x00",
        "ATSET 0148=0x00",
        "ATSET 0149=0x00",
        "ATSET 014A=0x00",
        "ATSET 014B=0x00",
        "ATSET 014C=0x00",
        "ATSET 015A=0x00",
        "ATSET 010B=0x64",
        "ATSET 0110=0x1F,0x40",
        "ATSET 0133=0x65",
        "ATSET 010A=0x32",
        "ATSET 0122=0x09,0xE4",
        "ATSET 0123=0x00,0x00",
        "ATSET 012F=0xBF",
        "ATSET 0152=0x00",
        "ATSET 015D=0x69,0x00",
        "ATSET 015E=0x01,0x90",
        "ATSET 0105=0x82",
        "ATSET 010F=0x3C",
        "ATSET 0146=0x41",
        "ATSET 015C=0x87",
        "ATSET 013C=0x01,0x90",
        "ATSET 013D=0x01,0x90",
        "ATSET 013E=0x01,0x90",
        "ATSET 013F=0x01,0x90",
        "ATSET 012C=0x00",
        "ATSET 012D=0x80",
        "ATSET 012E=0x00",
        "ATSET 0101=0x00,0x07,0xFF,0x00",
    ];
    for (index, command) in commands.into_iter().enumerate() {
        let sequence = 6 + 2 * index as u64;
        entries.push((sequence, "tx", command));
        entries.push((sequence + 1, "rx", "OK"));
    }
    entries.push((114, "tx", "ATGET VIN"));
    traffic("emulator", &entries)
}

struct Fixture {
    client: Client,
    updater: FirmwareUpdater,
    data_dir: tempfile::TempDir,
    resets: mpsc::UnboundedReceiver<()>,
}

impl Fixture {
    async fn new() -> Self {
        let data_dir = tempfile::tempdir().unwrap();
        let (resets_tx, resets) = mpsc::unbounded_channel();
        let ports = SerialPorts::with_system(Platform::Linux, TestPorts { resets: resets_tx });
        let http = Arc::new(ReqwestClient::new().unwrap());
        let services = Services::with_serial_ports(data_dir.path(), http, ports).await;
        Self {
            client: Client::new(&services, data_dir.path()),
            updater: services.firmware.updater.clone(),
            data_dir,
            resets,
        }
    }

    fn port(&self, name: &str) -> String {
        self.data_dir.path().join(name).display().to_string()
    }
}

/// Holds the paused clock still while real sockets do their part: tokio doesn't auto-advance
/// while a blocking task runs.
struct ClockHold {
    release: std::sync::mpsc::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl ClockHold {
    fn new() -> Self {
        let (release, released) = std::sync::mpsc::channel::<()>();
        let task = tokio::task::spawn_blocking(move || {
            released.recv().ok();
        });
        Self { release, task }
    }

    async fn release(self) {
        drop(self.release);
        self.task.await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn every_method_answers_on_the_wire() {
    let mut fixture = Fixture::new().await;
    fresh_server(&mut fixture).await;
    let state = emulator(&mut fixture).await;
    let state = presets(&mut fixture, state).await;
    reader(&mut fixture, &state).await;
    stalled_adapter(&mut fixture).await;
    firmware(&mut fixture, state).await;
}

async fn fresh_server(fixture: &mut Fixture) {
    let c = &mut fixture.client;
    assert_eq!(
        c.head("emulator.subscribeState").await,
        initial_emulator_state()
    );
    assert_eq!(
        c.head("reader.subscribeState").await,
        initial_reader_state()
    );
    assert_eq!(c.head("presets.subscribe").await, built_in_presets());
    assert_eq!(
        c.head("firmware.subscribeUpdate").await,
        json!({ "_tag": "idle" })
    );
    assert_eq!(
        c.head("firmware.subscribeWireKey").await,
        json!({ "_tag": "absent" })
    );
    assert_eq!(c.head("firmware.subscribeLibrary").await, json!([]));
    // This machine's ports: only that the list encodes.
    let ports = c.call("emulator.listPorts", Value::Null).await;
    assert_eq!(ports["_tag"], "Success", "{ports}");
    assert!(ports["value"].is_array(), "{ports}");
}

/// Offline edits, a failed and a good connect, every setter, raw commands, the traffic log and
/// the state stream. Returns the emulator state at the end.
async fn emulator(fixture: &mut Fixture) -> Value {
    let missing_port = fixture.port(MISSING_PORT);
    let c = &mut fixture.client;
    assert_eq!(
        c.call("emulator.sendRaw", json!({ "command": "ATI" }))
            .await,
        fail(json!({ "_tag": "EmulatorNotConnectedError" }))
    );
    assert_eq!(
        c.call("emulator.setIgnition", json!({ "on": false })).await,
        ok(Value::Null)
    );
    assert_eq!(
        c.call("emulator.setPid", json!({ "pid": "010C", "value": 1200 }))
            .await,
        ok(Value::Null)
    );
    let mut state = patched(
        &initial_emulator_state(),
        json!({ "ignition": false, "pids": { "010C": 1200 } }),
    );
    assert_eq!(c.head("emulator.subscribeState").await, state);

    let serial = json!({ "_tag": "serial", "path": missing_port });
    let normalized_serial = json!({ "_tag": "serial", "path": "<data-dir>/no-such-port" });
    assert_eq!(
        c.call("emulator.connect", json!({ "target": serial }))
            .await,
        fail(json!({
            "_tag": "EmulatorConnectError",
            "target": normalized_serial,
            "reason": "open-failed"
        }))
    );
    state["connection"] = json!({
        "_tag": "failed",
        "target": normalized_serial,
        "reason": "Could not open the serial port."
    });
    assert_eq!(c.head("emulator.subscribeState").await, state);

    assert_eq!(
        c.call(
            "emulator.connect",
            json!({ "target": { "_tag": "simulated" } })
        )
        .await,
        ok(Value::Null)
    );
    state["connection"] = connected_to_the_simulator();
    merge(
        &mut state,
        json!({
            "capabilities": { "dtcModes": ["03", "07", "0A"], "calibrationId": true },
            "vin": "LSGGG54EXE105928",
            "calibrationId": "JMB*36761500"
        }),
    );
    assert_eq!(c.head("emulator.subscribeState").await, state);

    for (tag, payload) in [
        ("emulator.setIgnition", json!({ "on": true })),
        (
            "emulator.setProtocol",
            json!({ "protocol": "CAN_29B_500K" }),
        ),
        ("emulator.setVinEnabled", json!({ "enabled": true })),
        ("emulator.setVin", json!({ "vin": "WVWZZZ1JZXW000001" })),
        (
            "emulator.setCalibrationId",
            json!({ "calibrationId": "TESTCAL1" }),
        ),
        ("emulator.setPid", json!({ "pid": "010C", "value": 2500 })),
        ("emulator.setPid", json!({ "pid": "0105", "value": -10 })),
        ("emulator.setPid", json!({ "pid": "0142", "value": 13.8 })),
        (
            "emulator.setDtcs",
            json!({ "mode": "03", "codes": ["P0105", "P0300"] }),
        ),
        (
            "emulator.setDtcs",
            json!({ "mode": "07", "codes": ["P0420"] }),
        ),
        (
            "emulator.setReadiness",
            json!({ "monitor": "misfire", "supported": true, "complete": false }),
        ),
    ] {
        assert_eq!(
            c.call(tag, payload.clone()).await,
            ok(Value::Null),
            "{tag} {payload}"
        );
    }
    for (command, lines) in [
        ("ATGET 0101", json!(["0101=82 17 FF 00"])),
        ("ATBOGUS", json!(["ERROR"])),
        ("ATGET VIN", json!(["WVWZZZ1JZXW000001"])),
    ] {
        assert_eq!(
            c.call("emulator.sendRaw", json!({ "command": command }))
                .await,
            ok(json!({ "lines": lines })),
            "{command}"
        );
    }
    merge(
        &mut state,
        json!({
            "ignition": true,
            "protocol": "CAN_29B_500K",
            "vin": "WVWZZZ1JZXW000001",
            "calibrationId": "TESTCAL1",
            "dtcs": { "03": ["P0105", "P0300"], "07": ["P0420"] },
            "pids": { "010C": 2500, "0142": 13.8, "0105": -10 },
            "readiness": { "misfire": { "complete": false } }
        }),
    );
    assert_eq!(c.head("emulator.subscribeState").await, state);

    let handshake = c
        .traffic_until(|entry| entry["direction"] == "tx" && entry["text"] == "ATGET VIN")
        .await;
    assert_eq!(handshake, handshake_traffic());

    // The state stream sends the current state, then each change once it's acked.
    let stream = c.request("emulator.subscribeState", Value::Null);
    assert_eq!(c.chunk(stream).await, vec![state.clone()]);
    assert_eq!(
        c.call("emulator.setPid", json!({ "pid": "010D", "value": 77 }))
            .await,
        ok(Value::Null)
    );
    merge(&mut state, json!({ "pids": { "010D": 77 } }));
    let changed = c
        .chunk_where(stream, |state| state["pids"]["010D"] == 77)
        .await;
    assert_eq!(changed, state);
    c.interrupt(stream).await;
    state
}

/// Saving, renaming, applying and deleting presets, and their typed errors. Returns the
/// emulator state after the built-in preset.
async fn presets(fixture: &mut Fixture, mut state: Value) -> Value {
    let c = &mut fixture.client;
    let id = c.request(
        "presets.save",
        json!({ "name": "Weekend", "pids": { "010C": 1500, "010D": 40 } }),
    );
    let frame = c.frame(id).await;
    let saved_id = frame["exit"]["value"]["id"].clone();
    assert_eq!(
        c.normalizer.normalize(&frame["exit"], None),
        ok(json!({
            "id": "user:<id-1>",
            "name": "Weekend",
            "builtIn": false,
            "pids": { "010C": 1500, "010D": 40 }
        }))
    );
    assert_eq!(
        c.call(
            "presets.save",
            json!({ "id": saved_id, "name": "Weekend 2", "pids": { "010D": 55 } }),
        )
        .await,
        ok(json!({
            "id": "user:<id-1>",
            "name": "Weekend 2",
            "builtIn": false,
            "pids": { "010D": 55 }
        }))
    );
    let not_found = |id: &str| fail(json!({ "_tag": "PresetNotFoundError", "id": id }));
    let read_only = |operation: &str| {
        fail(json!({
            "_tag": "PresetReadOnlyError",
            "id": "builtin:idle",
            "operation": operation
        }))
    };
    assert_eq!(
        c.call(
            "presets.save",
            json!({ "id": "user:missing", "name": "Ghost", "pids": {} }),
        )
        .await,
        not_found("user:missing")
    );
    assert_eq!(
        c.call(
            "presets.save",
            json!({ "id": "builtin:idle", "name": "Mine", "pids": {} }),
        )
        .await,
        read_only("save")
    );

    assert_eq!(
        c.call("presets.apply", json!({ "id": saved_id })).await,
        ok(Value::Null)
    );
    merge(
        &mut state,
        json!({
            "pids": { "010D": 55 },
            "lastPreset": { "id": "user:<id-1>", "name": "Weekend 2" }
        }),
    );
    assert_eq!(c.head("emulator.subscribeState").await, state);
    assert_eq!(
        c.call("presets.apply", json!({ "id": "builtin:idle" }))
            .await,
        ok(Value::Null)
    );
    merge(
        &mut state,
        json!({
            "pids": {
                "010C": 750, "0104": 25, "0143": 22, "010E": 10, "010D": 0, "0111": 14,
                "0149": 15, "010B": 30, "0110": 3.2, "015E": 1.05, "0105": 90, "010F": 32,
                "0146": 22
            },
            "lastPreset": { "id": "builtin:idle", "name": "Idle" }
        }),
    );
    assert_eq!(c.head("emulator.subscribeState").await, state);
    assert_eq!(
        c.call("presets.apply", json!({ "id": "user:missing" }))
            .await,
        not_found("user:missing")
    );

    assert_eq!(
        c.call("presets.delete", json!({ "id": "builtin:idle" }))
            .await,
        read_only("delete")
    );
    assert_eq!(
        c.call("presets.delete", json!({ "id": saved_id })).await,
        ok(Value::Null)
    );
    assert_eq!(
        c.call("presets.delete", json!({ "id": saved_id })).await,
        not_found("user:<id-1>")
    );
    assert_eq!(c.head("presets.subscribe").await, built_in_presets());
    state
}

/// The OBD-II reader on the simulated adapter, its errors and its polling.
async fn reader(fixture: &mut Fixture, emulator_state: &Value) {
    let c = &mut fixture.client;
    let not_connected = fail(json!({ "_tag": "ReaderNotConnectedError" }));
    assert_eq!(c.call("reader.readDtcs", Value::Null).await, not_connected);
    assert_eq!(c.call("reader.readOnce", Value::Null).await, not_connected);

    // Nothing listens on port 1, so the connect fails on the socket, not on a timer.
    let closed_port = json!({ "_tag": "tcp", "host": "127.0.0.1", "port": 1 });
    let hold = ClockHold::new();
    let refused = c
        .call("reader.connect", json!({ "target": closed_port }))
        .await;
    hold.release().await;
    assert_eq!(
        refused,
        fail(json!({
            "_tag": "ReaderConnectError",
            "target": closed_port,
            "reason": "open-failed"
        }))
    );
    let mut state = initial_reader_state();
    state["connection"] = json!({
        "_tag": "failed",
        "target": closed_port,
        "reason": "Could not reach the OBD-II adapter."
    });
    assert_eq!(c.head("reader.subscribeState").await, state);

    for (tag, payload) in [
        (
            "reader.setPolling",
            json!({ "paused": true, "interval": 500 }),
        ),
        (
            "reader.connect",
            json!({ "target": { "_tag": "simulated" } }),
        ),
        (
            "reader.watch",
            json!({ "pids": ["010C", "010D", "0105", "0142"] }),
        ),
        ("reader.readOnce", Value::Null),
    ] {
        assert_eq!(
            c.call(tag, payload.clone()).await,
            ok(Value::Null),
            "{tag} {payload}"
        );
    }
    state["connection"] = json!({
        "_tag": "connected",
        "target": { "_tag": "simulated" },
        "adapter": "ELM327 v1.5",
        "protocol": "A7"
    });
    merge(
        &mut state,
        json!({
            "watching": ["010C", "010D", "0105", "0142"],
            "polling": { "paused": true },
            "readings": {
                "010C": { "value": 750, "raw": [11, 184], "at": "<time>" },
                "010D": { "value": 0, "raw": [0], "at": "<time>" },
                "0105": { "value": 90, "raw": [130], "at": "<time>" },
                "0142": { "value": 13.8, "raw": [53, 232], "at": "<time>" }
            },
            "vehicleResponding": true,
            "voltage": 12.6
        }),
    );
    assert_eq!(c.head("reader.subscribeState").await, state);

    assert_eq!(
        c.call("reader.readDtcs", Value::Null).await,
        ok(Value::Null)
    );
    assert_eq!(c.call("reader.readVin", Value::Null).await, ok(Value::Null));
    merge(
        &mut state,
        json!({
            "dtcs": ["P0105", "P0300"],
            "dtcsAt": "<time>",
            "monitorStatus": [130, 23, 255, 0],
            "vin": "WVWZZZ1JZXW000001"
        }),
    );
    assert_eq!(c.head("reader.subscribeState").await, state);
    assert_eq!(
        c.call("reader.clearDtcs", Value::Null).await,
        ok(Value::Null)
    );
    state["dtcs"] = json!([]);
    assert_eq!(c.head("reader.subscribeState").await, state);
    // The emulator state is what the server last set; codes cleared from the vehicle side stay.
    assert_eq!(c.head("emulator.subscribeState").await, *emulator_state);

    let stream = c.request("reader.subscribeState", Value::Null);
    c.chunk(stream).await;
    assert_eq!(
        c.call(
            "reader.setPolling",
            json!({ "paused": false, "interval": 250 }),
        )
        .await,
        ok(Value::Null)
    );
    let polled = c
        .chunk_where(stream, |state| state["pollRate"].as_f64() > Some(0.0))
        .await;
    assert_eq!(polled["pollRate"], "<rate>");
    c.interrupt(stream).await;
    assert_eq!(
        c.call(
            "reader.setPolling",
            json!({ "paused": true, "interval": 1000 }),
        )
        .await,
        ok(Value::Null)
    );
    assert_eq!(
        c.call("reader.disconnect", Value::Null).await,
        ok(Value::Null)
    );
    state["connection"] = json!({ "_tag": "disconnected" });
    merge(
        &mut state,
        json!({ "polling": { "interval": 1000 }, "vehicleResponding": false }),
    );
    assert_eq!(c.head("reader.subscribeState").await, state);
}

/// An adapter that starts its reset banner and never finishes it: the connect fails as no
/// adapter, and one abandoned halfway leaves the reader disconnected. The banner is logged
/// either way, once the reset times out.
async fn stalled_adapter(fixture: &mut Fixture) {
    let path = fixture.port(STALLED_ADAPTER);
    let c = &mut fixture.client;
    let target = json!({ "_tag": "serial", "path": path });
    let normalized_target = json!({ "_tag": "serial", "path": "<data-dir>/stalled-adapter" });
    assert_eq!(
        c.call("reader.connect", json!({ "target": target })).await,
        fail(json!({
            "_tag": "ReaderConnectError",
            "target": normalized_target,
            "reason": "no-adapter"
        }))
    );
    fixture.resets.recv().await.unwrap();
    let is_banner = |entry: &Value| entry["direction"] == "rx" && entry["text"] == "ELM327 v1.5";
    let reader_traffic = |entries: Vec<Value>, after: u64| -> Vec<Value> {
        let reader: Vec<Value> = entries
            .into_iter()
            .filter(|entry| {
                entry["channel"] == "reader" && entry["sequence"].as_u64() > Some(after)
            })
            .collect();
        reader[reader.len().saturating_sub(2)..].to_vec()
    };
    let unfinished = reader_traffic(c.traffic_until(is_banner).await, 0);
    assert_eq!(
        unfinished,
        traffic("reader", &[(182, "tx", "ATZ"), (183, "rx", "ELM327 v1.5")])
    );

    let abandoned = c.request("reader.connect", json!({ "target": target }));
    fixture.resets.recv().await.unwrap();
    c.interrupt(abandoned).await;
    let mut state = initial_reader_state();
    merge(
        &mut state,
        json!({
            "watching": ["010C", "010D", "0105", "0142"],
            "polling": { "paused": true, "interval": 1000 }
        }),
    );
    assert_eq!(c.head("reader.subscribeState").await, state);
    let last = unfinished[1]["sequence"].as_u64().unwrap();
    let banner_after_last =
        move |entry: &Value| is_banner(entry) && entry["sequence"].as_u64() > Some(last);
    let abandoned_traffic = reader_traffic(c.traffic_until(banner_after_last).await, last);
    assert_eq!(
        abandoned_traffic,
        traffic("reader", &[(219, "tx", "ATZ"), (220, "rx", "ELM327 v1.5")])
    );
}

/// Image checks, update errors, vendor imports, a simulated update that outlives its caller, the
/// emulator after it, and the update a stopping server refuses.
async fn firmware(fixture: &mut Fixture, mut state: Value) {
    let missing_port = fixture.port(MISSING_PORT);
    let data_dir = fixture.data_dir.path().to_path_buf();
    let c = &mut fixture.client;
    let image = hex_file(APPLICATION_BASE, &application());
    let image_error = |reason: &str, line: Value| {
        fail(json!({ "_tag": "FirmwareImageError", "reason": reason, "line": line }))
    };
    assert_eq!(
        c.call("firmware.inspect", json!({ "image": image })).await,
        ok(json!({ "start": 134_232_064, "end": 134_234_564, "bytes": 2500 }))
    );
    assert_eq!(
        c.call("firmware.inspect", json!({ "image": "hello" }))
            .await,
        image_error("unreadable", json!(1))
    );
    assert_eq!(
        c.call(
            "firmware.inspect",
            json!({ "image": format!("{}\n:zz", &image[..40]) }),
        )
        .await,
        image_error("unreadable", json!(2))
    );
    assert_eq!(
        c.call(
            "firmware.inspect",
            json!({ "image": hex_file(FLASH_BASE, &application()) }),
        )
        .await,
        image_error("outsideApplication", Value::Null)
    );

    let simulated = json!({ "_tag": "simulated" });
    let file = json!({ "_tag": "file", "text": image });
    let update_error =
        |reason: &str| fail(json!({ "_tag": "FirmwareUpdateError", "reason": reason }));
    assert_eq!(
        c.call(
            "firmware.update",
            json!({
                "target": simulated,
                "image": { "_tag": "library", "name": "Firmware_MK2_20990101.hex" }
            }),
        )
        .await,
        image_error("notInLibrary", Value::Null)
    );
    assert_eq!(
        c.call(
            "firmware.update",
            json!({ "target": simulated, "image": file })
        )
        .await,
        update_error("noKey")
    );
    assert_eq!(
        c.call(
            "firmware.update",
            json!({
                "target": { "_tag": "serial", "path": missing_port },
                "image": file,
                "wireKey": TEST_KEY
            }),
        )
        .await,
        update_error("wrongKey")
    );

    let vendor_file = |name: &str, text: &str| {
        serde_json::to_value(VendorFile {
            name: name.to_owned(),
            bytes: text.as_bytes().to_vec(),
        })
        .unwrap()
    };
    let no_key = fail(json!({ "_tag": "VendorImportError", "reason": "noKey" }));
    assert_eq!(
        c.call(
            "firmware.importVendorFiles",
            json!({
                "files": [
                    vendor_file("readme.txt", "not the vendor tool"),
                    vendor_file("Firmware_MK2_20250311.hex", &image)
                ]
            }),
        )
        .await,
        no_key
    );
    assert_eq!(
        c.call("firmware.importVendorFiles", json!({ "files": [] }))
            .await,
        no_key
    );
    assert_eq!(
        c.call("firmware.forgetWireKey", Value::Null).await,
        ok(Value::Null)
    );
    assert_eq!(
        c.head("firmware.subscribeWireKey").await,
        json!({ "_tag": "absent" })
    );
    assert_eq!(c.head("firmware.subscribeLibrary").await, json!([]));

    let progress = c.request("firmware.subscribeUpdate", Value::Null);
    assert_eq!(c.chunk(progress).await, vec![json!({ "_tag": "idle" })]);
    let update = json!({
        "target": simulated,
        "image": file,
        "wireKey": TEST_KEY,
        "confirmTooOld": true
    });
    let flashing = c.request("firmware.update", update.clone());
    let running = c
        .chunk_where(progress, |state| state["_tag"] == "running")
        .await;
    assert_eq!(running["_tag"], "running");
    assert_eq!(
        c.call("firmware.update", update).await,
        update_error("busy")
    );
    assert_eq!(
        c.call("emulator.connect", json!({ "target": simulated }))
            .await,
        fail(json!({
            "_tag": "EmulatorConnectError",
            "target": simulated,
            "reason": "update-running"
        }))
    );
    c.interrupt(flashing).await;
    let update = json!({ "target": simulated, "image": file, "wireKey": TEST_KEY });
    let finished = c
        .chunk_where(progress, |state| {
            state["_tag"] == "succeeded" || state["_tag"] == "failed"
        })
        .await;
    assert_eq!(
        finished,
        json!({ "_tag": "succeeded", "target": simulated, "bytes": 2500, "version": null })
    );
    c.interrupt(progress).await;

    state["connection"] = json!({ "_tag": "disconnected" });
    assert_eq!(c.head("emulator.subscribeState").await, state);
    assert_eq!(
        c.call("emulator.connect", json!({ "target": simulated }))
            .await,
        ok(Value::Null)
    );
    state["connection"] = connected_to_the_simulator();
    assert_eq!(c.head("emulator.subscribeState").await, state);
    assert_eq!(
        c.call("emulator.clearDtcs", json!({})).await,
        ok(Value::Null)
    );
    assert_eq!(
        c.call("emulator.disconnect", Value::Null).await,
        ok(Value::Null)
    );
    state["connection"] = json!({ "_tag": "disconnected" });
    merge(&mut state, json!({ "dtcs": { "03": [], "07": [] } }));
    assert_eq!(c.head("emulator.subscribeState").await, state);

    let presets = std::fs::read_to_string(data_dir.join("presets.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&presets).unwrap(),
        json!({ "version": 1, "presets": [] })
    );

    assert!(fixture.updater.shut_down().await);
    assert_eq!(
        fixture.client.call("firmware.update", update).await,
        update_error("shuttingDown")
    );
}
