import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { DeviceLinkError } from "./DeviceLink.ts";
import { fakePorts } from "./fakePorts.ts";
import * as SerialPorts from "./SerialPorts.ts";
import { toInfo } from "./SerialPorts.ts";

const listed = (path: string, ids: { vendorId?: string; productId?: string; pnpId?: string }) => ({
  path,
  manufacturer: undefined,
  serialNumber: undefined,
  locationId: undefined,
  pnpId: ids.pnpId,
  vendorId: ids.vendorId,
  productId: ids.productId,
});

describe("toInfo", () => {
  it.each([
    ["darwin", listed("/dev/tty.usbserial-0001", { vendorId: "10C4", productId: "EA60" }), "usb"],
    ["darwin", listed("/dev/tty.OBDII", {}), "bluetooth"],
    ["linux", listed("/dev/ttyUSB0", { vendorId: "1a86", productId: "7523" }), "usb"],
    ["linux", listed("/dev/rfcomm0", {}), "bluetooth"],
    ["linux", listed("/dev/ttyS0", {}), "other"],
    [
      "win32",
      listed("COM5", { pnpId: "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}" }),
      "bluetooth",
    ],
    ["win32", listed("COM3", { vendorId: "10C4", productId: "EA60" }), "usb"],
  ] as const)("on %s classifies %o as %s", (platform, port, transport) => {
    expect(toInfo(port, platform).transport).toBe(transport);
  });

  it("opens macOS ports through their call-up device", () => {
    const info = toInfo(
      listed("/dev/tty.usbserial-0001", { vendorId: "10C4", productId: "EA60" }),
      "darwin",
    );
    expect(info).toMatchObject({ path: "/dev/cu.usbserial-0001", likelyEmulator: true });
  });
});

const PATH = "/dev/cu.OBDII";

const portsLayer = (
  fake: ReturnType<typeof fakePorts>,
  platform: NodeJS.Platform = "darwin",
  bluetooth = true,
) =>
  SerialPorts.layerWith({
    platform,
    isBluetooth: () => Effect.succeed(bluetooth),
    openPort: fake.openPort,
  });

const openPath = Effect.flatMap(SerialPorts.SerialPorts, (ports) => ports.open(PATH));

/** Opens the port, runs `use` on the link, then closes the lease. */
const withLink = <A, E, R>(use: (link: SerialPorts.SerialLink) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(openPath, use));

const firstChunk = (link: SerialPorts.SerialLink) =>
  link.chunks.pipe(Stream.runHead, Effect.flatMap(Effect.fromOption));

const echo = (written: string) => `${written}>`;

describe("SerialPorts on macOS Bluetooth", () => {
  it.effect("keeps the port open between leases and reuses it", () => {
    const fake = fakePorts(echo);
    return Effect.gen(function* () {
      const exchange = (command: string) =>
        withLink((link) =>
          Effect.andThen(link.write(command), firstChunk(link)).pipe(
            Effect.map((reply) => ({ reply, silentMeansStale: link.silentMeansStale })),
          ),
        );
      expect(yield* exchange("ATZ\r")).toEqual({ reply: "ATZ\r>", silentMeansStale: true });
      expect(yield* exchange("ATI\r")).toEqual({ reply: "ATI\r>", silentMeansStale: false });
      expect(fake.state.events).toEqual(["open"]);
    }).pipe(Effect.provide(portsLayer(fake)));
  });

  it.effect("discards what arrives while no lease is open", () => {
    const fake = fakePorts(echo);
    return Effect.gen(function* () {
      yield* withLink(() => Effect.void);
      yield* Queue.offer(fake.state.incoming!, "ELM327 v1.5\r>").pipe(
        Effect.delay("1 second"),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      const reply = yield* withLink((link) =>
        Effect.andThen(link.write("ATI\r"), firstChunk(link)),
      );
      expect(reply).toBe("ATI\r>");
    }).pipe(Effect.provide(portsLayer(fake)));
  });

  it.effect("hands out one lease at a time", () => {
    const fake = fakePorts();
    return Effect.gen(function* () {
      const error = yield* withLink(() => Effect.flip(Effect.scoped(openPath)));
      expect(error.operation).toBe("open");
      yield* withLink(() => Effect.void);
      expect(fake.state.events).toEqual(["open"]);
    }).pipe(Effect.provide(portsLayer(fake)));
  });

  it.effect("closes a port that fails and really opens it again next time", () => {
    const fake = fakePorts();
    return Effect.gen(function* () {
      const readFailure = yield* withLink((link) => {
        Queue.failCauseUnsafe(
          fake.state.incoming!,
          Cause.fail(new DeviceLinkError({ operation: "read", cause: new Error("gone") })),
        );
        return Effect.flip(Stream.runDrain(link.chunks));
      });
      expect(readFailure.operation).toBe("read");
      expect(fake.state.events).toEqual(["open", "close"]);

      fake.state.failWrites = true;
      const writeFailure = yield* withLink((link) =>
        Effect.flip(link.write("ATZ\r")).pipe(
          Effect.map((error) => ({ error: error.operation, stale: link.silentMeansStale })),
        ),
      );
      expect(writeFailure).toEqual({ error: "write", stale: true });
      expect(fake.state.events).toEqual(["open", "close", "open", "close"]);
    }).pipe(Effect.provide(portsLayer(fake)));
  });

  it.effect("closes held ports when the server stops", () => {
    const fake = fakePorts();
    return Effect.gen(function* () {
      yield* withLink(() => Effect.void).pipe(Effect.provide(portsLayer(fake)));
      expect(fake.state.events).toEqual(["open", "close"]);
    });
  });
});

describe("SerialPorts elsewhere", () => {
  it.effect.each([
    ["a USB port on macOS", "darwin", false],
    ["a Bluetooth port on Linux", "linux", true],
    ["a Bluetooth port on Windows", "win32", true],
  ] as const)("closes %s when its lease ends", ([, platform, bluetooth]) => {
    const fake = fakePorts();
    return Effect.gen(function* () {
      const stale = yield* withLink((link) => Effect.succeed(link.silentMeansStale));
      yield* withLink(() => Effect.void);
      expect(stale).toBe(false);
      expect(fake.state.events).toEqual(["open", "close", "open", "close"]);
    }).pipe(Effect.provide(portsLayer(fake, platform, bluetooth)));
  });
});
