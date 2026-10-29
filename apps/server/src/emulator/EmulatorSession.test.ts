import type { DtcCode, EmulatorState, PidId, Preset, PresetId } from "@fme/contracts";
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
  Layer.provideMerge(TrafficLog.layer),
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
          // V1.2 rejects pending/permanent codes and CALID; the probe must leave no codes behind.
          capabilities: { dtcModes: ["03"], calibrationId: false },
        });
        expect(firmware.storedDtcs).toEqual([]);
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

    it.effect("clears codes and the counters a scan tool's Mode 04 resets", () =>
      Effect.gen(function* () {
        const session = yield* EmulatorSession.EmulatorSession;
        const { firmware } = yield* SimulatedDevice.SimulatedDevice;
        yield* session.setDtcs("03", ["P0420"] as Array<DtcCode>);
        yield* session.setPid("0121" as PidId, 120);
        yield* session.setPid("0131" as PidId, 500);
        yield* session.clearDtcs;
        const state = yield* stateOf;
        expect(state.dtcs["03"]).toEqual([]);
        expect(state.pids["0121" as PidId]).toBe(0);
        expect(state.pids["0131" as PidId]).toBe(0);
        expect(firmware.handle("ATGET 0131")).toBe("0131=00 00 \r");
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

const testPreset = (pids: Record<string, number>): Preset => ({
  id: "user:test-drive" as PresetId,
  name: "Test drive",
  builtIn: false,
  pids: pids as Record<PidId, number>,
});

describe("EmulatorSession.applyPreset", () => {
  it.effect("sends the preset's PIDs in order and keeps it as the last preset after edits", () =>
    Effect.gen(function* () {
      const session = yield* EmulatorSession.EmulatorSession;
      const traffic = yield* TrafficLog.TrafficLog;
      yield* session.connect({ _tag: "simulated" });
      yield* session.applyPreset(testPreset({ "010C": 3100, "010D": 88 }));

      const sent = yield* traffic.stream.pipe(
        Stream.takeUntil((entry) => entry.text === "ATSET 010D=0x58"),
        Stream.filter((entry) => entry.direction === "tx" && entry.text.startsWith("ATSET")),
        Stream.runCollect,
      );
      expect(sent.slice(-2).map((entry) => entry.text)).toEqual([
        "ATSET 010C=0x30,0x70",
        "ATSET 010D=0x58",
      ]);
      expect((yield* stateOf).lastPreset).toEqual({ id: "user:test-drive", name: "Test drive" });

      yield* session.setPid("010C" as PidId, 2000);
      const edited = yield* stateOf;
      expect(edited.pids["010C" as PidId]).toBe(2000);
      expect(edited.lastPreset).toEqual({ id: "user:test-drive", name: "Test drive" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stages the preset while disconnected and pushes it on connect", () =>
    Effect.gen(function* () {
      const session = yield* EmulatorSession.EmulatorSession;
      const { firmware } = yield* SimulatedDevice.SimulatedDevice;
      yield* session.applyPreset(testPreset({ "010C": 3100, "0110": 99.8 }));
      const staged = yield* stateOf;
      expect(staged.connection._tag).toBe("disconnected");
      expect(staged.pids["010C" as PidId]).toBe(3100);
      expect(staged.lastPreset?.id).toBe("user:test-drive");
      expect(firmware.pids.has("010C")).toBe(false);

      yield* session.connect({ _tag: "simulated" });
      expect(firmware.handle("ATGET 010C")).toBe("010C=30 70 \r");
      expect(firmware.handle("ATGET 0110")).toBe("0110=26 FC \r");
      expect((yield* stateOf).lastPreset?.id).toBe("user:test-drive");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps the PIDs the device took when a later one is rejected", () =>
    Effect.gen(function* () {
      const session = yield* EmulatorSession.EmulatorSession;
      yield* session.connect({ _tag: "simulated" });
      // The firmware rejects negative decimal values, which uncatalogued PIDs are sent as.
      const error = yield* session
        .applyPreset(testPreset({ "010C": 3100, "01FF": -5, "010D": 88 }))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "EmulatorCommandError", reason: "rejected" });
      const state = yield* stateOf;
      expect(state.pids["010C" as PidId]).toBe(3100);
      expect(state.pids["010D" as PidId]).toBe(50);
      expect(state.lastPreset).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});
