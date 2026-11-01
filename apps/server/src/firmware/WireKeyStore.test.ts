import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { wireKeyFingerprint } from "./bootloaderFrame.ts";
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
});
