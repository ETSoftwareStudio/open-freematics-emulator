import {
  PresetId,
  PresetName,
  PresetNotFoundError,
  PresetPersistError,
  PresetPids,
  PresetReadOnlyError,
  type EmulatorOperationError,
  type PidId,
  type Preset,
  type PresetChangeError,
  type SavePresetInput,
} from "@fme/contracts";
import { clampPidValue, findPid } from "@fme/shared/pids";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EmulatorSession from "../emulator/EmulatorSession.ts";
import { BUILT_IN_PRESETS } from "./builtInPresets.ts";

const FILE_NAME = "presets.json";

const StoredPreset = Schema.Struct({ id: PresetId, name: PresetName, pids: PresetPids });
type StoredPreset = typeof StoredPreset.Type;

const PresetFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), presets: Schema.Array(StoredPreset) }),
  { space: 2 },
);
const decodePresetFile = Schema.decodeEffect(PresetFile);
const encodePresetFile = Schema.encodeEffect(PresetFile);

export class PresetStore extends Context.Service<
  PresetStore,
  {
    /** Built-ins, then user presets in the order they were made. Current list first, then every change. */
    readonly presets: Stream.Stream<ReadonlyArray<Preset>>;
    readonly apply: (
      id: PresetId,
    ) => Effect.Effect<void, PresetNotFoundError | EmulatorOperationError>;
    /** Creates a user preset without `id`, or renames and overwrites the one with it. */
    readonly save: (input: SavePresetInput) => Effect.Effect<Preset, PresetChangeError>;
    readonly delete: (id: PresetId) => Effect.Effect<void, PresetChangeError>;
  }
>()("@fme/server/presets/PresetStore") {}

const isBuiltIn = (id: PresetId) => id.startsWith("builtin:");

const withBuiltIns = (users: ReadonlyArray<StoredPreset>): ReadonlyArray<Preset> =>
  BUILT_IN_PRESETS.concat(users.map((stored) => ({ ...stored, builtIn: false })));

const clampPids = (pids: PresetPids): PresetPids =>
  Object.fromEntries(
    Object.entries(pids).map(([pid, value]) => {
      const definition = findPid(pid);
      return [pid, definition === undefined ? value : clampPidValue(definition, value)];
    }),
  ) as Record<PidId, number>;

const make = Effect.fn("PresetStore.make")(function* (options: { readonly dataDir: string }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const session = yield* EmulatorSession.EmulatorSession;
  const file = path.join(options.dataDir, FILE_NAME);

  // A missing file is a first run. An unreadable one must not stop the server, and a corrupt
  // one is moved aside so the next save doesn't destroy what the user may want back.
  const load = fileSystem.readFileString(file).pipe(
    Effect.flatMap(decodePresetFile),
    Effect.map((contents) => contents.presets.filter((preset) => !isBuiltIn(preset.id))),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed([])
          : Effect.logWarning("Could not read saved presets; starting without them.").pipe(
              Effect.annotateLogs({ path: file, reason: error.reason._tag }),
              Effect.as([]),
            ),
      SchemaError: () =>
        fileSystem
          .rename(file, `${file}.corrupt`)
          .pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.logWarning("Saved presets are corrupt; moved them aside.").pipe(
                Effect.annotateLogs({ path: file, movedTo: `${file}.corrupt` }),
              ),
            ),
            Effect.as([]),
          ),
    }),
  );

  const userPresets = yield* SubscriptionRef.make<ReadonlyArray<StoredPreset>>(yield* load);
  // Saves and deletes run one at a time so each writes the list the previous one left.
  const lock = yield* Semaphore.make(1);

  const persist = Effect.fn("PresetStore.persist")(
    function* (presets: ReadonlyArray<StoredPreset>) {
      // Written beside the file, then renamed over it, so a crash never leaves half a file. A
      // failed write or rename removes the temp file.
      const temporary = `${file}.${yield* crypto.randomUUIDv4()}.tmp`;
      const contents = yield* encodePresetFile({ version: 1, presets });
      yield* fileSystem.makeDirectory(options.dataDir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, `${contents}\n`).pipe(
        Effect.andThen(fileSystem.rename(temporary, file)),
        Effect.onError(() => Effect.ignore(fileSystem.remove(temporary, { force: true }))),
      );
    },
    Effect.mapError((cause) => new PresetPersistError({ path: file, cause })),
  );

  const commit = (presets: ReadonlyArray<StoredPreset>) =>
    persist(presets).pipe(Effect.andThen(SubscriptionRef.set(userPresets, presets)));

  const all = SubscriptionRef.get(userPresets).pipe(Effect.map(withBuiltIns));

  const apply = Effect.fn("PresetStore.apply")(function* (id: PresetId) {
    yield* Effect.annotateCurrentSpan("preset", id);
    const preset = (yield* all).find((candidate) => candidate.id === id);
    if (preset === undefined) return yield* new PresetNotFoundError({ id });
    yield* session.applyPreset(preset);
  });

  const save = Effect.fn("PresetStore.save")(function* (input: SavePresetInput) {
    const current = yield* SubscriptionRef.get(userPresets);
    const { id } = input;
    if (id === undefined) {
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const created = {
        id: `user:${uuid}` as PresetId,
        name: input.name,
        pids: clampPids(input.pids),
      };
      yield* commit([...current, created]);
      return { ...created, builtIn: false };
    }
    yield* Effect.annotateCurrentSpan("preset", id);
    if (isBuiltIn(id)) return yield* new PresetReadOnlyError({ id, operation: "save" });
    if (!current.some((preset) => preset.id === id)) {
      return yield* new PresetNotFoundError({ id });
    }
    const updated = { id, name: input.name, pids: clampPids(input.pids) };
    yield* commit(current.map((preset) => (preset.id === id ? updated : preset)));
    return { ...updated, builtIn: false };
  }, lock.withPermit);

  const remove = Effect.fn("PresetStore.delete")(function* (id: PresetId) {
    yield* Effect.annotateCurrentSpan("preset", id);
    if (isBuiltIn(id)) return yield* new PresetReadOnlyError({ id, operation: "delete" });
    const current = yield* SubscriptionRef.get(userPresets);
    if (!current.some((preset) => preset.id === id)) {
      return yield* new PresetNotFoundError({ id });
    }
    yield* commit(current.filter((preset) => preset.id !== id));
  }, lock.withPermit);

  return PresetStore.of({
    presets: SubscriptionRef.changes(userPresets).pipe(Stream.map(withBuiltIns)),
    apply,
    save,
    delete: remove,
  });
});

export const layer = (options: { readonly dataDir: string }) =>
  Layer.effect(PresetStore, make(options));
