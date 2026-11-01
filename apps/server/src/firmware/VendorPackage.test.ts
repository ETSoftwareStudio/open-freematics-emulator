import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import type { ImportVendorFilesInput } from "@fme/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FirmwareLibrary from "./FirmwareLibrary.ts";
import * as VendorPackage from "./VendorPackage.ts";

const fixture = Buffer.from(
  "UEsDBAoAAAAAACMSYV0WVdfxDAAAAAwAAAALAAAAaWdub3JlZC50eHRub3QgaW1wb3J0ZWRQSwMECgAAAAAAIxJhXeioooAaAAAAGgAAAAoAAABzYW1wbGUuaGV4c3ludGhldGljIGZpcm13YXJlIGZpeHR1cmVQSwECPwMKAAAAAAAjEmFdFlXX8QwAAAAMAAAACwAkAAAAAAAAACCAtoEAAAAAaWdub3JlZC50eHQKACAAAAAAAAEAGABQUQT/0GndAQAAAAAAAAAAAAAAAAAAAABQSwECPwMKAAAAAAAjEmFd6KiigBoAAAAaAAAACgAkAAAAAAAAACCAtoE1AAAAc2FtcGxlLmhleAoAIAAAAAAAAQAYAFBRBP/Qad0BAAAAAAAAAAAAAAAAAAAAAFBLBQYAAAAAAgACALkAAAB3AAAAAAA=",
  "base64",
);
const content = new TextEncoder().encode("synthetic firmware fixture");

const setup = Effect.fn("test.setup")(function* (
  options: {
    readonly body?: Uint8Array;
    readonly archive?: Uint8Array;
    readonly status?: number;
    readonly wrongFileHash?: boolean;
    readonly entered?: Deferred.Deferred<void>;
    readonly release?: Deferred.Deferred<void>;
  } = {},
) {
  const crypto = yield* Crypto.Crypto;
  const archive = options.archive ?? fixture;
  const archiveHash = Buffer.from(yield* crypto.digest("SHA-256", archive)).toString("hex");
  const fileHash = Buffer.from(yield* crypto.digest("SHA-256", content)).toString("hex");
  const imported = yield* Ref.make<ImportVendorFilesInput["files"]>([]);
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      expect(request.url).toBe("https://example.invalid/vendor.exe");
      if (options.entered !== undefined) yield* Deferred.succeed(options.entered, undefined);
      if (options.release !== undefined) yield* Deferred.await(options.release);
      return HttpClientResponse.fromWeb(
        request,
        new Response(options.body ?? archive, {
          status: options.status ?? 200,
        }),
      );
    }),
  );
  const library = FirmwareLibrary.FirmwareLibrary.of({
    images: Stream.succeed([]),
    read: () => Effect.succeed(""),
    importVendorFiles: ({ files }) =>
      Ref.set(imported, files).pipe(Effect.as({ keyFound: true, imagesAdded: files.length })),
  });
  const layer = VendorPackage.layer({
    url: "https://example.invalid/vendor.exe",
    size: archive.length,
    sha256: archiveHash,
    files: [{ name: "sample.hex", sha256: options.wrongFileHash ? "0".repeat(64) : fileHash }],
  }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Layer.succeed(FirmwareLibrary.FirmwareLibrary, library)),
    Layer.provide(NodeServices.layer),
  );
  return { imported, layer };
});

describe("VendorPackage", () => {
  it.effect("extracts only allowlisted files and imports their verified bytes", () =>
    Effect.gen(function* () {
      const { imported, layer } = yield* setup();
      const result = yield* Effect.gen(function* () {
        return yield* (yield* VendorPackage.VendorPackage).download;
      }).pipe(Effect.provide(layer));
      expect(result).toEqual({ keyFound: true, imagesAdded: 1 });
      const files = yield* Ref.get(imported);
      expect(files.map((file) => file.name)).toEqual(["sample.hex"]);
      expect([...files[0]!.bytes]).toEqual([...content]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["truncated", fixture.subarray(0, -1)],
    ["oversized", new Uint8Array(fixture.length + 1)],
    ["changed", new Uint8Array(fixture.length)],
  ] as const)("rejects a %s download without importing", ([, body]) =>
    Effect.gen(function* () {
      const { imported, layer } = yield* setup({ body });
      const error = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* VendorPackage.VendorPackage).download);
      }).pipe(Effect.provide(layer));
      expect(error.reason).toBe("checksum");
      expect(yield* Ref.get(imported)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([302, 404, 500])("rejects HTTP %s without importing", (status) =>
    Effect.gen(function* () {
      const { imported, layer } = yield* setup({ status });
      const error = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* VendorPackage.VendorPackage).download);
      }).pipe(Effect.provide(layer));
      expect(error.reason).toBe("network");
      expect(yield* Ref.get(imported)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not import extracted files with an unexpected digest", () =>
    Effect.gen(function* () {
      const { imported, layer } = yield* setup({ wrongFileHash: true });
      const error = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* VendorPackage.VendorPackage).download);
      }).pipe(Effect.provide(layer));
      expect(error.reason).toBe("extract");
      expect(yield* Ref.get(imported)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns an extraction error for a verified but unreadable archive", () =>
    Effect.gen(function* () {
      const { imported, layer } = yield* setup({ archive: content });
      const error = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* VendorPackage.VendorPackage).download);
      }).pipe(Effect.provide(layer));
      expect(error.reason).toBe("extract");
      expect(yield* Ref.get(imported)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("times out a stalled download and allows another attempt", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { layer, imported } = yield* setup({ entered, release, status: 500 });
      yield* Effect.gen(function* () {
        const vendor = yield* VendorPackage.VendorPackage;
        const first = yield* Effect.forkChild(Effect.flip(vendor.download));
        yield* Deferred.await(entered);
        yield* TestClock.adjust("3 minutes");
        expect((yield* Fiber.join(first)).reason).toBe("timeout");
        expect(yield* Ref.get(imported)).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Effect.flip(vendor.download)).reason).toBe("network");
      }).pipe(Effect.provide(layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects concurrent downloads and releases the lock after failure", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { layer } = yield* setup({ entered, release, status: 500 });
      yield* Effect.gen(function* () {
        const vendor = yield* VendorPackage.VendorPackage;
        const first = yield* Effect.forkChild(Effect.flip(vendor.download));
        yield* Deferred.await(entered);
        expect((yield* Effect.flip(vendor.download)).reason).toBe("busy");
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(first)).reason).toBe("network");
        expect((yield* Effect.flip(vendor.download)).reason).toBe("network");
      }).pipe(Effect.provide(layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
