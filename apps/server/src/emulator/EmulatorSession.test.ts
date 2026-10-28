import type { DtcCode, EmulatorState, PidId } from "@fme/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import * as EmulatorSession from "./EmulatorSession.ts";

const TestLayer = EmulatorSession.layer.pipe(
  Layer.provideMerge(SimulatedDevice.layer),
  Layer.provide(SerialPorts.layer),
  Layer.provide(TrafficLog.layer),
);

const stateOf = Effect.gen(function* () {
  const session = yield* EmulatorSession.EmulatorSession;
  const [state] = yield* session.state.pipe(Stream.take(1), Stream.runCollect);
  return state as EmulatorState;
});

describe("EmulatorSession", () => {
  it.layer(TestLayer)((it) => {
    it.effect("pushes the stored state on connect and reports the device", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const { firmware } = yield* SimulatedDevice.SimulatedDevice;
        yield* session.setPid("010C" as PidId, 3000);
        yield* session.setIgnition(false);
        yield* session.connect({ _tag: "simulated" });

        const state = yield* stateOf;
        expect(state.connection).toMatchObject({
          _tag: "connected",
          device: { banner: SimulatedDevice.SIMULATED_BANNER },
        });
        expect(state.vin).toBe("1HGCD5654VA061985");
        expect(state.calibrationId).toBeNull();
        expect(firmware.ignition).toBe(false);
        expect(firmware.handle("ATGET 010C")).toBe("010C=2E E0 \r");
        expect(firmware.handle("ATGET 0101")).toBe("0101=00 07 FF 00 \r");
      }),
    );

    it.effect("sends PID changes as raw SAE bytes, clamped to range", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const { firmware } = yield* SimulatedDevice.SimulatedDevice;
        yield* session.setPid("0111" as PidId, 100);
        yield* session.setPid("010E" as PidId, -20);
        yield* session.setPid("010D" as PidId, 999);
        expect(firmware.handle("ATGET 0111")).toBe("0111=FF \r");
        expect(firmware.handle("ATGET 010E")).toBe("010E=58 \r");
        expect((yield* stateOf).pids["010D" as PidId]).toBe(255);
      }),
    );

    it.effect("keeps the MIL and stored-code count in step with Mode 03", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const { firmware } = yield* SimulatedDevice.SimulatedDevice;
        yield* session.setDtcs("03", ["P0105", "P0300"] as Array<DtcCode>);
        expect(firmware.storedDtcs).toEqual(["P0105", "P0300"]);
        expect(firmware.handle("ATGET 0101")).toBe("0101=82 07 FF 00 \r");
        yield* session.setDtcs("03", []);
        expect(firmware.storedDtcs).toEqual([]);
        expect(firmware.handle("ATGET 0101")).toBe("0101=00 07 FF 00 \r");
      }),
    );

    it.effect("surfaces commands the firmware rejects without changing state", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const error = yield* session.setDtcs("07", ["P0300"] as Array<DtcCode>).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "EmulatorCommandError", reason: "rejected" });
        expect((yield* stateOf).dtcs["07"]).toEqual([]);
      }),
    );

    it.effect("passes raw console commands through", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        expect(yield* session.sendRaw("ATACC1")).toEqual(["OK"]);
        expect(yield* session.sendRaw("ATGET 0120")).toEqual(["0120=FF FF FF FF"]);
        const reset = yield* session.sendRaw("ATR");
        expect(reset[0]).toBe("System Restarting...");
      }),
    );

    it.effect("stops talking to the device after disconnect", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        yield* session.disconnect;
        expect((yield* stateOf).connection._tag).toBe("disconnected");
        const error = yield* session.sendRaw("ATZ").pipe(Effect.flip);
        expect(error._tag).toBe("EmulatorNotConnectedError");
      }),
    );
  });
});
