import * as Schema from "effect/Schema";
import { CalibrationId, DtcCode, PidId, Vin } from "./baseSchemas.ts";
import { PresetRef } from "./presets.ts";

export const ObdProtocol = Schema.Literals([
  "CAN_11B_500K",
  "CAN_11B_250K",
  "CAN_29B_500K",
  "CAN_29B_250K",
  "ISO9141_2",
  "KWP2000_FAST",
  "KWP2000_5BPS",
  "J1850_PWM",
  "J1850_VPW",
  "J1939",
]);
export type ObdProtocol = typeof ObdProtocol.Type;

/** Service modes that report trouble codes: stored (03), pending (07), permanent (0A). */
export const DtcMode = Schema.Literals(["03", "07", "0A"]);
export type DtcMode = typeof DtcMode.Type;

export const MAX_DTCS_PER_MODE = 6;

export const DtcList = Schema.Array(DtcCode).check(Schema.isMaxLength(MAX_DTCS_PER_MODE));

export const ReadinessMonitorId = Schema.Literals([
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
]);
export type ReadinessMonitorId = typeof ReadinessMonitorId.Type;

export const ReadinessMonitor = Schema.Struct({
  supported: Schema.Boolean,
  complete: Schema.Boolean,
});
export type ReadinessMonitor = typeof ReadinessMonitor.Type;

export const ConnectTarget = Schema.Union([
  Schema.TaggedStruct("serial", { path: Schema.NonEmptyString }),
  Schema.TaggedStruct("simulated", {}),
]);
export type ConnectTarget = typeof ConnectTarget.Type;

export const SerialPortInfo = Schema.Struct({
  path: Schema.String,
  manufacturer: Schema.optional(Schema.String),
  vendorId: Schema.optional(Schema.String),
  productId: Schema.optional(Schema.String),
  transport: Schema.Literals(["usb", "bluetooth", "other"]),
  /** USB VID/PID matches a bridge the MK2 ships with (CP2102 or CH340). */
  likelyEmulator: Schema.Boolean,
});
export type SerialPortInfo = typeof SerialPortInfo.Type;

/** What the firmware prints on reset: `OBD-II EMULATOR V1.2` and a comma-separated info line. */
export const DeviceInfo = Schema.Struct({
  banner: Schema.String,
  details: Schema.NullOr(Schema.String),
});
export type DeviceInfo = typeof DeviceInfo.Type;

/** What the connected firmware accepts, probed on connect. V1.2 takes Mode 03 codes only. */
export const DeviceCapabilities = Schema.Struct({
  dtcModes: Schema.Array(DtcMode),
  calibrationId: Schema.Boolean,
});
export type DeviceCapabilities = typeof DeviceCapabilities.Type;

/** An edit staged while disconnected that the firmware can't take, so connect didn't send it. */
export const UnsentEdit = Schema.Union([
  Schema.TaggedStruct("dtcs", { mode: DtcMode, codes: DtcList }),
  Schema.TaggedStruct("calibrationId", { calibrationId: Schema.String }),
]);
export type UnsentEdit = typeof UnsentEdit.Type;

export const Connection = Schema.Union([
  Schema.TaggedStruct("disconnected", {}),
  Schema.TaggedStruct("connecting", { target: ConnectTarget }),
  Schema.TaggedStruct("connected", {
    target: ConnectTarget,
    device: Schema.NullOr(DeviceInfo),
    unsent: Schema.Array(UnsentEdit),
  }),
  Schema.TaggedStruct("failed", { target: ConnectTarget, reason: Schema.String }),
]);
export type Connection = typeof Connection.Type;

/**
 * Everything the server believes is configured on the device. Values are the
 * last ones the device acknowledged; the firmware cannot report most of them back.
 */
export const EmulatorState = Schema.Struct({
  connection: Connection,
  /** What the firmware took on the last connect; kept after disconnect, null before the first. */
  capabilities: Schema.NullOr(DeviceCapabilities),
  ignition: Schema.Boolean,
  protocol: ObdProtocol,
  vinEnabled: Schema.Boolean,
  /** Read from the device on connect; the firmware keeps it across resets. */
  vin: Schema.NullOr(Schema.String),
  calibrationId: Schema.NullOr(Schema.String),
  dtcs: Schema.Struct({ "03": DtcList, "07": DtcList, "0A": DtcList }),
  pids: Schema.Record(PidId, Schema.Number),
  readiness: Schema.Record(ReadinessMonitorId, ReadinessMonitor),
  /** Kept when PIDs are edited afterwards; compare against the preset to show the edits. */
  lastPreset: Schema.NullOr(PresetRef),
});
export type EmulatorState = typeof EmulatorState.Type;

export const TrafficEntry = Schema.Struct({
  sequence: Schema.Number,
  /** The emulator's control port, or the OBD-II adapter reading it. */
  channel: Schema.Literals(["emulator", "reader"]),
  at: Schema.Number,
  direction: Schema.Literals(["tx", "rx"]),
  text: Schema.String,
});
export type TrafficEntry = typeof TrafficEntry.Type;

export const SetPidInput = Schema.Struct({ pid: PidId, value: Schema.Finite });
export const SetDtcsInput = Schema.Struct({ mode: DtcMode, codes: DtcList });
export const SetReadinessInput = Schema.Struct({
  monitor: ReadinessMonitorId,
  supported: Schema.Boolean,
  complete: Schema.Boolean,
});
export const SetVinInput = Schema.Struct({ vin: Vin });
export const SetCalibrationIdInput = Schema.Struct({ calibrationId: CalibrationId });
export const SendRawInput = Schema.Struct({
  command: Schema.String.check(Schema.isPattern(/^AT[\x20-\x7E]*$/i)),
});
export const SendRawResult = Schema.Struct({ lines: Schema.Array(Schema.String) });

export class EmulatorNotConnectedError extends Schema.TaggedError<EmulatorNotConnectedError>()(
  "EmulatorNotConnectedError",
  {},
) {
  override get message(): string {
    return "The emulator is not connected.";
  }
}

export class EmulatorCommandError extends Schema.TaggedError<EmulatorCommandError>()(
  "EmulatorCommandError",
  {
    command: Schema.String,
    reason: Schema.Literals(["rejected", "timeout", "link"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rejected":
        return `The emulator rejected ${this.command}.`;
      case "timeout":
        return `The emulator did not answer ${this.command} in time.`;
      case "link":
        return `The connection to the emulator failed while sending ${this.command}.`;
    }
  }
}

export class EmulatorConnectError extends Schema.TaggedError<EmulatorConnectError>()(
  "EmulatorConnectError",
  {
    target: ConnectTarget,
    reason: Schema.Literals(["open-failed", "no-handshake", "setup-failed", "link-lost"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "open-failed":
        return "Could not open the serial port.";
      case "no-handshake":
        return "The device did not answer like a Freematics emulator.";
      case "setup-failed":
        return "The emulator rejected its initial configuration.";
      case "link-lost":
        return "The connection to the emulator dropped while connecting.";
    }
  }
}

export class SerialPortListError extends Schema.TaggedError<SerialPortListError>()(
  "SerialPortListError",
  {},
) {
  override get message(): string {
    return "Could not list serial ports.";
  }
}

export const EmulatorOperationError = Schema.Union([
  EmulatorNotConnectedError,
  EmulatorCommandError,
]);
export type EmulatorOperationError = typeof EmulatorOperationError.Type;
