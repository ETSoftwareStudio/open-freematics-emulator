import { ObdProtocol } from "@fme/contracts";
import { parseRawBytes, formatHexBytes } from "@fme/shared/atCommands";
import { makeLineFramer } from "@fme/shared/lineFramer";
import { findPid } from "@fme/shared/pids";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  BootloaderCommand,
  decodeCommandFrame,
  encodeReplyFrame,
} from "../firmware/bootloaderFrame.ts";
import { APPLICATION_BASE, FLASH_BASE } from "../firmware/flashPlan.ts";
import type { DeviceLink } from "./DeviceLink.ts";

export type SimulatedVersion = "1.2" | "1.3";

/** What each firmware printed and held by default on a real unit (V1.3 since 2026-10-30). */
const FIRMWARES = {
  "1.2": { hardware: "00.01.05", vin: "1HGCD5654VA061985", calibrationId: null, trailer: "" },
  "1.3": {
    hardware: "00.01.08",
    // Sixteen characters, as V1.3 ships it.
    vin: "LSGGG54EXE105928",
    calibrationId: "JMB*36761500",
    trailer: "SPN:00\r\n",
  },
} satisfies Record<SimulatedVersion, { calibrationId: string | null } & Record<string, unknown>>;

export const simulatedBanner = (version: SimulatedVersion) => `OBD-II EMULATOR V${version}`;
const SUPPORT_BITMAP = [0xff, 0xff, 0xff, 0xff];
const DEFAULT_MONITOR_STATUS = [0x00, 0x07, 0x65, 0x00];
const DTC_PATTERN = /^[PCBU][0-3][0-9A-F]{3}$/;
const isProtocol = Schema.is(ObdProtocol);

/**
 * In-memory model of the MK2 control interface, matching what real units were measured to do:
 * replies end in `\r` (VIN in `\r\n`), commands are case- and space-insensitive, and resets
 * zero every PID. V1.2 refuses CALID and Mode 07/0A DTCs; V1.3 takes them and prints an extra
 * `SPN:00` line after the info line.
 */
export class SimulatedFirmware {
  version: SimulatedVersion;
  echo = false;
  ignition = true;
  vinEnabled = true;
  protocol: ObdProtocol = "CAN_11B_500K";
  vin: string;
  calibrationId: string | null;
  storedDtcs: ReadonlyArray<string> = [];
  pendingDtcs: ReadonlyArray<string> = [];
  permanentDtcs: ReadonlyArray<string> = [];
  readonly pids = new Map<string, ReadonlyArray<number>>();
  /** A command to answer with `ERROR`, like firmware that lacks it. */
  rejectCommand: string | null = null;

  constructor(version: SimulatedVersion = "1.3") {
    this.version = version;
    this.vin = FIRMWARES[version].vin;
    this.calibrationId = FIRMWARES[version].calibrationId;
    this.resetPids();
  }

  /** A completed flash: the new firmware's defaults replace the old ones, as on the real unit. */
  install(version: SimulatedVersion) {
    this.version = version;
    this.vin = FIRMWARES[version].vin;
    this.calibrationId = FIRMWARES[version].calibrationId;
    this.storedDtcs = this.pendingDtcs = this.permanentDtcs = [];
    this.resetPids();
  }

  get banner() {
    return simulatedBanner(this.version);
  }

  get details() {
    return `00.00.02,${FIRMWARES[this.version].hardware},201910,SIMULATED0000001`;
  }

  private resetPids() {
    this.pids.clear();
    for (const pid of ["0100", "0120", "0140"]) this.pids.set(pid, SUPPORT_BITMAP);
    this.pids.set("0101", DEFAULT_MONITOR_STATUS);
  }

  private bootText() {
    return `${this.banner}\r\n${this.details},${this.vin}\r\n${FIRMWARES[this.version].trailer}`;
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
    if (command === this.rejectCommand?.replaceAll(" ", "").toUpperCase()) return error;
    const [, setKey, setValue] = /^ATSET(\w+)=(.*)$/.exec(command) ?? [];
    const [, getKey] = /^ATGET(\w+)$/.exec(command) ?? [];
    const v13 = this.version === "1.3";

    switch (command) {
      case "ATZ":
        this.resetPids();
        return `${this.banner}\r\n${this.bootText()}`;
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
        this.storedDtcs = this.pendingDtcs = this.permanentDtcs = [];
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
      const dtcList = setKey === "DTC" || (v13 && (setKey === "DTC7" || setKey === "DTCA"));
      if (dtcList) {
        const codes = setValue.split(",").filter((code) => code.length > 0);
        if (codes.length > 6 || !codes.every((code) => DTC_PATTERN.test(code))) return error;
        if (setKey === "DTC") this.storedDtcs = codes;
        else if (setKey === "DTC7") this.pendingDtcs = codes;
        else this.permanentDtcs = codes;
        return ok;
      }
      if (v13 && setKey === "CALID") {
        this.calibrationId = setValue;
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
      if (getKey === "CALID" && this.calibrationId !== null) return `${this.calibrationId}\r\n`;
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
    const listCodes = (reply: string, codes: ReadonlyArray<string>) =>
      [reply, hex(codes.length), ...codes.flatMap(encodeDtc).map(hex)].join(" ");
    if (command === "03") return listCodes("43", vehicle.storedDtcs);
    if (command === "07") return listCodes("47", vehicle.pendingDtcs);
    if (command === "0A") return listCodes("4A", vehicle.permanentDtcs);
    // Mode 04 clears stored and pending codes; permanent ones stay until the fault is gone.
    if (command === "04") {
      vehicle.storedDtcs = vehicle.pendingDtcs = [];
      return "44";
    }
    if (command === "0902") {
      if (!vehicle.vinEnabled) return "NO DATA";
      const bytes = [0x49, 0x02, 0x01, ...[...vehicle.vin].map((c) => c.charCodeAt(0))];
      const length = bytes.length.toString(16).toUpperCase().padStart(3, "0");
      const frames = [length, `0: ${bytes.slice(0, 6).map(hex).join(" ")}`];
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

export const SIMULATED_CHIP_ID = Uint8Array.from(Buffer.from("0123456789abcdef01234567", "hex"));
/** Stands in for the vendor bootloader below the application, so tests can see it untouched. */
export const SIMULATED_BOOTLOADER_BYTE = 0xb1;

/**
 * The MK2 bootloader as a real V1.2 unit answered a read-only probe: after `ATR` (never before) it
 * answers `***` with `>>>` and `Download?` with `OK.`, then takes encrypted command frames until
 * it's told to run the application. Erase and write follow the vendor updater's capture. The real wire key can't ship here, so it decrypts with whatever key it's
 * given, and it refuses to erase or write below the application, as the real one must.
 */
export class SimulatedBootloader {
  wireKey = new Uint8Array(16);
  readonly flashKib = 128;
  readonly flash = new Uint8Array(128 * 1024).fill(0xff);
  mode: "off" | "armed" | "handshake" | "frames" = "off";
  /** Handshakes to ignore before answering, like a unit still restarting. */
  ignoreHandshakes = 0;
  /** A command to answer with an error frame, or to leave unanswered. */
  rejectCommand: number | null = null;
  silentCommand: number | null = null;
  /** A command whose reply follows an unrelated frame, which the updater must skip. */
  chattyCommand: number | null = null;
  /** A command whose reply comes again in a later read, like one that arrived after a timeout. */
  lateCommand: number | null = null;
  readonly received: Array<number> = [];
  /** Runs when the application starts after a flash that wrote something. */
  onFlashed: (() => void) | null = null;
  private wrote = false;
  private late: Array<number> = [];
  private text = "";
  private frame: Array<number> | null = null;

  constructor() {
    this.flash.fill(SIMULATED_BOOTLOADER_BYTE, 0, APPLICATION_BASE - FLASH_BASE);
  }

  /** What `lateCommand` sends again after its reply, since last asked. */
  takeLate(): Uint8Array {
    const late = Uint8Array.from(this.late);
    this.late = [];
    return late;
  }

  /** Bytes in, bytes out. Text the bootloader isn't waiting for is dropped. */
  receive(bytes: Uint8Array): Uint8Array {
    const out: Array<number> = [];
    for (const byte of bytes) {
      // Between frames a new `***` restarts the handshake, so an aborted update can be retried.
      if (this.mode !== "frames" || (this.frame === null && byte !== 0xbb)) {
        this.text = (this.text + String.fromCharCode(byte)).slice(-16);
        if (this.text.endsWith("***")) {
          this.text = "";
          if (this.ignoreHandshakes > 0) this.ignoreHandshakes--;
          else {
            this.mode = "handshake";
            out.push(...Buffer.from(">>>"));
          }
        } else if (this.mode === "handshake" && this.text.endsWith("Download?")) {
          this.text = "";
          this.mode = "frames";
          out.push(...Buffer.from("OK."));
        }
        continue;
      }
      if (byte === 0xbb) this.frame = [byte];
      else if (this.frame !== null) {
        this.frame.push(byte);
        if (byte === 0xee) {
          out.push(...this.handle(Uint8Array.from(this.frame)));
          this.frame = null;
        }
      }
    }
    return Uint8Array.from(out);
  }

  private handle(frame: Uint8Array): Uint8Array {
    const decoded = decodeCommandFrame(frame, this.wireKey);
    if (Result.isFailure(decoded)) return new Uint8Array();
    const { command, payload } = decoded.success;
    this.received.push(command);
    if (command === this.silentCommand) return new Uint8Array();
    const reply = this.reply(command, payload);
    if (command === this.lateCommand) this.late.push(...reply);
    return command === this.chattyCommand
      ? Uint8Array.of(...encodeReplyFrame(command, Uint8Array.of(1)), ...reply)
      : reply;
  }

  private reply(command: number, payload: Uint8Array): Uint8Array {
    const ack = encodeReplyFrame(BootloaderCommand.ack, Uint8Array.of(0));
    const error = encodeReplyFrame(BootloaderCommand.error, Uint8Array.of(command, 1));
    if (command === this.rejectCommand) return error;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const end = FLASH_BASE + this.flashKib * 1024;
    switch (command) {
      case BootloaderCommand.readChipId:
        return encodeReplyFrame(
          command,
          Uint8Array.of(this.flashKib >> 8, this.flashKib & 0xff, ...SIMULATED_CHIP_ID),
        );
      case BootloaderCommand.readSerial:
        return encodeReplyFrame(command, Uint8Array.of(...Buffer.from("G1901."), 0, 0, 0, 0, 0, 0));
      case BootloaderCommand.readVersion:
        return encodeReplyFrame(
          command,
          Uint8Array.of(...Buffer.from("0001"), 0x14, 0x05, 0, 0x20, 1, 0),
        );
      case BootloaderCommand.readBootInfo:
        return encodeReplyFrame(command, Buffer.from("USART:0002"));
      case BootloaderCommand.readCheck:
        return encodeReplyFrame(command, payload);
      case BootloaderCommand.erase: {
        const address = view.getUint32(0);
        const stop = address + view.getUint16(4) * 1024;
        if (payload.length !== 6 || address < APPLICATION_BASE || stop > end) return error;
        this.flash.fill(0xff, address - FLASH_BASE, stop - FLASH_BASE);
        return ack;
      }
      case BootloaderCommand.write: {
        const address = view.getUint32(0);
        const data = payload.subarray(6);
        if (view.getUint16(4) !== data.length || address < APPLICATION_BASE) return error;
        if (address + data.length > end) return error;
        this.flash.set(data, address - FLASH_BASE);
        this.wrote = true;
        return ack;
      }
      case BootloaderCommand.writeCrc:
        return payload.length === 16 ? ack : error;
      case BootloaderCommand.writeDone:
        return ack;
      case BootloaderCommand.readAppInfo:
        // Not a well-formed frame: the bare reply a real unit gave after a flash.
        return Uint8Array.of(0xbb, 0x00, 0xee);
      case BootloaderCommand.run:
        this.mode = "off";
        if (this.wrote) this.onFlashed?.();
        this.wrote = false;
        return ack;
      default:
        return error;
    }
  }
}

export class SimulatedDevice extends Context.Service<
  SimulatedDevice,
  {
    readonly firmware: SimulatedFirmware;
    readonly bootloader: SimulatedBootloader;
    readonly open: Effect.Effect<DeviceLink, never, Scope.Scope>;
    /** An OBD-II adapter plugged into the simulated emulator. */
    readonly openAdapter: Effect.Effect<DeviceLink, never, Scope.Scope>;
  }
>()("@fme/server/device/SimulatedDevice") {}

const make = (version: SimulatedVersion) =>
  Effect.sync(() => {
    // One firmware per server, so state survives reconnects like a real device.
    const firmware = new SimulatedFirmware(version);
    const bootloader = new SimulatedBootloader();
    // The image isn't parsed: a simulated flash installs the official V1.3, as on the real unit.
    bootloader.onFlashed = () => firmware.install("1.3");
    const adapter = new SimulatedElm327(firmware);
    const linkTo = Effect.fn("SimulatedDevice.link")(function* (
      handle: (line: string) => string,
      withBootloader: boolean,
    ) {
      const output = yield* Effect.acquireRelease(Queue.unbounded<string>(), Queue.shutdown);
      const frame = makeLineFramer();
      const write = (data: string | Uint8Array) =>
        Effect.sync(() => {
          const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
          if (withBootloader && bootloader.mode !== "off") {
            for (const reply of [bootloader.receive(bytes), bootloader.takeLate()]) {
              if (reply.length > 0)
                Queue.offerUnsafe(output, Buffer.from(reply).toString("latin1"));
            }
            if (bootloader.mode !== "armed") return;
          }
          for (const line of frame(Buffer.from(bytes).toString("latin1"))) {
            Queue.offerUnsafe(output, handle(line));
            // A reset restarts into the bootloader, which then listens for the updater.
            if (withBootloader && line.replaceAll(" ", "").toUpperCase() === "ATR") {
              bootloader.mode = "armed";
            }
          }
        });
      return { write, chunks: Stream.fromQueue(output) } satisfies DeviceLink;
    });
    return SimulatedDevice.of({
      firmware,
      bootloader,
      open: linkTo((line) => firmware.handle(line), true),
      openAdapter: linkTo((line) => adapter.handle(line), false),
    });
  });

export const layerFor = (version: SimulatedVersion) => Layer.effect(SimulatedDevice, make(version));

export const layer = layerFor("1.3");
