import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as FirmwareLibrary from "./FirmwareLibrary.ts";
import { APPLICATION_BASE } from "./flashPlan.ts";
import { type FileSystemCall, makeGate, memoryFileSystem } from "./memoryFileSystem.ts";
import * as WireKeyStore from "./WireKeyStore.ts";

const record = (type: number, offset: number, data: ReadonlyArray<number> = []) => {
  const fields = [data.length, offset >> 8, offset & 0xff, type, ...data];
  const sum = fields.reduce((acc, byte) => acc + byte, 0);
  return `:${Buffer.from([...fields, -sum & 0xff]).toString("hex")}`;
};

const hexFile = (address: number, data: Uint8Array) => {
  const lines = [record(0x04, 0, [address >>> 24, (address >>> 16) & 0xff])];
  for (let i = 0; i < data.length; i += 16) {
    lines.push(record(0x00, (address + i) & 0xffff, [...data.subarray(i, i + 16)]));
  }
  return [...lines, record(0x01, 0)].join("\n");
};

const image = (banner: string) =>
  new TextEncoder().encode(
    hexFile(
      APPLICATION_BASE,
      Uint8Array.from([...Buffer.from(`xx OBD-II EMULATOR ${banner}\0`), 1, 2]),
    ),
  );

const libraryLayer = (dataDir: string) =>
  FirmwareLibrary.layer({ dataDir }).pipe(
    Layer.provideMerge(WireKeyStore.layer({ dataDir })),
    Layer.provide(NodeServices.layer),
  );

const tempDataDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fileSystem.makeTempDirectoryScoped(), "data");
});

const plantKey = (dataDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(dataDir, { recursive: true });
    yield* fileSystem.writeFile(path.join(dataDir, "wire-key.bin"), new Uint8Array(16).fill(7));
  });

const imagesNow = Effect.gen(function* () {
  const library = yield* FirmwareLibrary.FirmwareLibrary;
  const [images] = yield* library.images.pipe(Stream.take(1), Stream.runCollect);
  return images!;
});

const OLD = "Firmware_MK2_20240328.hex";
const NEW = "Firmware_MK2_20250311.hex";
// Which test image a stored text is, by its banner version.
const versionOf = (text: string) =>
  ["1.1", "1.2", "1.3"].find((v) => new TextDecoder().decode(image(`V${v}`)) === text) ?? "?";

// A library over an in-memory disk holding a stored key and `images`, with `hook` on every call.
const memoryLibrary = (
  images: Record<string, Uint8Array>,
  hook?: (call: FileSystemCall) => Effect.Effect<void, PlatformError.PlatformError>,
) => {
  const disk = memoryFileSystem(hook);
  disk.files.set("/data/wire-key.bin", new Uint8Array(16).fill(7));
  for (const [name, bytes] of Object.entries(images))
    disk.files.set(`/data/firmware/${name}`, bytes);
  const layerOnDisk = () =>
    FirmwareLibrary.layer({ dataDir: "/data" }).pipe(
      Layer.provideMerge(WireKeyStore.layer({ dataDir: "/data" })),
      Layer.provide(disk.layer),
      Layer.provide(NodeServices.layer),
    );
  // Name and version per image: in the running list, on disk, and after a restart.
  const listed = Effect.gen(function* () {
    const library = yield* FirmwareLibrary.FirmwareLibrary;
    return yield* Effect.forEach(yield* imagesNow, (image) =>
      Effect.map(library.read(image.name), (text) => [image.name, versionOf(text)]),
    );
  });
  const state = Effect.gen(function* () {
    return {
      running: yield* listed,
      disk: [...disk.files]
        .filter(([path]) => path.startsWith("/data/firmware/"))
        .map(([path, bytes]) => [path.slice(15), versionOf(new TextDecoder().decode(bytes))])
        .sort(([a], [b]) => b!.localeCompare(a!)),
      restarted: yield* listed.pipe(Effect.provide(layerOnDisk())),
    };
  });
  return { layer: layerOnDisk(), state };
};

describe("FirmwareLibrary", () => {
  it.effect("needs a wire key from the folder or one already stored", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      yield* Effect.gen(function* () {
        const library = yield* FirmwareLibrary.FirmwareLibrary;
        const error = yield* Effect.flip(
          library.importVendorFiles({
            files: [
              { name: "FirmwareUpdater.exe", bytes: new Uint8Array(4096) },
              { name: "Firmware_MK2_20250311.hex", bytes: image("V1.3") },
            ],
          }),
        );
        expect(error.reason).toBe("noKey");
        expect(yield* imagesNow).toEqual([]);
      }).pipe(Effect.provide(libraryLayer(dataDir)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps valid images newest first, labelled, and across a restart", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      yield* plantKey(dataDir);

      yield* Effect.gen(function* () {
        const library = yield* FirmwareLibrary.FirmwareLibrary;
        const result = yield* library.importVendorFiles({
          files: [
            { name: "Firmware_MK2_20240328.hex", bytes: image("V1.3") },
            { name: "Firmware_MK2_20250311.hex", bytes: image("V1.3") },
            { name: "broken.hex", bytes: new TextEncoder().encode(":nonsense") },
            { name: "notes.txt", bytes: new TextEncoder().encode("hi") },
          ],
        });
        expect(result).toEqual({ keyFound: false, imagesAdded: 2 });
      }).pipe(Effect.provide(libraryLayer(dataDir)));

      yield* Effect.gen(function* () {
        const library = yield* FirmwareLibrary.FirmwareLibrary;
        const images = yield* imagesNow;
        expect(images.map((item) => [item.name, item.version, item.released])).toEqual([
          ["Firmware_MK2_20250311.hex", "1.3", "2025-03-11"],
          ["Firmware_MK2_20240328.hex", "1.3", "2024-03-28"],
        ]);
        expect(images[0]!.start).toBe(APPLICATION_BASE);
        expect(yield* library.read("Firmware_MK2_20250311.hex")).toBe(
          new TextDecoder().decode(image("V1.3")),
        );
        const missing = yield* Effect.flip(library.read("nope.hex"));
        expect(missing.reason).toBe("notInLibrary");
      }).pipe(Effect.provide(libraryLayer(dataDir)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses two different images that would share a file name", () =>
    Effect.gen(function* () {
      const { layer, state } = memoryLibrary({});
      yield* Effect.gen(function* () {
        const library = yield* FirmwareLibrary.FirmwareLibrary;
        const error = yield* Effect.flip(
          library.importVendorFiles({
            files: [
              { name: NEW, bytes: image("V1.3") },
              { name: NEW.toLowerCase(), bytes: image("V1.2") },
            ],
          }),
        );
        expect(error.reason).toBe("duplicateName");
        expect(yield* state).toEqual({ running: [], disk: [], restarted: [] });

        const result = yield* library.importVendorFiles({
          files: [
            { name: NEW, bytes: image("V1.3") },
            { name: NEW, bytes: image("V1.3") },
          ],
        });
        expect(result.imagesAdded).toBe(1);
        const one = [[NEW, "1.3"]];
        expect(yield* state).toEqual({ running: one, disk: one, restarted: one });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("replaces an image whose name differs only in case, keeping one row", () =>
    Effect.gen(function* () {
      const { layer, state } = memoryLibrary({ [NEW]: image("V1.2") });
      yield* Effect.gen(function* () {
        const library = yield* FirmwareLibrary.FirmwareLibrary;
        yield* library.importVendorFiles({
          files: [{ name: NEW.toUpperCase().replace(".HEX", ".hex"), bytes: image("V1.3") }],
        });
        const one = [[NEW, "1.3"]];
        expect(yield* state).toEqual({ running: one, disk: one, restarted: one });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps committed images and the failed image's old file when a write fails", () =>
    Effect.gen(function* () {
      const { layer, state } = memoryLibrary(
        { [OLD]: image("V1.1"), [NEW]: image("V1.2") },
        (call) =>
          call.method === "writeFile" && call.path.includes(NEW)
            ? Effect.fail(
                PlatformError.systemError({ _tag: "Unknown", module: "test", method: "writeFile" }),
              )
            : Effect.void,
      );
      yield* Effect.gen(function* () {
        const library = yield* FirmwareLibrary.FirmwareLibrary;
        const error = yield* Effect.flip(
          library.importVendorFiles({
            files: [
              { name: OLD, bytes: image("V1.3") },
              { name: NEW, bytes: image("V1.3") },
            ],
          }),
        );
        expect(error.reason).toBe("persist");
        const both = [
          [NEW, "1.2"],
          [OLD, "1.3"],
        ];
        expect(yield* state).toEqual({ running: both, disk: both, restarted: both });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("finishes publishing an image whose file is in place when interrupted", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate;
      const { layer, state } = memoryLibrary(
        { [OLD]: image("V1.1"), [NEW]: image("V1.2") },
        (call) => (call.method === "rename" ? gate.pass : Effect.void),
      );
      yield* Effect.gen(function* () {
        const library = yield* FirmwareLibrary.FirmwareLibrary;
        const importing = yield* Effect.forkChild(
          library.importVendorFiles({
            files: [
              { name: OLD, bytes: image("V1.3") },
              { name: NEW, bytes: image("V1.3") },
            ],
          }),
          { startImmediately: true },
        );
        yield* gate.entered;
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(importing), {
          startImmediately: true,
        });
        yield* gate.open;
        yield* Fiber.join(interrupting);
        const firstOnly = [
          [NEW, "1.2"],
          [OLD, "1.3"],
        ];
        expect(yield* state).toEqual({ running: firstOnly, disk: firstOnly, restarted: firstOnly });
      }).pipe(Effect.provide(layer));
    }),
  );
});
