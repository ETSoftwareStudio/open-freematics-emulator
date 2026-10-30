import type { FirmwareUpdateState } from "@fme/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as EmulatorSession from "../emulator/EmulatorSession.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import { BootloaderCommand } from "./bootloaderFrame.ts";
import { APPLICATION_BASE, FLASH_BASE } from "./flashPlan.ts";
import * as FirmwareUpdater from "./FirmwareUpdater.ts";

const layerOn = (version: SimulatedDevice.SimulatedVersion) =>
  FirmwareUpdater.layer.pipe(
    Layer.provideMerge(EmulatorSession.layer),
    Layer.provideMerge(SimulatedDevice.layerFor(version)),
    Layer.provide(SerialPorts.layer),
    Layer.provide(TrafficLog.layer),
  );
const TestLayer = layerOn("1.3");

// The FIPS-197 example key; the simulated bootloader takes whichever key the update uses.
const TEST_KEY = "000102030405060708090a0b0c0d0e0f";
const APPLICATION = Uint8Array.from({ length: 2500 }, (_, i) => (i * 7) & 0xff);

const record = (type: number, offset: number, data: ReadonlyArray<number> = []) => {
  const fields = [data.length, offset >> 8, offset & 0xff, type, ...data];
  const sum = fields.reduce((acc, byte) => acc + byte, 0);
  return `:${Buffer.from([...fields, -sum & 0xff]).toString("hex")}`;
};

const hexFile = (address: number, data: Uint8Array) => {
  const lines: Array<string> = [];
  for (let i = 0; i < data.length; i += 16) {
    const at = address + i;
    if (i === 0 || (at & 0xffff) === 0)
      lines.push(record(0x04, 0, [at >>> 24, (at >>> 16) & 0xff]));
    lines.push(record(0x00, at & 0xffff, [...data.subarray(i, i + 16)]));
  }
  return [...lines, record(0x01, 0)].join("\n");
};

const IMAGE = hexFile(APPLICATION_BASE, APPLICATION);
const simulatedUpdate = { target: { _tag: "simulated" }, image: IMAGE, wireKey: TEST_KEY } as const;

const stateOf = Effect.gen(function* () {
  const updater = yield* FirmwareUpdater.FirmwareUpdater;
  const [state] = yield* updater.state.pipe(Stream.take(1), Stream.runCollect);
  return state as FirmwareUpdateState;
});

/** Runs an update while the test clock covers the restart and any handshake retries. */
const updateOverTime = (elapsed: Duration.Duration) =>
  Effect.gen(function* () {
    const updater = yield* FirmwareUpdater.FirmwareUpdater;
    const running = yield* updater.update(simulatedUpdate).pipe(Effect.exit, Effect.forkChild);
    // The simulated unit, like a real one, sends no readable application info.
    const finishing = Duration.sum(FirmwareUpdater.REPLY_TIMEOUT, FirmwareUpdater.RUN_SETTLE);
    yield* TestClock.adjust(Duration.sum(elapsed, finishing));
    return yield* Fiber.join(running);
  });

const offset = (address: number) => address - FLASH_BASE;

describe("FirmwareUpdater", () => {
  it.effect("flashes the simulated unit and leaves its bootloader untouched", () =>
    Effect.gen(function* () {
      const { bootloader } = yield* SimulatedDevice.SimulatedDevice;
      const exit = yield* updateOverTime(FirmwareUpdater.RESTART_DELAY);
      expect(exit._tag).toBe("Success");

      const application = offset(APPLICATION_BASE);
      expect(bootloader.flash.subarray(application, application + APPLICATION.length)).toEqual(
        APPLICATION,
      );
      expect(
        bootloader.flash.subarray(application + APPLICATION.length).every((b) => b === 0xff),
      ).toBe(true);
      expect(
        bootloader.flash
          .subarray(0, application)
          .every((b) => b === SimulatedDevice.SIMULATED_BOOTLOADER_BYTE),
      ).toBe(true);
      expect(bootloader.received).toEqual([
        0x00, 0x02, 0x04, 0x05, 0x06, 0x07, 0x07, 0x07, 0x08, 0x03, 0x01, 0x0b, 0x09,
      ]);
      expect(bootloader.mode).toBe("off");
      expect(yield* stateOf).toMatchObject({ _tag: "succeeded", bytes: 2500, version: null });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("leaves a simulated V1.2 unit on V1.3, with V1.3's defaults", () =>
    Effect.gen(function* () {
      const { firmware } = yield* SimulatedDevice.SimulatedDevice;
      yield* updateOverTime(FirmwareUpdater.RESTART_DELAY);
      expect([firmware.version, firmware.vin]).toEqual(["1.3", "LSGGG54EXE105928"]);
      expect(firmware.handle("ATGET CALID")).toBe("JMB*36761500\r\n");
    }).pipe(Effect.provide(layerOn("1.2"))),
  );

  it.effect("waits past other frames for an acknowledgement and doesn't wait on run", () =>
    Effect.gen(function* () {
      const { bootloader } = yield* SimulatedDevice.SimulatedDevice;
      bootloader.chattyCommand = BootloaderCommand.write;
      bootloader.silentCommand = BootloaderCommand.run;
      const exit = yield* updateOverTime(FirmwareUpdater.RESTART_DELAY);
      expect(exit._tag).toBe("Success");
      expect(bootloader.received.at(-1)).toBe(BootloaderCommand.run);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("retries the handshake while the unit is still restarting", () =>
    Effect.gen(function* () {
      const { bootloader } = yield* SimulatedDevice.SimulatedDevice;
      bootloader.ignoreHandshakes = 2;
      const exit = yield* updateOverTime(
        Duration.sum(
          FirmwareUpdater.RESTART_DELAY,
          Duration.times(FirmwareUpdater.HANDSHAKE_TIMEOUT, 2),
        ),
      );
      expect(exit._tag).toBe("Success");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("gives up before erasing anything when the bootloader never answers", () =>
    Effect.gen(function* () {
      const { bootloader } = yield* SimulatedDevice.SimulatedDevice;
      bootloader.ignoreHandshakes = FirmwareUpdater.HANDSHAKE_ATTEMPTS;
      const exit = yield* updateOverTime(
        Duration.sum(
          FirmwareUpdater.RESTART_DELAY,
          Duration.times(FirmwareUpdater.HANDSHAKE_TIMEOUT, FirmwareUpdater.HANDSHAKE_ATTEMPTS),
        ),
      );
      expect(exit).toMatchObject({ _tag: "Failure" });
      expect(bootloader.received).toEqual([]);
      expect(yield* stateOf).toMatchObject({
        _tag: "failed",
        stage: "handshake",
        applicationErased: false,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports an erased application when the bootloader rejects a write", () =>
    Effect.gen(function* () {
      const { bootloader } = yield* SimulatedDevice.SimulatedDevice;
      bootloader.rejectCommand = BootloaderCommand.write;
      yield* updateOverTime(FirmwareUpdater.RESTART_DELAY);
      expect(yield* stateOf).toMatchObject({
        _tag: "failed",
        stage: "writing",
        reason: "The bootloader rejected a command.",
        applicationErased: true,
      });
      expect(bootloader.received.at(-1)).toBe(BootloaderCommand.write);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails when the bootloader stops answering mid-update", () =>
    Effect.gen(function* () {
      const { bootloader } = yield* SimulatedDevice.SimulatedDevice;
      bootloader.silentCommand = BootloaderCommand.erase;
      yield* updateOverTime(
        Duration.sum(FirmwareUpdater.RESTART_DELAY, FirmwareUpdater.ERASE_TIMEOUT),
      );
      expect(yield* stateOf).toMatchObject({
        _tag: "failed",
        stage: "erasing",
        reason: "The bootloader stopped answering.",
        applicationErased: true,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("can update again after an attempt that stopped mid-session", () =>
    Effect.gen(function* () {
      const updater = yield* FirmwareUpdater.FirmwareUpdater;
      const tooBig = hexFile(APPLICATION_BASE, new Uint8Array(0x1d000));
      const failed = yield* updater
        .update({ ...simulatedUpdate, image: tooBig })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(FirmwareUpdater.RESTART_DELAY);
      expect(yield* Fiber.join(failed)).toMatchObject({ reason: "doesNotFit" });

      const exit = yield* updateOverTime(FirmwareUpdater.RESTART_DELAY);
      expect(exit._tag).toBe("Success");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("runs one update at a time", () =>
    Effect.gen(function* () {
      const updater = yield* FirmwareUpdater.FirmwareUpdater;
      const first = yield* updater.update(simulatedUpdate).pipe(Effect.forkChild);
      yield* updater.state.pipe(
        Stream.filter((state) => state._tag === "running"),
        Stream.take(1),
        Stream.runDrain,
      );
      const second = yield* updater.update(simulatedUpdate).pipe(Effect.flip);
      expect(second).toMatchObject({ _tag: "FirmwareUpdateError", reason: "busy" });
      yield* TestClock.adjust(
        Duration.sum(
          FirmwareUpdater.RESTART_DELAY,
          Duration.sum(FirmwareUpdater.REPLY_TIMEOUT, FirmwareUpdater.RUN_SETTLE),
        ),
      );
      yield* Fiber.join(first);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a real port without the vendor key, before opening it", () =>
    Effect.gen(function* () {
      const updater = yield* FirmwareUpdater.FirmwareUpdater;
      const error = yield* updater
        .update({ ...simulatedUpdate, target: { _tag: "serial", path: "/dev/null" } })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "FirmwareUpdateError", reason: "wrongKey" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("summarizes an image and refuses one outside the application area", () =>
    Effect.gen(function* () {
      const updater = yield* FirmwareUpdater.FirmwareUpdater;
      expect(yield* updater.inspect(IMAGE)).toEqual({
        start: APPLICATION_BASE,
        end: APPLICATION_BASE + 2500,
        bytes: 2500,
      });
      const error = yield* updater.inspect(hexFile(FLASH_BASE, APPLICATION)).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "FirmwareImageError", reason: "outsideApplication" });
    }).pipe(Effect.provide(TestLayer)),
  );
});
