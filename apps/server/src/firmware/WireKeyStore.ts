import { type ImportWireKeyInput, WireKeyError, type WireKeyStatus } from "@fme/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { writeFileAtomic } from "./atomicFile.ts";
import { findWireKey, WIRE_KEY_LENGTH, wireKeyFingerprint } from "./bootloaderFrame.ts";

const FILE_NAME = "wire-key.bin";

const statusOf = (key: Uint8Array | null): WireKeyStatus =>
  key === null ? { _tag: "absent" } : { _tag: "present", fingerprint: wireKeyFingerprint(key) };

/**
 * Holds the MK2 wire key, extracted from the user's own copy of the vendor tool and saved locally
 * (never in the repo, never shipped). Updates read it from here so the key is entered once.
 */
export class WireKeyStore extends Context.Service<
  WireKeyStore,
  {
    /** Current status, then every change. The key itself never leaves the server. */
    readonly changes: Stream.Stream<WireKeyStatus>;
    /** The stored 16-byte key, or `null` when none is stored. */
    readonly read: Effect.Effect<Uint8Array | null>;
    /** Scans the vendor binary for the key, saves it, and returns the new status. */
    readonly importBinary: (
      input: ImportWireKeyInput,
    ) => Effect.Effect<WireKeyStatus, WireKeyError>;
    readonly forget: Effect.Effect<void, WireKeyError>;
  }
>()("@fme/server/firmware/WireKeyStore") {}

interface Options {
  readonly dataDir: string;
  /** Tests plant a stand-in key; the vendor key's hash is the default. */
  readonly keySha256?: string;
}

const make = Effect.fn("WireKeyStore.make")(function* (options: Options) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const file = path.join(options.dataDir, FILE_NAME);

  // A missing or unreadable file is simply "no key stored"; a wrong size is ignored too.
  const load = fileSystem.readFile(file).pipe(
    Effect.map((bytes) => (bytes.length === WIRE_KEY_LENGTH ? bytes : null)),
    Effect.catchTags({ PlatformError: () => Effect.succeed(null) }),
  );

  const key = yield* SubscriptionRef.make<Uint8Array | null>(yield* load);
  // One lock over both mutations, and each commit (disk, then memory) is uninterruptible, so the
  // file and the in-memory key always agree.
  const lock = yield* Semaphore.make(1);
  const commit = <E>(persist: Effect.Effect<void, E>, next: Uint8Array | null) =>
    persist.pipe(
      Effect.mapError(() => new WireKeyError({ reason: "persist" })),
      Effect.andThen(SubscriptionRef.set(key, next)),
      Effect.uninterruptible,
      lock.withPermit,
    );

  const importBinary = Effect.fn("WireKeyStore.importBinary")(function* (
    input: ImportWireKeyInput,
  ) {
    const found = yield* findWireKey(input.binary, options.keySha256);
    if (found === null) return yield* new WireKeyError({ reason: "notFound" });
    yield* commit(
      fileSystem
        .makeDirectory(options.dataDir, { recursive: true })
        .pipe(
          Effect.andThen(writeFileAtomic({ fileSystem, crypto }, file, found, { mode: 0o600 })),
        ),
      found,
    );
    return statusOf(found);
  });

  const forget = commit(
    fileSystem.remove(file).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
      }),
    ),
    null,
  );

  return WireKeyStore.of({
    changes: SubscriptionRef.changes(key).pipe(Stream.map(statusOf)),
    read: SubscriptionRef.get(key),
    importBinary,
    forget,
  });
});

export const layer = (options: Options) => Layer.effect(WireKeyStore, make(options));
