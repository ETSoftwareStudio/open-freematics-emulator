import { type ImportWireKeyInput, WireKeyError, type WireKeyStatus } from "@fme/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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

const make = Effect.fn("WireKeyStore.make")(function* (options: { readonly dataDir: string }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(options.dataDir, FILE_NAME);

  // A missing or unreadable file is simply "no key stored"; a wrong size is ignored too.
  const load = fileSystem.readFile(file).pipe(
    Effect.map((bytes) => (bytes.length === WIRE_KEY_LENGTH ? bytes : null)),
    Effect.catchTags({ PlatformError: () => Effect.succeed(null) }),
  );

  const key = yield* SubscriptionRef.make<Uint8Array | null>(yield* load);

  const importBinary = Effect.fn("WireKeyStore.importBinary")(function* (
    input: ImportWireKeyInput,
  ) {
    const found = findWireKey(input.binary);
    if (found === null) return yield* new WireKeyError({ reason: "notFound" });
    yield* fileSystem.makeDirectory(options.dataDir, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFile(file, found, { mode: 0o600 })),
      Effect.mapError(() => new WireKeyError({ reason: "persist" })),
    );
    yield* SubscriptionRef.set(key, found);
    return statusOf(found);
  });

  const forget = fileSystem.remove(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
    }),
    Effect.mapError(() => new WireKeyError({ reason: "persist" })),
    Effect.andThen(SubscriptionRef.set(key, null)),
  );

  return WireKeyStore.of({
    changes: SubscriptionRef.changes(key).pipe(Stream.map(statusOf)),
    read: SubscriptionRef.get(key),
    importBinary,
    forget,
  });
});

export const layer = (options: { readonly dataDir: string }) =>
  Layer.effect(WireKeyStore, make(options));
