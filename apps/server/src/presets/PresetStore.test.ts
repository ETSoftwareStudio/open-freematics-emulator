import type { PidId, Preset, PresetId } from "@fme/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as EmulatorSession from "../emulator/EmulatorSession.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import { BUILT_IN_PRESETS } from "./builtInPresets.ts";
import * as PresetStore from "./PresetStore.ts";

const storeLayer = (dataDir: string) =>
  PresetStore.layer({ dataDir }).pipe(
    Layer.provideMerge(EmulatorSession.layer),
    Layer.provide(SimulatedDevice.layer),
    Layer.provide(SerialPorts.layer),
    Layer.provide(TrafficLog.layer),
  );

const presetsNow = Effect.gen(function* () {
  const store = yield* PresetStore.PresetStore;
  const [presets] = yield* store.presets.pipe(Stream.take(1), Stream.runCollect);
  return presets as ReadonlyArray<Preset>;
});

const tempDataDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A directory that doesn't exist yet, as on a first run.
  return path.join(yield* fileSystem.makeTempDirectoryScoped(), "data");
});

const freshStore = Layer.unwrap(Effect.map(tempDataDir, storeLayer)).pipe(
  Layer.provide(NodeServices.layer),
);

const pids = (values: Record<string, number>) => values as Record<PidId, number>;
const cruise = BUILT_IN_PRESETS[1]!;

describe("PresetStore", () => {
  it.effect("saves user presets atomically and loads them after a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* tempDataDir;

      const kept = yield* Effect.gen(function* () {
        const store = yield* PresetStore.PresetStore;
        const created = yield* store.save({
          name: "Track day",
          pids: pids({ "010C": 6200.4, "010D": 300 }),
        });
        expect(created).toMatchObject({
          builtIn: false,
          name: "Track day",
          pids: { "010C": 6200, "010D": 255 },
        });
        const doomed = yield* store.save({ name: "Scratch", pids: pids({ "010C": 900 }) });
        yield* store.save({ id: created.id, name: "Track night", pids: pids({ "010C": 5000 }) });
        yield* store.delete(doomed.id);
        return created.id;
      }).pipe(Effect.provide(storeLayer(dataDir)));

      const reloaded = yield* presetsNow.pipe(Effect.provide(storeLayer(dataDir)));
      expect(reloaded.slice(0, BUILT_IN_PRESETS.length)).toEqual(BUILT_IN_PRESETS);
      expect(reloaded.slice(BUILT_IN_PRESETS.length)).toEqual([
        { id: kept, name: "Track night", builtIn: false, pids: { "010C": 5000 } },
      ]);
      expect(yield* fileSystem.readDirectory(dataDir)).toEqual(["presets.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts from the built-ins when the file is corrupt, and keeps the old file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = yield* tempDataDir;
      yield* fileSystem.makeDirectory(dataDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(dataDir, "presets.json"), '{"version": 1, "pre');

      yield* Effect.gen(function* () {
        const store = yield* PresetStore.PresetStore;
        expect(yield* presetsNow).toEqual(BUILT_IN_PRESETS);
        yield* store.save({ name: "Fresh", pids: pids({ "010C": 800 }) });
      }).pipe(Effect.provide(storeLayer(dataDir)));

      expect((yield* fileSystem.readDirectory(dataDir)).toSorted()).toEqual([
        "presets.json",
        "presets.json.corrupt",
      ]);
      expect(yield* fileSystem.readFileString(path.join(dataDir, "presets.json.corrupt"))).toBe(
        '{"version": 1, "pre',
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects changes to built-ins and to presets that don't exist", () =>
    Effect.gen(function* () {
      const store = yield* PresetStore.PresetStore;
      const saveError = yield* store
        .save({ id: cruise.id, name: "My cruise", pids: cruise.pids })
        .pipe(Effect.flip);
      expect(saveError).toMatchObject({
        _tag: "PresetReadOnlyError",
        id: cruise.id,
        operation: "save",
      });
      const deleteError = yield* store.delete(cruise.id).pipe(Effect.flip);
      expect(deleteError).toMatchObject({ _tag: "PresetReadOnlyError", operation: "delete" });
      const missing = "user:missing" as PresetId;
      expect(yield* store.delete(missing).pipe(Effect.flip)).toMatchObject({
        _tag: "PresetNotFoundError",
        id: missing,
      });
      expect(yield* store.apply(missing).pipe(Effect.flip)).toMatchObject({
        _tag: "PresetNotFoundError",
      });
      expect(yield* presetsNow).toEqual(BUILT_IN_PRESETS);
    }).pipe(Effect.provide(freshStore)),
  );

  it.effect("applies a preset by id and records it in the emulator state", () =>
    Effect.gen(function* () {
      const store = yield* PresetStore.PresetStore;
      const session = yield* EmulatorSession.EmulatorSession;
      yield* store.apply(cruise.id);
      const [state] = yield* session.state.pipe(Stream.take(1), Stream.runCollect);
      expect(state?.lastPreset).toEqual({ id: "builtin:cruise", name: "Cruise" });
      expect(state?.pids).toMatchObject(cruise.pids);
    }).pipe(Effect.provide(freshStore)),
  );
});
