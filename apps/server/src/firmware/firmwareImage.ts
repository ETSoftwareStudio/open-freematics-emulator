import { FirmwareImageError, type FirmwareImageSummary } from "@fme/contracts";
import * as Result from "effect/Result";
import { APPLICATION_BASE } from "./flashPlan.ts";
import { parseIntelHex, type FirmwareImage } from "./intelHex.ts";

/** Parses an Intel HEX application image and checks it starts at the application address. */
export const readFirmwareImage = (
  text: string,
): Result.Result<FirmwareImage, FirmwareImageError> => {
  const parsed = parseIntelHex(text);
  if (Result.isFailure(parsed)) {
    return Result.fail(new FirmwareImageError({ reason: "unreadable", line: parsed.failure.line }));
  }
  return parsed.success.segments[0]?.address === APPLICATION_BASE
    ? Result.succeed(parsed.success)
    : Result.fail(new FirmwareImageError({ reason: "outsideApplication", line: null }));
};

export const imageBytes = (image: FirmwareImage) =>
  image.segments.reduce((sum, segment) => sum + segment.data.length, 0);

export const summarizeImage = (image: FirmwareImage): FirmwareImageSummary => {
  const last = image.segments[image.segments.length - 1]!;
  return {
    start: APPLICATION_BASE,
    end: last.address + last.data.length,
    bytes: imageBytes(image),
  };
};

const BANNER = /EMULATOR V(\d+(?:\.\d+)*)/;

/** The version in the "OBD-II EMULATOR V1.3" banner the application prints on reset. */
export const bannerVersion = (image: FirmwareImage): string | null => {
  for (const segment of image.segments) {
    const match = BANNER.exec(Buffer.from(segment.data).toString("latin1"));
    if (match !== null) return match[1]!;
  }
  return null;
};
