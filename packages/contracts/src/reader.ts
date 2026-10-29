import * as Schema from "effect/Schema";
import { PidId } from "./baseSchemas.ts";

/** Where the OBD-II adapter (ELM327-compatible) plugged into the emulator is reachable. */
export const ReaderTarget = Schema.Union([
  /** Bluetooth SPP or USB adapters show up as serial ports. */
  Schema.TaggedStruct("serial", { path: Schema.NonEmptyString }),
  /** Wi-Fi adapters, usually 192.168.0.10:35000. */
  Schema.TaggedStruct("tcp", {
    host: Schema.NonEmptyString,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  /** A simulated adapter reading the simulated emulator. */
  Schema.TaggedStruct("simulated", {}),
]);
export type ReaderTarget = typeof ReaderTarget.Type;

export const ReaderConnection = Schema.Union([
  Schema.TaggedStruct("disconnected", {}),
  Schema.TaggedStruct("connecting", { target: ReaderTarget }),
  Schema.TaggedStruct("connected", {
    target: ReaderTarget,
    adapter: Schema.String,
    /** ATDPN, e.g. `A6`; null until the vehicle side answers. */
    protocol: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("failed", { target: ReaderTarget, reason: Schema.String }),
]);
export type ReaderConnection = typeof ReaderConnection.Type;

export const PidReading = Schema.Struct({
  value: Schema.Number,
  raw: Schema.Array(Schema.Number),
  at: Schema.Number,
});
export type PidReading = typeof PidReading.Type;

/** How often each watched PID is read, in milliseconds. */
export const PollInterval = Schema.Literals([250, 500, 1000, 2000]);
export type PollInterval = typeof PollInterval.Type;

export const PollingSettings = Schema.Struct({
  paused: Schema.Boolean,
  interval: PollInterval,
});
export type PollingSettings = typeof PollingSettings.Type;

export const ReaderState = Schema.Struct({
  connection: ReaderConnection,
  /** PIDs polled continuously while connected. */
  watching: Schema.Array(PidId),
  polling: PollingSettings,
  /** Requests per second over the last poll cycle; 0 while paused or idle. */
  pollRate: Schema.Number,
  readings: Schema.Record(PidId, PidReading),
  /** Watched PIDs whose last poll got no answer (`NO DATA`) from the vehicle side. */
  unanswered: Schema.Array(PidId),
  /** Whether the last poll got an answer from the vehicle side. */
  vehicleResponding: Schema.Boolean,
  /** Supply voltage the adapter measures on the OBD port (`ATRV`). */
  voltage: Schema.NullOr(Schema.Number),
  dtcs: Schema.NullOr(Schema.Array(Schema.String)),
  /** When the codes were last read, with PID 0101 (MIL and readiness) read alongside. */
  dtcsAt: Schema.NullOr(Schema.Number),
  monitorStatus: Schema.NullOr(Schema.Array(Schema.Number)),
  vin: Schema.NullOr(Schema.String),
});
export type ReaderState = typeof ReaderState.Type;

export class ReaderNotConnectedError extends Schema.TaggedError<ReaderNotConnectedError>()(
  "ReaderNotConnectedError",
  {},
) {
  override get message(): string {
    return "The OBD-II adapter is not connected.";
  }
}

export class ReaderCommandError extends Schema.TaggedError<ReaderCommandError>()(
  "ReaderCommandError",
  {
    command: Schema.String,
    reason: Schema.Literals(["no-answer", "rejected", "timeout", "link"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-answer":
        return `The vehicle did not answer ${this.command}. Is the ignition on?`;
      case "rejected":
        return `The vehicle refused ${this.command}.`;
      case "timeout":
        return `The OBD-II adapter did not answer ${this.command} in time.`;
      case "link":
        return `The connection to the OBD-II adapter failed while sending ${this.command}.`;
    }
  }
}

export class ReaderConnectError extends Schema.TaggedError<ReaderConnectError>()(
  "ReaderConnectError",
  {
    target: ReaderTarget,
    reason: Schema.Literals(["open-failed", "no-adapter"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "open-failed":
        return "Could not reach the OBD-II adapter.";
      case "no-adapter":
        return "The device did not answer like an ELM327 OBD-II adapter.";
    }
  }
}

export const ReaderOperationError = Schema.Union([ReaderNotConnectedError, ReaderCommandError]);
