import * as Schema from "effect/Schema";
import { ConnectTarget } from "./emulator.ts";

export const FirmwareUpdateStage = Schema.Literals([
  "entering",
  "handshake",
  "reading",
  "erasing",
  "writing",
  "finishing",
]);
export type FirmwareUpdateStage = typeof FirmwareUpdateStage.Type;

export const FirmwareUpdateState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("running", {
    target: ConnectTarget,
    stage: FirmwareUpdateStage,
    written: Schema.Number,
    total: Schema.Number,
  }),
  Schema.TaggedStruct("succeeded", {
    target: ConnectTarget,
    bytes: Schema.Number,
    /** From the application info the bootloader reports, e.g. "1.3". */
    version: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("failed", {
    target: ConnectTarget,
    stage: FirmwareUpdateStage,
    reason: Schema.String,
    /** The application area was erased; the bootloader is intact and can take a new image. */
    applicationErased: Schema.Boolean,
  }),
]);
export type FirmwareUpdateState = typeof FirmwareUpdateState.Type;

export const MAX_FIRMWARE_IMAGE_LENGTH = 2_000_000;

/** The Intel HEX file's text. */
export const FirmwareImageText = Schema.String.check(Schema.isMaxLength(MAX_FIRMWARE_IMAGE_LENGTH));

export const InspectFirmwareInput = Schema.Struct({ image: FirmwareImageText });

export const FirmwareImageSummary = Schema.Struct({
  start: Schema.Number,
  /** Exclusive. */
  end: Schema.Number,
  bytes: Schema.Number,
});
export type FirmwareImageSummary = typeof FirmwareImageSummary.Type;

export const FirmwareUpdateInput = Schema.Struct({
  target: ConnectTarget,
  image: FirmwareImageText,
  /** The bootloader's 16-byte wire key as hex. Supplied for each update and never stored. */
  wireKey: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32}$/)),
});
export type FirmwareUpdateInput = typeof FirmwareUpdateInput.Type;

export class FirmwareImageError extends Schema.TaggedError<FirmwareImageError>()(
  "FirmwareImageError",
  {
    reason: Schema.Literals(["unreadable", "outsideApplication"]),
    line: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unreadable":
        return this.line === null
          ? "This isn't a valid Intel HEX file."
          : `This isn't a valid Intel HEX file (line ${this.line}).`;
      case "outsideApplication":
        return "This image doesn't start at the MK2's application address.";
    }
  }
}

export class FirmwareUpdateError extends Schema.TaggedError<FirmwareUpdateError>()(
  "FirmwareUpdateError",
  {
    reason: Schema.Literals([
      "busy",
      "wrongKey",
      "hardwareLocked",
      "noBootloader",
      "doesNotFit",
      "rejected",
      "noReply",
      "unexpectedReply",
      "link",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "busy":
        return "A firmware update is already running.";
      case "wrongKey":
        return "That isn't the MK2 bootloader's wire key.";
      case "hardwareLocked":
        return "Flashing a real MK2 isn't enabled yet. Use the simulated device.";
      case "noBootloader":
        return "The bootloader didn't answer.";
      case "doesNotFit":
        return "The image doesn't fit this device's flash.";
      case "rejected":
        return "The bootloader rejected a command.";
      case "noReply":
        return "The bootloader stopped answering.";
      case "unexpectedReply":
        return "The bootloader sent a reply the updater doesn't understand.";
      case "link":
        return "The connection to the device failed.";
    }
  }
}
