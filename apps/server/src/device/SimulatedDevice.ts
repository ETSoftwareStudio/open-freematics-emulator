import { ObdProtocol } from "@fme/contracts";
import { parseRawBytes, formatHexBytes } from "@fme/shared/atCommands";
import { makeLineFramer } from "@fme/shared/lineFramer";
import { findPid } from "@fme/shared/pids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { DeviceLink } from "./DeviceLink.ts";

export const SIMULATED_BANNER = "OBD-II EMULATOR V1.2";
export const SIMULATED_DETAILS = "00.00.02,00.01.05,201910,SIMULATED0000001";
const DEFAULT_VIN = "1HGCD5654VA061985";
const SUPPORT_BITMAP = [0xff, 0xff, 0xff, 0xff];
const DEFAULT_MONITOR_STATUS = [0x00, 0x07, 0x65, 0x00];
const DTC_PATTERN = /^[PCBU][0-3][0-9A-F]{3}$/;
const isProtocol = Schema.is(ObdProtocol);

/**
 * In-memory model of the MK2 control interface, matching what a V1.2 unit was measured to do:
 * replies end in `\r` (VIN in `\r\n`), commands are case- and space-insensitive, CALID and Mode
 * 07/0A DTCs are unsupported, and resets zero every PID.
 */
export class SimulatedFirmware {
  echo = false;
  ignition = true;
  vinEnabled = true;
  protocol: ObdProtocol = "CAN_11B_500K";
  vin = DEFAULT_VIN;
  storedDtcs: ReadonlyArray<string> = [];
  readonly pids = new Map<string, ReadonlyArray<number>>();

  constructor() {
    this.resetPids();
  }

  private resetPids() {
    this.pids.clear();
    for (const pid of ["0100", "0120", "0140"]) this.pids.set(pid, SUPPORT_BITMAP);
    this.pids.set("0101", DEFAULT_MONITOR_STATUS);
  }

  private bootText() {
    return `${SIMULATED_BANNER}\r\n${SIMULATED_DETAILS},${this.vin}\r\n`;
  }

  /** Returns the exact text the firmware writes back for one received line. */
  handle(line: string): string {
    const reply = this.respond(line);
    return this.echo ? `${line}\r${reply}` : reply;
  }

  private respond(line: string): string {
    const ok = "OK\r";
    const error = "ERROR\r";
    const command = line.replaceAll(" ", "").toUpperCase();
    const [, setKey, setValue] = /^ATSET(\w+)=(.*)$/.exec(command) ?? [];
    const [, getKey] = /^ATGET(\w+)$/.exec(command) ?? [];

    switch (command) {
      case "ATZ":
        this.resetPids();
        return `${SIMULATED_BANNER}\r\n${this.bootText()}`;
      case "ATR":
        this.resetPids();
        return `System Restarting...\r\n${this.bootText()}`;
      case "ATE0":
      case "ATE1":
        this.echo = command === "ATE1";
        return ok;
      case "ATACC0":
      case "ATACC1":
        this.ignition = command === "ATACC1";
        return ok;
      case "ATVIN0":
      case "ATVIN1":
        this.vinEnabled = command === "ATVIN1";
        return ok;
      case "ATINF0":
      case "ATINF1":
        return ok;
      case "ATCLRDTC":
        this.storedDtcs = [];
        return ok;
    }

    if (command.startsWith("ATBUS")) {
      const protocol = command.slice("ATBUS".length);
      if (!isProtocol(protocol)) return error;
      this.protocol = protocol;
      return ok;
    }

    if (setKey !== undefined && setValue !== undefined) {
      if (setKey === "VIN") {
        this.vin = setValue;
        return ok;
      }
      if (setKey === "DTC") {
        const codes = setValue.split(",").filter((code) => code.length > 0);
        if (codes.length > 6 || !codes.every((code) => DTC_PATTERN.test(code))) return error;
        this.storedDtcs = codes;
        return ok;
      }
      if (/^01[0-9A-F]{2}$/.test(setKey)) {
        const raw = parseRawBytes(setValue);
        if (raw !== undefined) {
          this.pids.set(setKey, raw);
          return ok;
        }
        const value = Number(setValue);
        const definition = findPid(setKey);
        if (!Number.isFinite(value) || value < 0) return error;
        this.pids.set(setKey, definition?.encode(value) ?? []);
        return ok;
      }
      return error;
    }

    if (getKey !== undefined) {
      if (getKey === "VIN") return `${this.vin}\r\n`;
      if (/^01[0-9A-F]{2}$/.test(getKey)) {
        const bytes =
          this.pids.get(getKey) ??
          findPid(getKey)
            ?.encode(0)
            .map(() => 0) ??
          [];
        return `${getKey}=${bytes.length === 0 ? "" : `${formatHexBytes(bytes)} `}\r`;
      }
      return error;
    }

    return error;
  }
}

const PROTOCOL_NUMBERS: Record<ObdProtocol, string> = {
  J1850_PWM: "1",
  J1850_VPW: "2",
  ISO9141_2: "3",
  KWP2000_5BPS: "4",
  KWP2000_FAST: "5",
  CAN_11B_500K: "6",
  CAN_29B_500K: "7",
  CAN_11B_250K: "8",
  CAN_29B_250K: "9",
  J1939: "A",
};

const hex = (byte: number) => byte.toString(16).padStart(2, "0").toUpperCase();

const encodeDtc = (code: string) => {
  const letter = "PCBU".indexOf(code[0]!);
  const value = Number.parseInt(code.slice(1), 16);
  return [(letter << 6) | (value >> 8), value & 0xff];
};

/**
 * An ELM327-compatible adapter plugged into the simulated emulator's OBD port. It answers from
 * the firmware's state the way a CAN vehicle does with headers off: `41 0C 1F 40`, then `>`.
 */
export class SimulatedElm327 {
  readonly firmware: SimulatedFirmware;

  constructor(firmware: SimulatedFirmware) {
    this.firmware = firmware;
  }

  handle(line: string): string {
    return `${this.respond(line.replaceAll(" ", "").toUpperCase())}\r\r>`;
  }

  private respond(command: string): string {
    const vehicle = this.firmware;
    if (command === "ATZ" || command === "ATI") return "ELM327 v1.5";
    if (command === "ATDPN") return `A${PROTOCOL_NUMBERS[vehicle.protocol]}`;
    if (command === "ATRV") return "12.6V";
    if (command.startsWith("AT")) return "OK";
    if (!/^[0-9A-F]+$/.test(command)) return "?";
    if (!vehicle.ignition) return "NO DATA";

    if (command.startsWith("01") && command.length === 4) {
      const bytes = vehicle.pids.get(command) ?? findPid(command)?.encode(0);
      if (bytes === undefined || bytes.length === 0) return "NO DATA";
      return ["41", command.slice(2), ...bytes.map(hex)].join(" ");
    }
    if (command === "03") {
      const data = vehicle.storedDtcs.flatMap(encodeDtc);
      return ["43", hex(vehicle.storedDtcs.length), ...data.map(hex)].join(" ");
    }
    if (command === "04") {
      vehicle.storedDtcs = [];
      return "44";
    }
    if (command === "07" || command === "0A") return `${command === "07" ? "47" : "4A"} 00`;
    if (command === "0902") {
      if (!vehicle.vinEnabled) return "NO DATA";
      const bytes = [0x49, 0x02, 0x01, ...[...vehicle.vin].map((c) => c.charCodeAt(0))];
      const frames = ["014", `0: ${bytes.slice(0, 6).map(hex).join(" ")}`];
      for (let i = 6, n = 1; i < bytes.length; i += 7, n++) {
        frames.push(
          `${n}: ${bytes
            .slice(i, i + 7)
            .map(hex)
            .join(" ")}`,
        );
      }
      return frames.join("\r");
    }
    return "NO DATA";
  }
}

export class SimulatedDevice extends Context.Service<
  SimulatedDevice,
  {
    readonly firmware: SimulatedFirmware;
    readonly open: Effect.Effect<DeviceLink, never, Scope.Scope>;
    /** An OBD-II adapter plugged into the simulated emulator. */
    readonly openAdapter: Effect.Effect<DeviceLink, never, Scope.Scope>;
  }
>()("@fme/server/device/SimulatedDevice") {}

const make = Effect.sync(() => {
  // One firmware per server, so state survives reconnects like a real device.
  const firmware = new SimulatedFirmware();
  const adapter = new SimulatedElm327(firmware);
  const linkTo = Effect.fn("SimulatedDevice.link")(function* (handle: (line: string) => string) {
    const output = yield* Effect.acquireRelease(Queue.unbounded<string>(), Queue.shutdown);
    const frame = makeLineFramer();
    const write = (data: string) =>
      Effect.sync(() => {
        for (const line of frame(data)) Queue.offerUnsafe(output, handle(line));
      });
    return { write, chunks: Stream.fromQueue(output) } satisfies DeviceLink;
  });
  return SimulatedDevice.of({
    firmware,
    open: linkTo((line) => firmware.handle(line)),
    openAdapter: linkTo((line) => adapter.handle(line)),
  });
});

export const layer = Layer.effect(SimulatedDevice, make);
