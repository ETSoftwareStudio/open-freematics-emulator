import type { DtcCode, PidId, ReaderState } from "@fme/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as TcpSockets from "../device/TcpSockets.ts";
import * as EmulatorSession from "../emulator/EmulatorSession.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import * as ObdReader from "./ObdReader.ts";

const TestLayer = Layer.mergeAll(EmulatorSession.layer, ObdReader.layer).pipe(
  Layer.provideMerge(SimulatedDevice.layer),
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
        expect(state.vin).toBe("1HGCD5654VA061985");
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

    it.effect("forgets the previous connection's results when reconnecting", () =>
      Effect.gen(function* () {
        const reader = yield* ObdReader.ObdReader;
        yield* reader.readDtcs;
        yield* reader.readVin;
        yield* reader.disconnect;
        yield* reader.connect({ _tag: "simulated" });
        const state = yield* reader.state.pipe(Stream.runHead, Effect.flatMap(Effect.fromOption));
        expect(state).toMatchObject({ dtcs: null, vin: null });
      }),
    );
  });
});
