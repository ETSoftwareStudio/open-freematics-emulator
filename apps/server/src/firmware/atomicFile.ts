import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/**
 * Writes a sibling temp file, then renames it over `file`, so readers (and a restart) see the old
 * bytes or the new ones, never a truncated mix. The temp file is removed if the write fails.
 */
export const writeFileAtomic = Effect.fn("writeFileAtomic")(function* (
  services: { readonly fileSystem: FileSystem.FileSystem; readonly crypto: Crypto.Crypto },
  file: string,
  data: Uint8Array,
  options?: { readonly mode?: number },
) {
  const { fileSystem, crypto } = services;
  const temp = `${file}.${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.tmp`;
  yield* fileSystem.writeFile(temp, data, options).pipe(
    Effect.andThen(fileSystem.rename(temp, file)),
    Effect.onError(() => Effect.ignore(fileSystem.remove(temp, { force: true }))),
  );
});
