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

/** A firmware file name as stored in the local library, e.g. "Firmware_MK2_20250311.hex". */
export const LibraryImageName = Schema.String.check(Schema.isPattern(/^[\w.-]{1,100}\.hex$/i));

export const FirmwareImageSource = Schema.Union([
  Schema.TaggedStruct("file", { text: FirmwareImageText }),
  Schema.TaggedStruct("library", { name: LibraryImageName }),
]);
export type FirmwareImageSource = typeof FirmwareImageSource.Type;

export const FirmwareUpdateInput = Schema.Struct({
  target: ConnectTarget,
  image: FirmwareImageSource,
  /** The bootloader's 16-byte wire key as hex. When omitted, the stored key is used. */
  wireKey: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32}$/))),
});
export type FirmwareUpdateInput = typeof FirmwareUpdateInput.Type;

export class FirmwareImageError extends Schema.TaggedError<FirmwareImageError>()(
  "FirmwareImageError",
  {
    reason: Schema.Literals(["unreadable", "outsideApplication", "notInLibrary"]),
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
      case "notInLibrary":
        return "That firmware image isn't in the library any more.";
    }
  }
}

export class FirmwareUpdateError extends Schema.TaggedError<FirmwareUpdateError>()(
  "FirmwareUpdateError",
  {
    reason: Schema.Literals([
      "busy",
      "shuttingDown",
      "wrongKey",
      "noKey",
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
      case "shuttingDown":
        return "The app is closing, so no update can start.";
      case "wrongKey":
        return "That isn't the MK2 bootloader's wire key.";
      case "noKey":
        return "No wire key is available. Import one from the vendor tool first.";
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

/** The Freematics firmware updater binary (FirmwareUpdater.exe) the key is extracted from. */
export const MAX_VENDOR_BINARY_LENGTH = 16_000_000;

export const ImportWireKeyInput = Schema.Struct({
  binary: Schema.Uint8Array.check(Schema.isMaxLength(MAX_VENDOR_BINARY_LENGTH)),
});
export type ImportWireKeyInput = typeof ImportWireKeyInput.Type;

/** Whether a wire key is stored, and its fingerprint when it is. The key itself never leaves the server. */
export const WireKeyStatus = Schema.Union([
  Schema.TaggedStruct("absent", {}),
  Schema.TaggedStruct("present", { fingerprint: Schema.String }),
]);
export type WireKeyStatus = typeof WireKeyStatus.Type;

export class WireKeyError extends Schema.TaggedError<WireKeyError>()("WireKeyError", {
  reason: Schema.Literals(["notFound", "persist"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "notFound":
        return "No MK2 wire key is in this file. Point at FirmwareUpdater.exe from the Freematics GUI.";
      case "persist":
        return "The wire key couldn't be saved.";
    }
  }
}

/** A firmware image kept locally after it was imported from the user's Freematics folder. */
export const LibraryImage = Schema.Struct({
  name: LibraryImageName,
  /** From the banner inside the image, e.g. "1.3". */
  version: Schema.NullOr(Schema.String),
  /** YYYY-MM-DD from the file name, e.g. Firmware_MK2_20250311.hex. */
  released: Schema.NullOr(Schema.String),
  start: Schema.Number,
  end: Schema.Number,
  bytes: Schema.Number,
});
export type LibraryImage = typeof LibraryImage.Type;

/** A file from the user's Freematics folder: FirmwareUpdater.exe or a firmware .hex. */
export const VendorFile = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(255)),
  bytes: Schema.Uint8Array.check(Schema.isMaxLength(MAX_VENDOR_BINARY_LENGTH)),
});

export const ImportVendorFilesInput = Schema.Struct({
  files: Schema.Array(VendorFile).check(Schema.isMaxLength(32)),
});
export type ImportVendorFilesInput = typeof ImportVendorFilesInput.Type;

export const VendorImportResult = Schema.Struct({
  keyFound: Schema.Boolean,
  imagesAdded: Schema.Number,
});

export class VendorDownloadError extends Schema.TaggedError<VendorDownloadError>()(
  "VendorDownloadError",
  { reason: Schema.Literals(["network", "checksum", "extract", "busy", "timeout"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "network":
        return "The Freematics download failed. Try again or import a Freematics folder.";
      case "checksum":
        return "The download doesn't match the verified Freematics package. Nothing was imported. Use folder import instead.";
      case "extract":
        return "The Freematics package couldn't be unpacked. Try importing an unpacked folder instead.";
      case "busy":
        return "A Freematics download is already running.";
      case "timeout":
        return "The Freematics download or extraction timed out. Try again or import a folder.";
    }
  }
}

export class VendorImportError extends Schema.TaggedError<VendorImportError>()(
  "VendorImportError",
  { reason: Schema.Literals(["noKey", "duplicateName", "persist"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "noKey":
        return "No MK2 wire key was found. Choose the Freematics folder that has FirmwareUpdater.exe.";
      case "duplicateName":
        return "Two different firmware images share a name. Choose a folder with one copy of each.";
      case "persist":
        return "The Freematics files couldn't be saved.";
    }
  }
}
