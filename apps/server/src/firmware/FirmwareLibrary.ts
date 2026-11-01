import {
  FirmwareImageError,
  LibraryImageName,
  VendorImportError,
  type ImportVendorFilesInput,
  type LibraryImage,
} from "@fme/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { bannerVersion, readFirmwareImage, summarizeImage } from "./firmwareImage.ts";
import * as WireKeyStore from "./WireKeyStore.ts";

const DIRECTORY = "firmware";

interface Entry {
  readonly info: LibraryImage;
  readonly text: string;
}

const isLibraryName = Schema.is(LibraryImageName);
const isImageFile = (name: string) => /\.hex$/i.test(name);

const releasedFrom = (name: string) => {
  const match = /(20\d{2})(\d{2})(\d{2})/.exec(name);
  return match === null ? null : `${match[1]}-${match[2]}-${match[3]}`;
};

const entryOf = (name: string, text: string): Entry | null => {
  const image = readFirmwareImage(text);
  if (Result.isFailure(image)) return null;
  return {
    info: {
      name,
      version: bannerVersion(image.success),
      released: releasedFrom(name),
      ...summarizeImage(image.success),
    },
    text,
  };
};

// Newest release first, so the default choice is the latest image.
const newestFirst = (a: Entry, b: Entry) =>
  (b.info.released ?? "").localeCompare(a.info.released ?? "") ||
  b.info.name.localeCompare(a.info.name);

/**
 * Firmware images from the user's own Freematics folder, kept locally (never in the repo or a
 * shipped artifact). Importing the folder also stores the wire key from FirmwareUpdater.exe.
 */
export class FirmwareLibrary extends Context.Service<
  FirmwareLibrary,
  {
    /** Newest first; current list, then every change. */
    readonly images: Stream.Stream<ReadonlyArray<LibraryImage>>;
    /** The Intel HEX text of a stored image. */
    readonly read: (name: string) => Effect.Effect<string, FirmwareImageError>;
    readonly importVendorFiles: (
      input: ImportVendorFilesInput,
    ) => Effect.Effect<{ keyFound: boolean; imagesAdded: number }, VendorImportError>;
  }
>()("@fme/server/firmware/FirmwareLibrary") {}

const make = Effect.fn("FirmwareLibrary.make")(function* (options: { readonly dataDir: string }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const wireKeyStore = yield* WireKeyStore.WireKeyStore;
  const directory = path.join(options.dataDir, DIRECTORY);

  // Missing or unreadable files just leave the library shorter.
  const loadOne = (name: string) =>
    fileSystem.readFileString(path.join(directory, name)).pipe(
      Effect.map((text) => entryOf(name, text)),
      Effect.catchTags({ PlatformError: () => Effect.succeed(null) }),
    );
  const load = fileSystem.readDirectory(directory).pipe(
    Effect.catchTags({ PlatformError: () => Effect.succeed([]) }),
    Effect.flatMap((names) => Effect.forEach(names.filter(isLibraryName), loadOne)),
    Effect.map((entries) => entries.filter((entry) => entry !== null).sort(newestFirst)),
  );

  const entries = yield* SubscriptionRef.make<ReadonlyArray<Entry>>(yield* load);
  const lock = yield* Semaphore.make(1);

  const read = Effect.fn("FirmwareLibrary.read")(function* (name: string) {
    const entry = (yield* SubscriptionRef.get(entries)).find((item) => item.info.name === name);
    if (entry === undefined) {
      return yield* new FirmwareImageError({ reason: "notInLibrary", line: null });
    }
    return entry.text;
  });

  const findKey = Effect.fn("FirmwareLibrary.findKey")(function* (
    files: ImportVendorFilesInput["files"],
  ) {
    for (const file of files) {
      if (isImageFile(file.name)) continue;
      const found = yield* wireKeyStore.importBinary({ binary: file.bytes }).pipe(
        Effect.as(true),
        Effect.catchTags({
          WireKeyError: (error) =>
            error.reason === "notFound"
              ? Effect.succeed(false)
              : Effect.fail(new VendorImportError({ reason: "persist" })),
        }),
      );
      if (found) return true;
    }
    return false;
  });

  const importVendorFiles = Effect.fn("FirmwareLibrary.importVendorFiles")(function* (
    input: ImportVendorFilesInput,
  ) {
    const keyFound = yield* findKey(input.files);
    if (!keyFound && (yield* wireKeyStore.read) === null) {
      return yield* new VendorImportError({ reason: "noKey" });
    }
    const added = input.files.flatMap((file) => {
      const name = path.basename(file.name);
      if (!isImageFile(name) || !isLibraryName(name)) return [];
      const entry = entryOf(name, new TextDecoder().decode(file.bytes));
      return entry === null ? [] : [entry];
    });
    yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.andThen(
        Effect.forEach(
          added,
          (entry) => fileSystem.writeFileString(path.join(directory, entry.info.name), entry.text),
          { discard: true },
        ),
      ),
      Effect.mapError(() => new VendorImportError({ reason: "persist" })),
    );
    const names = new Set(added.map((entry) => entry.info.name));
    yield* SubscriptionRef.update(entries, (current) =>
      [...current.filter((entry) => !names.has(entry.info.name)), ...added].sort(newestFirst),
    );
    return { keyFound, imagesAdded: added.length };
  }, lock.withPermit);

  return FirmwareLibrary.of({
    images: SubscriptionRef.changes(entries).pipe(
      Stream.map((list) => list.map((entry) => entry.info)),
    ),
    read,
    importVendorFiles,
  });
});

export const layer = (options: { readonly dataDir: string }) =>
  Layer.effect(FirmwareLibrary, make(options));
