import type { DtcCode, PidId, ReaderState } from "@fme/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { fakePorts } from "../device/fakePorts.ts";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as TcpSockets from "../device/TcpSockets.ts";
import * as EmulatorSession from "../emulator/EmulatorSession.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import * as ElmClient from "./ElmClient.ts";
import * as ObdReader from "./ObdReader.ts";

// V1.2: V1.3's default VIN has 16 characters, which a scan tool doesn't take as a VIN.
const TestLayer = Layer.mergeAll(EmulatorSession.layer, ObdReader.layer).pipe(
  Layer.provideMerge(SimulatedDevice.layerFor("1.2")),
  Layer.provide(Layer.mergeAll(SerialPorts.layer, TcpSockets.layer, TrafficLog.layer)),
);

/** Waits for the reader state to satisfy `predicate`, advancing the poll clock meanwhile. */
const readerStateWhere = (predicate: (state: ReaderState) => boolean) =>
  Effect.gen(function* () {
    const reader = yield* ObdReader.ObdReader;
    const waiting = yield* reader.state.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    const [state] = yield* Fiber.join(waiting);
    return state!;
  });

describe("ObdReader", () => {
  it.layer(TestLayer)((it) => {
    it.effect("identifies the adapter and the protocol the emulator speaks", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const reader = yield* ObdReader.ObdReader;
        yield* session.connect({ _tag: "simulated" });
        yield* reader.connect({ _tag: "simulated" });
        const state = yield* readerStateWhere((s) => s.connection._tag === "connected");
        expect(state.connection).toMatchObject({ adapter: "ELM327 v1.5", protocol: "A6" });
        expect(state.vehicleResponding).toBe(true);
        expect(state.voltage).toBe(12.6);
      }),
    );

    it.effect("reads back the values the emulator serves", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        yield* session.setPid("010C" as PidId, 3000);
        yield* session.setPid("0105" as PidId, -10);
        const state = yield* readerStateWhere(
          (s) =>
            s.readings["010C" as PidId]?.value === 3000 &&
            s.readings["0105" as PidId]?.value === -10,
        );
        expect(state.readings["010C" as PidId]?.raw).toEqual([0x2e, 0xe0]);
      }),
    );

    it.effect("polls whatever the UI is watching", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const reader = yield* ObdReader.ObdReader;
        yield* session.setPid("0142" as PidId, 13.8);
        yield* reader.watch(["0142" as PidId]);
        const state = yield* readerStateWhere((s) => s.readings["0142" as PidId] !== undefined);
        expect(state.readings["0142" as PidId]?.value).toBeCloseTo(13.8);
      }),
    );

    it.effect("reads stored codes and the VIN", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const reader = yield* ObdReader.ObdReader;
        yield* session.setDtcs("03", ["P0300", "U0100"] as Array<DtcCode>);
        yield* reader.readDtcs;
        yield* reader.readVin;
        const state = yield* readerStateWhere((s) => s.vin !== null);
        expect(state.dtcs).toEqual(["P0300", "U0100"]);
        expect(state.monitorStatus?.[0]).toBe(0x82);
        expect(state.dtcsAt).not.toBeNull();
        expect(state.vin).toBe("1HGCD5654VA061985");
      }),
    );

    it.effect("clears codes from the vehicle side with Mode 04", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const reader = yield* ObdReader.ObdReader;
        const simulated = yield* SimulatedDevice.SimulatedDevice;
        yield* session.setDtcs("03", ["P0301"] as Array<DtcCode>);
        yield* reader.readDtcs;
        yield* reader.clearDtcs;
        const state = yield* readerStateWhere((s) => s.dtcs?.length === 0);
        expect(simulated.firmware.storedDtcs).toEqual([]);
        expect(state.dtcs).toEqual([]);
      }),
    );

    it.effect("pauses polling, reads once on demand, then resumes", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const reader = yield* ObdReader.ObdReader;
        yield* reader.setPolling({ paused: true, interval: 500 });
        yield* reader.watch(["010D" as PidId]);
        // Lets a cycle that started before the pause finish.
        yield* readerStateWhere((s) => s.pollRate === 0);
        yield* session.setPid("010D" as PidId, 77);
        const paused = yield* readerStateWhere((s) => s.polling.paused);
        expect(paused.readings["010D" as PidId]?.value).not.toBe(77);

        yield* reader.readOnce;
        yield* readerStateWhere((s) => s.readings["010D" as PidId]?.value === 77);

        yield* session.setPid("010D" as PidId, 88);
        yield* reader.setPolling({ paused: false, interval: 500 });
        yield* readerStateWhere((s) => s.readings["010D" as PidId]?.value === 88);
      }),
    );

    it.effect("reads each watched PID once per interval", () =>
      Effect.gen(function* () {
        const reader = yield* ObdReader.ObdReader;
        yield* reader.watch(["010C", "010D"] as Array<PidId>);
        yield* reader.setPolling({ paused: false, interval: 250 });
        const state = yield* readerStateWhere((s) => s.pollRate === 8);
        expect(state.polling.interval).toBe(250);
      }),
    );

    it.effect("marks PIDs the vehicle does not answer", () =>
      Effect.gen(function* () {
        const reader = yield* ObdReader.ObdReader;
        yield* reader.watch(["010C", "0151"] as Array<PidId>);
        const state = yield* readerStateWhere((s) => s.unanswered.includes("0151" as PidId));
        expect(state.unanswered).toEqual(["0151"]);
        expect(state.vehicleResponding).toBe(true);
      }),
    );

    it.effect("notices when the vehicle stops answering", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const reader = yield* ObdReader.ObdReader;
        yield* session.setIgnition(false);
        yield* readerStateWhere((s) => !s.vehicleResponding);
        const error = yield* reader.readVin.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ReaderCommandError", reason: "no-answer" });
        yield* session.setIgnition(true);
        yield* readerStateWhere((s) => s.vehicleResponding);
      }),
    );

    it.effect("forgets the previous connection's results; a read waits for the reconnect", () =>
      Effect.gen(function* () {
        const reader = yield* ObdReader.ObdReader;
        yield* reader.readDtcs;
        yield* reader.disconnect;
        const reconnecting = yield* reader.connect({ _tag: "simulated" }).pipe(Effect.forkChild);
        yield* reader.state.pipe(
          Stream.filter((s) => s.connection._tag === "connecting"),
          Stream.runHead,
        );
        yield* reader.readVin;
        yield* Fiber.join(reconnecting);
        const state = yield* reader.state.pipe(Stream.runHead, Effect.flatMap(Effect.fromOption));
        expect(state).toMatchObject({ dtcs: null, vin: "1HGCD5654VA061985" });
      }),
    );

    it.effect("goes back to disconnected when a connect is abandoned halfway", () =>
      Effect.gen(function* () {
        const reader = yield* ObdReader.ObdReader;
        const connecting = yield* reader.connect({ _tag: "simulated" }).pipe(Effect.forkChild);
        yield* reader.state.pipe(
          Stream.filter((s) => s.connection._tag === "connecting"),
          Stream.runHead,
        );
        yield* Fiber.interrupt(connecting);
        const state = yield* reader.state.pipe(Stream.runHead, Effect.flatMap(Effect.fromOption));
        expect(state.connection._tag).toBe("disconnected");
      }),
    );
  });
});

const ADAPTER = { _tag: "serial", path: "/dev/cu.OBDII" } as const;

// A Bluetooth port on macOS, which SerialPorts holds open between connections.
const bluetoothReader = (fake: ReturnType<typeof fakePorts>) =>
  ObdReader.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SerialPorts.layerWith({
          platform: "darwin",
          isBluetooth: () => Effect.succeed(true),
          openPort: fake.openPort,
        }),
        TcpSockets.layer,
        SimulatedDevice.layer,
        TrafficLog.layer,
      ),
    ),
  );

const connectFailure = Effect.gen(function* () {
  const reader = yield* ObdReader.ObdReader;
  const connecting = yield* reader.connect(ADAPTER).pipe(Effect.flip, Effect.forkChild);
  yield* TestClock.adjust(ElmClient.RESET_TIMEOUT);
  return (yield* Fiber.join(connecting)).reason;
});

describe("ObdReader on a macOS Bluetooth port", () => {
  it.effect("says the port went stale when its first open hears nothing", () => {
    const fake = fakePorts();
    return Effect.gen(function* () {
      expect(yield* connectFailure).toBe("bluetooth-stale");
      const state = yield* readerStateWhere((s) => s.connection._tag === "failed");
      expect(state.connection).toMatchObject({ reason: expect.stringContaining("pair it again") });
    }).pipe(Effect.provide(bluetoothReader(fake)));
  });

  it.effect("waits for a cold Bluetooth link before giving up on the reset", () => {
    const fake = fakePorts();
    return Effect.gen(function* () {
      const reader = yield* ObdReader.ObdReader;
      const connecting = yield* reader.connect(ADAPTER).pipe(Effect.forkChild);
      // The link came up and the adapter reset 3.1 s after the open on the real adapter.
      yield* TestClock.adjust("4 seconds");
      fake.state.answer = () => "\r>";
      if (fake.state.incoming !== undefined)
        Queue.offerUnsafe(fake.state.incoming, "ELM327 v1.5\r\r>");
      yield* Fiber.join(connecting);
      const state = yield* readerStateWhere((s) => s.connection._tag === "connected");
      expect(state.connection).toMatchObject({ adapter: "ELM327 v1.5" });
    }).pipe(Effect.provide(bluetoothReader(fake)));
  });

  it.effect("calls a garbled reply on a first open no-adapter", () => {
    const fake = fakePorts(() => "\u0000\u00ff");
    return connectFailure.pipe(
      Effect.map((reason) => expect(reason).toBe("no-adapter")),
      Effect.provide(bluetoothReader(fake)),
    );
  });

  it.effect("calls silence on a reused port no-adapter", () => {
    const fake = fakePorts((written) => (written === "ATZ\r" ? "ELM327 v1.5\r\r>" : "\r>"));
    return Effect.gen(function* () {
      const reader = yield* ObdReader.ObdReader;
      yield* reader.connect(ADAPTER);
      yield* reader.disconnect;
      fake.state.answer = () => undefined;
      expect(yield* connectFailure).toBe("no-adapter");
      expect(fake.state.events).toEqual(["open"]);
    }).pipe(Effect.provide(bluetoothReader(fake)));
  });
});
