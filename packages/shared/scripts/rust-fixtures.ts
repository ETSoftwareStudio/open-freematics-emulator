/**
 * Encodes sample values with the real contract schemas, the way Effect RPC puts them on the
 * wire, into JSON fixtures the Rust wire types must round-trip unchanged.
 * Usage: vp run rs:fixtures
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain build-time script.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { RpcSchema } from "effect/rpc";
import {
  CalibrationId,
  ConnectTarget,
  Connection,
  DeviceCapabilities,
  DeviceInfo,
  DtcCode,
  DtcMode,
  EmulatorCommandError,
  EmulatorConnectError,
  EmulatorNotConnectedError,
  EmulatorOperationError,
  EmulatorState,
  FirmwareImageError,
  FirmwareImageSource,
  FirmwareImageSummary,
  FirmwareUpdateError,
  FirmwareUpdateInput,
  FirmwareUpdateStage,
  FirmwareUpdateState,
  ImportVendorFilesInput,
  ImportWireKeyInput,
  InspectFirmwareInput,
  LibraryImage,
  ObdProtocol,
  PidId,
  PidReading,
  PollInterval,
  PollingSettings,
  Preset,
  PresetChangeError,
  PresetId,
  PresetNotFoundError,
  PresetPersistError,
  PresetReadOnlyError,
  PresetRef,
  ReaderCommandError,
  ReaderConnectError,
  ReaderConnection,
  ReaderNotConnectedError,
  ReaderOperationError,
  ReaderState,
  ReaderTarget,
  ReadinessMonitor,
  ReadinessMonitorId,
  SavePresetInput,
  SendRawInput,
  SendRawResult,
  SerialPortInfo,
  SerialPortListError,
  SetCalibrationIdInput,
  SetDtcsInput,
  SetPidInput,
  SetReadinessInput,
  SetVinInput,
  TrafficEntry,
  UnsentEdit,
  Vin,
  VendorDownloadError,
  VendorImportError,
  VendorImportResult,
  WS_METHODS,
  WireKeyError,
  WireKeyStatus,
  WsRpcGroup,
} from "@fme/contracts";
import { makeDefaultState } from "../src/defaultState.ts";

const outDir = NodePath.join(import.meta.dirname, "../../../crates/fme-core/tests/fixtures");

// RPC schemas are typed `Schema.Top`; every contract schema encodes without services.
const encodeAll = (schema: Schema.Top, values: ReadonlyArray<unknown>) => {
  // oxlint-disable-next-line fme/no-inline-schema-compile -- one encoder per fixture schema, built once.
  const encode = Schema.encodeUnknownSync(
    Schema.toCodecJson(schema as Schema.Codec<unknown, unknown, unknown, never>),
  );
  return values.map((value) => encode(value));
};

const pid = (id: string) => id as PidId;
const dtc = (code: string) => code as DtcCode;
const presetId = (id: string) => id as PresetId;

const serial: ConnectTarget = { _tag: "serial", path: "/dev/cu.usbserial-0001" };
const simulated: ConnectTarget = { _tag: "simulated" };
const tcp: ReaderTarget = { _tag: "tcp", host: "192.168.0.10", port: 35000 };

const defaultState = makeDefaultState();
const busyState: EmulatorState = {
  ...defaultState,
  connection: {
    _tag: "connected",
    target: serial,
    device: {
      banner: "OBD-II EMULATOR V1.2",
      details: "00.00.02,00.01.05,201910,GH201910BN05928,1HGCD5654VA061985",
    },
    unsent: [
      { _tag: "dtcs", mode: "07", codes: [dtc("P0420")] },
      { _tag: "calibrationId", calibrationId: "JMB*36761500" },
    ],
  },
  capabilities: { dtcModes: ["03"], calibrationId: false },
  ignition: false,
  protocol: "J1850_VPW",
  vinEnabled: false,
  vin: "1HGCD5654VA061985",
  calibrationId: "JMB*36761500",
  dtcs: { "03": [dtc("P0105"), dtc("P0300")], "07": [dtc("U0100")], "0A": [] },
  pids: { ...defaultState.pids, [pid("0142")]: 14.2, [pid("0110")]: 80.25, [pid("010E")]: -64 },
  readiness: {
    ...defaultState.readiness,
    misfire: { supported: true, complete: false },
    egrSystem: { supported: false, complete: false },
  },
  lastPreset: { id: presetId("builtin:cruise"), name: "Cruise" },
};
// Plain `Schema.Number` encodes non-finite values as strings.
const nonFiniteState: EmulatorState = {
  ...defaultState,
  connection: { _tag: "failed", target: simulated, reason: "Port busy" },
  pids: { [pid("010C")]: Number.NaN, [pid("010D")]: Number.POSITIVE_INFINITY },
};

const readerDefault: ReaderState = {
  connection: { _tag: "disconnected" },
  watching: [],
  polling: { paused: false, interval: 500 },
  pollRate: 0,
  readings: {},
  unanswered: [],
  vehicleResponding: false,
  voltage: null,
  dtcs: null,
  dtcsAt: null,
  monitorStatus: null,
  vin: null,
};
const readerBusy: ReaderState = {
  connection: { _tag: "connected", target: tcp, adapter: "ELM327 v1.5", protocol: "A6" },
  watching: [pid("010C"), pid("010D"), pid("0105")],
  polling: { paused: true, interval: 2000 },
  pollRate: 12,
  readings: {
    [pid("010C")]: { value: 2000, raw: [0x1f, 0x40], at: 1_762_600_000_123 },
    [pid("010D")]: { value: 72.5, raw: [72], at: 1_762_600_000_456 },
  },
  unanswered: [pid("0105")],
  vehicleResponding: true,
  voltage: 12.4,
  dtcs: ["P0105", "C0123"],
  dtcsAt: 1_762_600_001_000,
  monitorStatus: [0x82, 0x07, 0xff, 0x00],
  vin: "1HGCD5654VA061985",
};

const cruise: Preset = {
  id: presetId("builtin:cruise"),
  name: "Cruise",
  builtIn: true,
  pids: { [pid("010C")]: 2350, [pid("010D")]: 72, [pid("0110")]: 14.5 },
};
const userPreset: Preset = {
  id: presetId("user:0f8b2c1e-7d4a-4f0e-9a51-3b1c2d4e5f60"),
  name: "Cold start",
  builtIn: false,
  pids: { [pid("0105")]: -20, [pid("010C")]: 1400 },
};

const libraryImage: LibraryImage = {
  name: "Firmware_MK2_20250311.hex",
  version: "1.3",
  released: "2025-03-11",
  start: 0x0800_3800,
  end: 0x0801_9a40,
  bytes: 90_688,
};

const notConnected = new EmulatorNotConnectedError();
const commandErrors = (["rejected", "timeout", "link"] as const).map(
  (reason) => new EmulatorCommandError({ command: "ATSET 010C=0x1F,0x40", reason }),
);
const presetNotFound = new PresetNotFoundError({ id: presetId("user:gone") });
const presetChangeErrors = [
  presetNotFound,
  new PresetReadOnlyError({ id: presetId("builtin:idle"), operation: "save" }),
  new PresetReadOnlyError({ id: presetId("builtin:idle"), operation: "delete" }),
  new PresetPersistError({ path: "/data/presets.json", cause: new Error("EACCES") }),
  new PresetPersistError({ path: "/data/presets.json", cause: { code: "ENOSPC", errno: -28 } }),
];
const firmwareImageErrors = [
  new FirmwareImageError({ reason: "unreadable", line: null }),
  new FirmwareImageError({ reason: "unreadable", line: 12 }),
  new FirmwareImageError({ reason: "outsideApplication", line: null }),
  new FirmwareImageError({ reason: "notInLibrary", line: null }),
];
const firmwareUpdateErrors = FirmwareUpdateError.fields.reason.literals.map(
  (reason) => new FirmwareUpdateError({ reason }),
);
const vendorDownloadErrors = VendorDownloadError.fields.reason.literals.map(
  (reason) => new VendorDownloadError({ reason }),
);
const vendorImportErrors = VendorImportError.fields.reason.literals.map(
  (reason) => new VendorImportError({ reason }),
);
const readerNotConnected = new ReaderNotConnectedError();
const readerCommandErrors = ReaderCommandError.fields.reason.literals.map(
  (reason) => new ReaderCommandError({ command: "0105", reason }),
);
const vendorFile = { name: "FirmwareUpdater.exe", bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) };
const hexImage = ":020000040800F2\n:00000001FF\n";

const types: Record<string, readonly [Schema.Top, ReadonlyArray<unknown>]> = {
  PidId: [PidId, [pid("010C"), pid("014D")]],
  DtcCode: [DtcCode, [dtc("P0105"), dtc("U3FFF")]],
  Vin: [Vin, ["1HGCD5654VA061985"]],
  CalibrationId: [CalibrationId, ["JMB*36761500", " "]],
  PresetId: [PresetId, [cruise.id, userPreset.id]],
  ObdProtocol: [ObdProtocol, ObdProtocol.literals],
  DtcMode: [DtcMode, DtcMode.literals],
  ReadinessMonitorId: [ReadinessMonitorId, ReadinessMonitorId.literals],
  ReadinessMonitor: [ReadinessMonitor, [{ supported: true, complete: false }]],
  ConnectTarget: [ConnectTarget, [serial, simulated]],
  SerialPortInfo: [
    SerialPortInfo,
    [
      {
        path: "/dev/cu.usbserial-0001",
        manufacturer: "Silicon Labs",
        vendorId: "10c4",
        productId: "ea60",
        transport: "usb",
        likelyEmulator: true,
      },
      { path: "/dev/cu.OBDII", transport: "bluetooth", likelyEmulator: false },
      { path: "COM3", manufacturer: "Microsoft", transport: "other", likelyEmulator: false },
    ],
  ],
  DeviceInfo: [DeviceInfo, [{ banner: "OBD-II EMULATOR V1.3", details: null }]],
  DeviceCapabilities: [
    DeviceCapabilities,
    [
      { dtcModes: ["03"], calibrationId: false },
      { dtcModes: ["03", "07", "0A"], calibrationId: true },
    ],
  ],
  UnsentEdit: [
    UnsentEdit,
    busyState.connection._tag === "connected" ? busyState.connection.unsent : [],
  ],
  Connection: [
    Connection,
    [
      { _tag: "disconnected" },
      { _tag: "connecting", target: simulated },
      busyState.connection,
      { _tag: "connected", target: simulated, device: null, unsent: [] },
      { _tag: "failed", target: serial, reason: "The device did not answer." },
    ],
  ],
  EmulatorState: [EmulatorState, [defaultState, busyState, nonFiniteState]],
  TrafficEntry: [
    TrafficEntry,
    [
      { sequence: 1, channel: "emulator", at: 1_762_600_000_000, direction: "tx", text: "ATZ" },
      {
        sequence: 2,
        channel: "reader",
        at: 1_762_600_000_017,
        direction: "rx",
        text: "41 0C 1F 40",
      },
    ],
  ],
  SetPidInput: [
    SetPidInput,
    [
      { pid: pid("0142"), value: 14.2 },
      { pid: pid("010C"), value: 2000 },
    ],
  ],
  SetDtcsInput: [SetDtcsInput, [{ mode: "0A", codes: [dtc("P0420"), dtc("B1234")] }]],
  SetReadinessInput: [
    SetReadinessInput,
    [{ monitor: "oxygenSensorHeater", supported: true, complete: false }],
  ],
  SetVinInput: [SetVinInput, [{ vin: "1HGCD5654VA061985" }]],
  SetCalibrationIdInput: [SetCalibrationIdInput, [{ calibrationId: "JMB*36761500" }]],
  SendRawInput: [SendRawInput, [{ command: "ATGET 010C" }, { command: "atz" }]],
  SendRawResult: [SendRawResult, [{ lines: ["0x1F,0x40", "OK"] }, { lines: [] }]],
  EmulatorNotConnectedError: [EmulatorNotConnectedError, [notConnected]],
  EmulatorCommandError: [EmulatorCommandError, commandErrors],
  EmulatorConnectError: [
    EmulatorConnectError,
    EmulatorConnectError.fields.reason.literals.map(
      (reason) => new EmulatorConnectError({ target: serial, reason }),
    ),
  ],
  SerialPortListError: [SerialPortListError, [new SerialPortListError()]],
  EmulatorOperationError: [EmulatorOperationError, [notConnected, ...commandErrors]],

  FirmwareUpdateStage: [FirmwareUpdateStage, FirmwareUpdateStage.literals],
  FirmwareUpdateState: [
    FirmwareUpdateState,
    [
      { _tag: "idle" },
      { _tag: "running", target: serial, stage: "writing", written: 40_960, total: 90_688 },
      { _tag: "succeeded", target: serial, bytes: 90_688, version: "1.3" },
      { _tag: "succeeded", target: simulated, bytes: 90_688, version: null },
      {
        _tag: "failed",
        target: serial,
        stage: "erasing",
        reason: "The bootloader stopped answering.",
        applicationErased: true,
      },
    ],
  ],
  InspectFirmwareInput: [InspectFirmwareInput, [{ image: hexImage }]],
  FirmwareImageSummary: [
    FirmwareImageSummary,
    [{ start: libraryImage.start, end: libraryImage.end, bytes: libraryImage.bytes }],
  ],
  FirmwareImageSource: [
    FirmwareImageSource,
    [
      { _tag: "file", text: hexImage },
      { _tag: "library", name: libraryImage.name },
    ],
  ],
  FirmwareUpdateInput: [
    FirmwareUpdateInput,
    [
      { target: serial, image: { _tag: "library", name: libraryImage.name } },
      {
        target: simulated,
        image: { _tag: "file", text: hexImage },
        wireKey: "00112233445566778899aabbccddeeff",
      },
      {
        target: serial,
        image: { _tag: "library", name: libraryImage.name },
        confirmTooOld: true,
      },
    ],
  ],
  FirmwareImageError: [FirmwareImageError, firmwareImageErrors],
  FirmwareUpdateError: [FirmwareUpdateError, firmwareUpdateErrors],
  ImportWireKeyInput: [
    ImportWireKeyInput,
    [{ binary: vendorFile.bytes }, { binary: new Uint8Array([0xff, 0xfe]) }],
  ],
  WireKeyStatus: [
    WireKeyStatus,
    [{ _tag: "absent" }, { _tag: "present", fingerprint: "9f86d081" }],
  ],
  WireKeyError: [
    WireKeyError,
    WireKeyError.fields.reason.literals.map((reason) => new WireKeyError({ reason })),
  ],
  LibraryImage: [LibraryImage, [libraryImage, { ...libraryImage, version: null, released: null }]],
  ImportVendorFilesInput: [
    ImportVendorFilesInput,
    [{ files: [vendorFile, { name: "Firmware_MK2_20250311.hex", bytes: new Uint8Array() }] }],
  ],
  VendorImportResult: [VendorImportResult, [{ keyFound: true, imagesAdded: 3 }]],
  VendorDownloadError: [VendorDownloadError, vendorDownloadErrors],
  VendorImportError: [VendorImportError, vendorImportErrors],

  Preset: [Preset, [cruise, userPreset]],
  PresetRef: [PresetRef, [{ id: cruise.id, name: "Cruise" }]],
  SavePresetInput: [
    SavePresetInput,
    [
      { name: "Cold start", pids: userPreset.pids },
      { id: userPreset.id, name: "Warm", pids: {} },
    ],
  ],
  PresetNotFoundError: [PresetNotFoundError, [presetNotFound]],
  PresetReadOnlyError: [PresetReadOnlyError, presetChangeErrors.slice(1, 3)],
  PresetPersistError: [PresetPersistError, presetChangeErrors.slice(3)],
  PresetChangeError: [PresetChangeError, presetChangeErrors],

  ReaderTarget: [
    ReaderTarget,
    [{ _tag: "serial", path: "/dev/cu.OBDII" }, tcp, { _tag: "simulated" }],
  ],
  ReaderConnection: [
    ReaderConnection,
    [
      { _tag: "disconnected" },
      { _tag: "connecting", target: tcp },
      readerBusy.connection,
      { _tag: "connected", target: { _tag: "simulated" }, adapter: "ELM327 v2.1", protocol: null },
      { _tag: "failed", target: tcp, reason: "Connection refused" },
    ],
  ],
  PidReading: [
    PidReading,
    [
      { value: 14.2, raw: [0x37, 0x78], at: 1_762_600_000_000 },
      { value: Number.NaN, raw: [], at: 0 },
    ],
  ],
  PollInterval: [PollInterval, PollInterval.literals],
  PollingSettings: [PollingSettings, [{ paused: false, interval: 250 }]],
  ReaderState: [ReaderState, [readerDefault, readerBusy]],
  ReaderNotConnectedError: [ReaderNotConnectedError, [readerNotConnected]],
  ReaderCommandError: [ReaderCommandError, readerCommandErrors],
  ReaderConnectError: [
    ReaderConnectError,
    ReaderConnectError.fields.reason.literals.map(
      (reason) => new ReaderConnectError({ target: tcp, reason }),
    ),
  ],
  ReaderOperationError: [ReaderOperationError, [readerNotConnected, ...readerCommandErrors]],
};

interface RpcSamples {
  readonly payload: ReadonlyArray<unknown>;
  readonly success: ReadonlyArray<unknown>;
  readonly error: ReadonlyArray<unknown>;
}

const none: RpcSamples = { payload: [undefined], success: [undefined], error: [] };
const operation = (payload: ReadonlyArray<unknown>): RpcSamples => ({
  payload,
  success: [undefined],
  error: [notConnected, ...commandErrors],
});
const readerOperation: RpcSamples = {
  ...none,
  error: [readerNotConnected, ...readerCommandErrors],
};

const rpcs: Record<string, RpcSamples> = {
  [WS_METHODS.listPorts]: {
    payload: [undefined],
    success: [types.SerialPortInfo![1], []],
    error: [new SerialPortListError()],
  },
  [WS_METHODS.connect]: {
    payload: [{ target: serial }, { target: simulated }],
    success: [undefined],
    error: types.EmulatorConnectError![1],
  },
  [WS_METHODS.disconnect]: none,
  [WS_METHODS.setIgnition]: operation([{ on: true }, { on: false }]),
  [WS_METHODS.setProtocol]: operation([{ protocol: "ISO9141_2" }]),
  [WS_METHODS.setVinEnabled]: operation([{ enabled: true }]),
  [WS_METHODS.setVin]: operation(types.SetVinInput![1]),
  [WS_METHODS.setCalibrationId]: operation(types.SetCalibrationIdInput![1]),
  [WS_METHODS.setPid]: operation(types.SetPidInput![1]),
  [WS_METHODS.setDtcs]: operation([...types.SetDtcsInput![1], { mode: "03", codes: [] }]),
  [WS_METHODS.clearDtcs]: operation([{}]),
  [WS_METHODS.setReadiness]: operation(types.SetReadinessInput![1]),
  [WS_METHODS.sendRaw]: {
    payload: types.SendRawInput![1],
    success: types.SendRawResult![1],
    error: [notConnected, ...commandErrors],
  },
  [WS_METHODS.subscribeState]: { ...none, success: types.EmulatorState![1] },
  [WS_METHODS.subscribeTraffic]: { ...none, success: types.TrafficEntry![1] },
  [WS_METHODS.readerConnect]: {
    payload: [{ target: tcp }, { target: { _tag: "simulated" } }],
    success: [undefined],
    error: types.ReaderConnectError![1],
  },
  [WS_METHODS.readerDisconnect]: none,
  [WS_METHODS.readerWatch]: {
    ...none,
    payload: [{ pids: [pid("010C"), pid("0105")] }, { pids: [] }],
  },
  [WS_METHODS.readerReadDtcs]: readerOperation,
  [WS_METHODS.readerReadVin]: readerOperation,
  [WS_METHODS.readerClearDtcs]: readerOperation,
  [WS_METHODS.readerSetPolling]: { ...none, payload: types.PollingSettings![1] },
  [WS_METHODS.readerReadOnce]: readerOperation,
  [WS_METHODS.readerSubscribeState]: { ...none, success: types.ReaderState![1] },
  [WS_METHODS.subscribePresets]: { ...none, success: [[cruise, userPreset], []] },
  [WS_METHODS.applyPreset]: {
    payload: [{ id: cruise.id }],
    success: [undefined],
    error: [presetNotFound, notConnected, ...commandErrors],
  },
  [WS_METHODS.savePreset]: {
    payload: types.SavePresetInput![1],
    success: [userPreset],
    error: presetChangeErrors,
  },
  [WS_METHODS.deletePreset]: {
    payload: [{ id: userPreset.id }],
    success: [undefined],
    error: presetChangeErrors,
  },
  [WS_METHODS.inspectFirmware]: {
    payload: types.InspectFirmwareInput![1],
    success: types.FirmwareImageSummary![1],
    error: firmwareImageErrors,
  },
  [WS_METHODS.updateFirmware]: {
    payload: types.FirmwareUpdateInput![1],
    success: [undefined],
    error: [...firmwareImageErrors, ...firmwareUpdateErrors],
  },
  [WS_METHODS.subscribeFirmwareUpdate]: { ...none, success: types.FirmwareUpdateState![1] },
  [WS_METHODS.subscribeWireKey]: { ...none, success: types.WireKeyStatus![1] },
  [WS_METHODS.importVendorFiles]: {
    payload: types.ImportVendorFilesInput![1],
    success: types.VendorImportResult![1],
    error: vendorImportErrors,
  },
  [WS_METHODS.downloadVendorFirmware]: {
    payload: [undefined],
    success: types.VendorImportResult![1],
    error: [...vendorDownloadErrors, ...vendorImportErrors],
  },
  [WS_METHODS.subscribeFirmwareLibrary]: { ...none, success: [[libraryImage], []] },
  [WS_METHODS.forgetWireKey]: { ...none, error: types.WireKeyError![1] },
};

const write = (file: string, data: unknown) => {
  const path = NodePath.join(outDir, file);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};

NodeFS.rmSync(outDir, { recursive: true, force: true });

for (const [name, [schema, values]] of Object.entries(types)) {
  write(`types/${name}.json`, encodeAll(schema, values));
}

for (const [tag, rpc] of WsRpcGroup.requests) {
  const samples = rpcs[tag];
  if (samples === undefined) throw new Error(`No fixture samples for the ${tag} RPC.`);
  const success = RpcSchema.isStreamSchema(rpc.successSchema)
    ? rpc.successSchema.success
    : rpc.successSchema;
  write(`rpc/${tag}.json`, {
    payload: encodeAll(rpc.payloadSchema, samples.payload),
    success: encodeAll(success, samples.success),
    error: encodeAll(rpc.errorSchema, samples.error),
  });
}

console.log(
  `Wrote ${Object.keys(types).length} type and ${WsRpcGroup.requests.size} RPC fixtures.`,
);
