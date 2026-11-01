import { VendorDownloadError, type VendorImportError } from "@fme/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FirmwareLibrary from "./FirmwareLibrary.ts";

interface Package {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  readonly files: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
}

const officialPackage: Package = {
  url: "https://freematics.com/dl/FreematicsEmulatorGUI-1.2.exe",
  size: 43_041_876,
  sha256: "b63577912c29276d0abe21f07d7701b4f3bd368a4d0cb52333ebdbddbd76f647",
  files: [
    {
      name: "FirmwareUpdater.exe",
      sha256: "9b3de17f9ea6bb36bba69819b1d8ff38dbb86bc28d5ed667174208143a453d89",
    },
    {
      name: "firmware/Firmware_MK2_20240328.hex",
      sha256: "43532d178e08af803af6250157415cfd4180e54512f3871234dd164196c4aaf8",
    },
    {
      name: "firmware/Firmware_MK2_20241007.hex",
      sha256: "bda099dc0f8625832f34b390631103ec104c62c96fe85e764e0fe66dfb1c5fb7",
    },
    {
      name: "firmware/Firmware_MK2_20250311.hex",
      sha256: "e42589eaabbe81fc71ba282c389abd8fc721e11c1646e981aab8e76cc8f663e8",
    },
  ],
};

export class VendorPackage extends Context.Service<
  VendorPackage,
  {
    readonly download: Effect.Effect<
      { keyFound: boolean; imagesAdded: number },
      VendorDownloadError | VendorImportError
    >;
  }
>()("@fme/server/firmware/VendorPackage") {}

const make = Effect.fn("VendorPackage.make")(function* (descriptor: Package) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const library = yield* FirmwareLibrary.FirmwareLibrary;
  const lock = yield* Semaphore.make(1);

  const digest = Effect.fn("VendorPackage.digest")(function* (bytes: Uint8Array) {
    return Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
  });

  const download = Effect.gen(function* () {
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const response = yield* client.get(descriptor.url);
    const archive = new Uint8Array(descriptor.size);
    const length = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => 0,
        (offset, chunk) => {
          if (offset + chunk.length > archive.length) {
            return Effect.fail(new VendorDownloadError({ reason: "checksum" }));
          }
          archive.set(chunk, offset);
          return Effect.succeed(offset + chunk.length);
        },
      ),
    );
    if (length !== descriptor.size || (yield* digest(archive)) !== descriptor.sha256) {
      return yield* new VendorDownloadError({ reason: "checksum" });
    }
    const archivePath = path.join(directory, "vendor.exe");
    yield* fileSystem.writeFile(archivePath, archive);
    const extractorUrl = yield* Effect.try({
      try: () => new URL(import.meta.resolve("7z-wasm/bin/cli")),
      catch: () => new VendorDownloadError({ reason: "extract" }),
    });
    const extractor = yield* path.fromFileUrl(extractorUrl);
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(
        process.execPath,
        [extractor, "x", "-y", "-bd", "vendor.exe", ...descriptor.files.map((file) => file.name)],
        {
          cwd: directory,
          env: { ELECTRON_RUN_AS_NODE: "1" },
          extendEnv: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      ),
    );
    if (exitCode !== 0) return yield* new VendorDownloadError({ reason: "extract" });
    const files = yield* Effect.forEach(
      descriptor.files,
      Effect.fn("VendorPackage.readFile")(function* (file) {
        const bytes = yield* fileSystem.readFile(path.join(directory, file.name));
        if ((yield* digest(bytes)) !== file.sha256) {
          return yield* new VendorDownloadError({ reason: "extract" });
        }
        return { name: path.basename(file.name), bytes };
      }),
    );
    return yield* library.importVendorFiles({ files });
  }).pipe(
    Effect.catchTags({
      HttpClientError: () => Effect.fail(new VendorDownloadError({ reason: "network" })),
      PlatformError: () => Effect.fail(new VendorDownloadError({ reason: "extract" })),
      BadArgument: () => Effect.fail(new VendorDownloadError({ reason: "extract" })),
    }),
    Effect.timeoutOrElse({
      duration: "3 minutes",
      orElse: () => Effect.fail(new VendorDownloadError({ reason: "timeout" })),
    }),
    Effect.scoped,
    lock.withPermitsIfAvailable(1),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new VendorDownloadError({ reason: "busy" })),
        onSome: Effect.succeed,
      }),
    ),
  );
  return VendorPackage.of({ download });
});

export const layer = (descriptor: Package = officialPackage) =>
  Layer.effect(VendorPackage, make(descriptor));
