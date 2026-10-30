import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import {
  APPLICATION_BASE,
  erasePayload,
  finalizerCrc,
  finalizerPayload,
  planFlash,
  runPayload,
  writePayload,
} from "./flashPlan.ts";
import type { FirmwareImage } from "./intelHex.ts";

const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");
const imageAt = (address: number, length: number): FirmwareImage => ({
  segments: [{ address, data: Uint8Array.from({ length }, (_, i) => i & 0xff) }],
  entry: undefined,
});

describe("flashPlan", () => {
  it("erases the rest of a 64 KiB flash in 1 KiB pages, as the vendor updater does", () => {
    const plan = Result.getOrThrow(planFlash(imageAt(APPLICATION_BASE, 47_364), 64));
    expect(plan.pageSize).toBe(1024);
    expect(hex(erasePayload(plan.erase))).toBe("080038000032");
    expect(plan.writes).toHaveLength(47);
    expect(hex(runPayload(plan.runAddress))).toBe("08003800");
  });

  it("switches to 2 KiB pages from 256 KiB of flash", () => {
    const plan = Result.getOrThrow(planFlash(imageAt(APPLICATION_BASE, 10), 256));
    expect(plan).toMatchObject({
      pageSize: 2048,
      erase: { address: APPLICATION_BASE, pages: 121 },
    });
  });

  it("splits each segment into page-sized writes from its own start", () => {
    const plan = Result.getOrThrow(planFlash(imageAt(APPLICATION_BASE, 2500), 64));
    expect(plan.writes.map(({ address, data }) => [address, data.length])).toEqual([
      [0x08003800, 1024],
      [0x08003c00, 1024],
      [0x08004000, 452],
    ]);
    expect(hex(writePayload(plan.writes[2]!).subarray(0, 8))).toBe("0800400001c40001");
  });

  it.each([
    ["writes into the bootloader", imageAt(0x08000000, 0x4000), 64, "belowApplication"],
    ["starts after the application base", imageAt(0x08004000, 16), 64, "startAddress"],
    ["is empty", { segments: [], entry: undefined }, 64, "startAddress"],
    ["runs past the end of flash", imageAt(APPLICATION_BASE, 0xc801), 64, "beyondFlash"],
    ["targets a flash too small for an application", imageAt(APPLICATION_BASE, 1), 14, "flashSize"],
  ])("refuses an image that %s", (_, image, flashKib, reason) => {
    const result = planFlash(image, flashKib);
    expect(Result.isFailure(result) && result.failure.reason).toBe(reason);
  });

  it("never builds a payload that addresses the bootloader", () => {
    const below = APPLICATION_BASE - 0x400;
    expect(() => erasePayload({ address: below, pages: 1 })).toThrow(RangeError);
    expect(() => writePayload({ address: below, data: Uint8Array.of(0) })).toThrow(RangeError);
    expect(() => runPayload(below)).toThrow(RangeError);
  });

  it.each([
    // The CRC the vendor updater sent for this chip ID in a capture against a fake bootloader.
    ["0123456789abcdef01234567", 0xbe482081],
    ["101112131415161718191a1b", 0xcd221227],
  ])("derives the finalizer CRC for chip ID %s", (chipId, crc) => {
    expect(finalizerCrc(Buffer.from(chipId, "hex"))).toBe(crc);
  });

  it("sends the finalizer CRC big-endian followed by twelve zero bytes", () => {
    expect(hex(finalizerPayload(0xbe482081))).toBe(`be482081${"00".repeat(12)}`);
  });
});
