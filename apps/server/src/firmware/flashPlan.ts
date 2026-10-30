/**
 * What the bootloader is asked to erase and write for an image, and the payloads that carry it.
 * The vendor bootloader lives below APPLICATION_BASE and is the only recovery path, so nothing
 * here will address it.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { FirmwareImage, FirmwareSegment } from "./intelHex.ts";

export const FLASH_BASE = 0x08000000;
export const APPLICATION_BASE = 0x08003800;

export interface FlashPlan {
  readonly pageSize: number;
  /** The whole application area up to the end of flash, as the vendor updater erases it. */
  readonly erase: { readonly address: number; readonly pages: number };
  /** Page-sized (or shorter) chunks of each segment, in address order. */
  readonly writes: ReadonlyArray<FirmwareSegment>;
  readonly runAddress: number;
}

export class FlashPlanError extends Schema.TaggedError<FlashPlanError>()("FlashPlanError", {
  reason: Schema.Literals(["flashSize", "belowApplication", "startAddress", "beyondFlash"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "flashSize":
        return "The device reported a flash size the updater can't use.";
      case "belowApplication":
        return "The image writes into the bootloader area.";
      case "startAddress":
        return "The image doesn't start at the application base address.";
      case "beyondFlash":
        return "The image is larger than the device's flash.";
    }
  }
}

export const planFlash = (
  image: FirmwareImage,
  flashKib: number,
): Result.Result<FlashPlan, FlashPlanError> => {
  // The vendor updater picks the page size from the reported capacity, not the image size.
  const pageSize = flashKib < 256 ? 1024 : 2048;
  const flashEnd = FLASH_BASE + flashKib * 1024;
  const pages = (flashEnd - APPLICATION_BASE) / pageSize;
  if (!Number.isInteger(flashKib) || !Number.isInteger(pages) || pages < 1 || pages > 0xffff) {
    return Result.fail(new FlashPlanError({ reason: "flashSize" }));
  }
  const first = image.segments[0];
  const last = image.segments[image.segments.length - 1];
  if (!first || !last) return Result.fail(new FlashPlanError({ reason: "startAddress" }));
  if (first.address < APPLICATION_BASE) {
    return Result.fail(new FlashPlanError({ reason: "belowApplication" }));
  }
  if (first.address !== APPLICATION_BASE) {
    return Result.fail(new FlashPlanError({ reason: "startAddress" }));
  }
  if (last.address + last.data.length > flashEnd) {
    return Result.fail(new FlashPlanError({ reason: "beyondFlash" }));
  }
  const writes = image.segments.flatMap(({ address, data }) =>
    Array.from({ length: Math.ceil(data.length / pageSize) }, (_, i) => ({
      address: address + i * pageSize,
      data: data.subarray(i * pageSize, (i + 1) * pageSize),
    })),
  );
  return Result.succeed({
    pageSize,
    erase: { address: APPLICATION_BASE, pages },
    writes,
    runAddress: APPLICATION_BASE,
  });
};

/** Last line of defence: a payload addressing the bootloader is a bug, never a request. */
const assertApplicationAddress = (address: number) => {
  if (address < APPLICATION_BASE) {
    throw new RangeError("Refusing to address the bootloader area.");
  }
};

const be32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

const be16 = (value: number) => Uint8Array.of(value >> 8, value & 0xff);

export const erasePayload = ({ address, pages }: FlashPlan["erase"]) => {
  assertApplicationAddress(address);
  return Uint8Array.of(...be32(address), ...be16(pages));
};

export const writePayload = ({ address, data }: FirmwareSegment) => {
  assertApplicationAddress(address);
  return Uint8Array.of(...be32(address), ...be16(data.length), ...data);
};

export const runPayload = (address: number) => {
  assertApplicationAddress(address);
  return be32(address);
};

// The updater shuffles the chip ID before its CRC; recovered from the vendor tool.
const FINALIZER_ORDER = [0, 6, 2, 8, 7, 1, 3, 9, 5, 11, 10, 4];

/** CRC-32/MPEG-2 over the shuffled 12-byte chip ID, read as three little-endian words. */
export const finalizerCrc = (chipId: Uint8Array): number => {
  if (chipId.length !== 12) throw new RangeError("A chip ID is 12 bytes.");
  const shuffled = Uint8Array.from(FINALIZER_ORDER, (i) => chipId[i]!);
  const words = new DataView(shuffled.buffer);
  let crc = 0xffffffff;
  for (let offset = 0; offset < 12; offset += 4) {
    const word = words.getUint32(offset, true);
    for (let bit = 31; bit >= 0; bit--) {
      const feedback = ((crc >>> 31) ^ (word >>> bit)) & 1;
      crc = ((crc << 1) ^ (feedback ? 0x04c11db7 : 0)) >>> 0;
    }
  }
  return crc;
};

export const finalizerPayload = (crc: number) => Uint8Array.of(...be32(crc), ...new Uint8Array(12));
