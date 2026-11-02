import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { wireKeyFingerprint } from "./bootloaderFrame.ts";
import { type FileSystemCall, makeGate, memoryFileSystem } from "./memoryFileSystem.ts";
import * as WireKeyStore from "./WireKeyStore.ts";

const storeLayer = (dataDir: string) =>
  WireKeyStore.layer({ dataDir }).pipe(Layer.provide(NodeServices.layer));

const tempDataDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fileSystem.makeTempDirectoryScoped(), "data");
});

const statusNow = Effect.gen(function* () {
  const store = yield* WireKeyStore.WireKeyStore;
  const [status] = yield* store.changes.pipe(Stream.take(1), Stream.runCollect);
  return status!;
});

const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");
const key = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);

const KEY_FILE = "/data/wire-key.bin";
const vendorBinary = Uint8Array.from([...new Uint8Array(300).fill(1), ...key, 2, 3]);

// A store that finds a stand-in key, over an in-memory disk that stops once at `stopAt`.
const gatedStore = (stopAt: FileSystemCall["method"], storedKey: Uint8Array | null) =>
  Effect.gen(function* () {
    const gate = yield* makeGate;
    const disk = memoryFileSystem((call) => (call.method === stopAt ? gate.pass : Effect.void));
    if (storedKey !== null) disk.files.set(KEY_FILE, storedKey);
    const layerOnDisk = () =>
      WireKeyStore.layer({ dataDir: "/data", keySha256: wireKeyFingerprint(key) }).pipe(
        Layer.provide(disk.layer),
        Layer.provide(NodeServices.layer),
      );
    // What the running store, the disk and a restarted store each say.
    const state = Effect.gen(function* () {
      const store = yield* WireKeyStore.WireKeyStore;
      const memory = yield* store.read;
      const status = (yield* statusNow)._tag;
      const onDisk = disk.files.get(KEY_FILE);
      const restarted = yield* WireKeyStore.WireKeyStore.pipe(
        Effect.flatMap((fresh) => fresh.read),
        Effect.provide(layerOnDisk()),
      );
      return {
        memory: memory === null ? null : hex(memory),
        status,
        disk: onDisk === undefined ? null : hex(onDisk),
        restarted: restarted === null ? null : hex(restarted),
      };
    });
    return { gate, layer: layerOnDisk(), state };
  });

const present = { memory: hex(key), status: "present", disk: hex(key), restarted: hex(key) };
const absent = { memory: null, status: "absent", disk: null, restarted: null };

describe("WireKeyStore", () => {
  it.effect("has no key on a fresh dir and rejects a file without the key", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      yield* Effect.gen(function* () {
        const store = yield* WireKeyStore.WireKeyStore;
        expect((yield* statusNow)._tag).toBe("absent");
        expect(yield* store.read).toBeNull();
        const noise = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
        const error = yield* Effect.flip(store.importBinary({ binary: noise }));
        expect(error.reason).toBe("notFound");
        expect((yield* statusNow)._tag).toBe("absent");
      }).pipe(Effect.provide(storeLayer(dataDir)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("loads a stored key, reports it, and forgets it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = yield* tempDataDir;
      const file = path.join(dataDir, "wire-key.bin");
      yield* fileSystem.makeDirectory(dataDir, { recursive: true });
      yield* fileSystem.writeFile(file, key);

      yield* Effect.gen(function* () {
        const store = yield* WireKeyStore.WireKeyStore;
        expect(yield* statusNow).toEqual({ _tag: "present", fingerprint: wireKeyFingerprint(key) });
        const read = yield* store.read;
        expect(read).not.toBeNull();
        expect(hex(read!)).toBe(hex(key));

        yield* store.forget;
        expect((yield* statusNow)._tag).toBe("absent");
        expect(yield* store.read).toBeNull();
        expect(yield* fileSystem.exists(file)).toBe(false);
      }).pipe(Effect.provide(storeLayer(dataDir)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a forget during an import wins, on disk and in memory", () =>
    Effect.gen(function* () {
      // Stops the import with its key file in place but not yet in memory.
      const { gate, layer, state } = yield* gatedStore("rename", null);
      yield* Effect.gen(function* () {
        const store = yield* WireKeyStore.WireKeyStore;
        const importing = yield* Effect.forkChild(store.importBinary({ binary: vendorBinary }), {
          startImmediately: true,
        });
        yield* gate.entered;
        const forgetting = yield* Effect.forkChild(store.forget, { startImmediately: true });
        yield* gate.open;
        yield* Fiber.join(importing);
        yield* Fiber.join(forgetting);
        expect(yield* state).toEqual(absent);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("an import during a forget wins, on disk and in memory", () =>
    Effect.gen(function* () {
      const { gate, layer, state } = yield* gatedStore("remove", key);
      yield* Effect.gen(function* () {
        const store = yield* WireKeyStore.WireKeyStore;
        const forgetting = yield* Effect.forkChild(store.forget, { startImmediately: true });
        yield* gate.entered;
        const importing = yield* Effect.forkChild(store.importBinary({ binary: vendorBinary }), {
          startImmediately: true,
        });
        yield* gate.open;
        yield* Fiber.join(forgetting);
        yield* Fiber.join(importing);
        expect(yield* state).toEqual(present);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("finishes a started import or forget when interrupted", () =>
    Effect.gen(function* () {
      for (const [stopAt, storedKey, mutate, expected] of [
        ["rename", null, "import", present],
        ["remove", key, "forget", absent],
      ] as const) {
        const { gate, layer, state } = yield* gatedStore(stopAt, storedKey);
        yield* Effect.gen(function* () {
          const store = yield* WireKeyStore.WireKeyStore;
          const running = yield* Effect.forkChild(
            mutate === "import" ? store.importBinary({ binary: vendorBinary }) : store.forget,
            { startImmediately: true },
          );
          yield* gate.entered;
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(running), {
            startImmediately: true,
          });
          yield* gate.open;
          yield* Fiber.join(interrupting);
          expect(yield* state).toEqual(expected);
        }).pipe(Effect.provide(layer));
      }
    }),
  );
});
