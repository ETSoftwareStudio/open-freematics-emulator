// @effect-diagnostics nodeBuiltinImport:off - Effect's Crypto has no AES; the wire cipher is AES-128-ECB.
/**
 * Frames for the MK2 bootloader, the protocol the vendor's firmware updater speaks after `ATR`.
 * Commands go out encrypted with a 16-byte wire key the caller supplies; replies come back clear.
 */
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const BootloaderCommand = {
  readChipId: 0x00,
  writeCrc: 0x01,
  readSerial: 0x02,
  readCheck: 0x03,
  readVersion: 0x04,
  readBootInfo: 0x05,
  erase: 0x06,
  write: 0x07,
  /** Sent after the last write. */
  writeDone: 0x08,
  run: 0x09,
  readAppInfo: 0x0b,
  error: 0x10,
  ack: 0x20,
} as const;

/** The unencrypted probe the updater sends before reopening the port. */
export const PROBE_FRAME = Uint8Array.of(0xbb, 0xfe, 0xfe, 0xee, 0x0d);

const FRAME_START = 0xbb;
const FRAME_END = 0xee;
const ESCAPE = 0xaa;
const ESCAPE_CODES = new Map([
  [0xaa, 0x0a],
  [0xbb, 0x0b],
  [0xee, 0x0e],
]);
const UNESCAPED = new Map([...ESCAPE_CODES].map(([byte, code]) => [code, byte]));
const BLOCK = 16;

export class BootloaderFrameError extends Schema.TaggedError<BootloaderFrameError>()(
  "BootloaderFrameError",
  { reason: Schema.Literals(["delimiters", "escape", "checksum", "length"]) },
) {
  override get message(): string {
    return `Invalid bootloader frame (${this.reason}).`;
  }
}

export interface CommandFrame {
  readonly command: number;
  readonly payload: Uint8Array;
  readonly padding: Uint8Array;
}

export interface ReplyFrame {
  readonly command: number;
  readonly payload: Uint8Array;
}

const checksum = (bytes: Uint8Array) => bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0);

const stuff = (bytes: Iterable<number>) => {
  const out: Array<number> = [];
  for (const byte of bytes) {
    const code = ESCAPE_CODES.get(byte);
    if (code === undefined) out.push(byte);
    else out.push(ESCAPE, code);
  }
  return out;
};

/** Always pads, a whole block when `length || payload` is already aligned. */
export const paddingLength = (payloadLength: number) => BLOCK - ((payloadLength + 2) % BLOCK);

const aes = (wireKey: Uint8Array, data: Uint8Array, direction: "encrypt" | "decrypt") => {
  const cipher =
    direction === "encrypt"
      ? NodeCrypto.createCipheriv("aes-128-ecb", wireKey, null)
      : NodeCrypto.createDecipheriv("aes-128-ecb", wireKey, null);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
};

/**
 * `BB stuff(command, AES(length_be16, payload, padding), checksum) EE`. The vendor's padding is
 * uninitialized stack memory, so random padding is the closest match; tests pass it explicitly.
 */
export const encodeCommandFrame = (
  command: number,
  payload: Uint8Array,
  wireKey: Uint8Array,
  padding: Uint8Array = NodeCrypto.randomBytes(paddingLength(payload.length)),
): Uint8Array => {
  if (payload.length > 0xffff) throw new RangeError("Bootloader payload is too long.");
  if (padding.length !== paddingLength(payload.length)) {
    throw new RangeError("Bootloader padding has the wrong length.");
  }
  const plain = new Uint8Array(2 + payload.length + padding.length);
  new DataView(plain.buffer).setUint16(0, payload.length);
  plain.set(payload, 2);
  plain.set(padding, 2 + payload.length);
  const body = Uint8Array.of(command, ...aes(wireKey, plain, "encrypt"));
  return Uint8Array.of(FRAME_START, ...stuff(body), ...stuff([checksum(body)]), FRAME_END);
};

/** Replies travel in the clear: `BB stuff(command, payload, checksum) EE`. */
export const encodeReplyFrame = (command: number, payload: Uint8Array): Uint8Array => {
  const body = Uint8Array.of(command, ...payload);
  return Uint8Array.of(FRAME_START, ...stuff(body), ...stuff([checksum(body)]), FRAME_END);
};

/** SHA-256 of a wire key, so a key can be recognized without the key itself in the source. */
export const wireKeyFingerprint = (wireKey: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(wireKey).digest("hex");

export const WIRE_KEY_LENGTH = 16;

/**
 * SHA-256 of the MK2 bootloader's wire key. The key itself is never in the source; this hash both
 * recognizes a supplied key and lets {@link findWireKey} recover the key from the vendor tool.
 */
export const VENDOR_WIRE_KEY_SHA256 =
  "2d892f5f5ff0f613b75d1feea642910b064e7f35a5e616264dc039c90a082243";

/** Windows hashed between yields, so a multi-megabyte scan never holds the event loop for long. */
export const WIRE_KEY_SCAN_SLICE = 1 << 15;

/**
 * Scans a buffer for the 16-byte window whose SHA-256 matches `sha256`, returning a copy of it or
 * `null`. Finding it by hash (not a fixed offset) is self-verifying and survives vendor-version
 * layout shifts; the match is proof the right bytes were found. Interruptible between slices.
 */
export const findWireKey = Effect.fn("findWireKey")(function* (
  data: Uint8Array,
  sha256: string = VENDOR_WIRE_KEY_SHA256,
) {
  const windows = data.length - WIRE_KEY_LENGTH + 1;
  for (let start = 0; start < windows; start += WIRE_KEY_SCAN_SLICE) {
    if (start > 0) yield* Effect.yieldNow;
    for (let i = start; i < Math.min(start + WIRE_KEY_SCAN_SLICE, windows); i++) {
      const window = data.subarray(i, i + WIRE_KEY_LENGTH);
      if (wireKeyFingerprint(window) === sha256) return Uint8Array.from(window);
    }
  }
  return null;
});

/** Checks delimiters, escapes and checksum; the payload is whatever follows the command byte. */
export const decodeReplyFrame = (
  frame: Uint8Array,
): Result.Result<ReplyFrame, BootloaderFrameError> => {
  if (frame[0] !== FRAME_START || frame[frame.length - 1] !== FRAME_END) {
    return Result.fail(new BootloaderFrameError({ reason: "delimiters" }));
  }
  const bytes: Array<number> = [];
  for (let i = 1; i < frame.length - 1; i++) {
    if (frame[i] !== ESCAPE) {
      bytes.push(frame[i]!);
      continue;
    }
    const byte = UNESCAPED.get(frame[++i]!);
    if (byte === undefined) {
      return Result.fail(new BootloaderFrameError({ reason: "escape" }));
    }
    bytes.push(byte);
  }
  if (bytes.length < 2) return Result.fail(new BootloaderFrameError({ reason: "length" }));
  const content = Uint8Array.from(bytes.slice(0, -1));
  if (checksum(content) !== bytes[bytes.length - 1]) {
    return Result.fail(new BootloaderFrameError({ reason: "checksum" }));
  }
  return Result.succeed({ command: content[0]!, payload: content.subarray(1) });
};

export const decodeCommandFrame = (
  frame: Uint8Array,
  wireKey: Uint8Array,
): Result.Result<CommandFrame, BootloaderFrameError> =>
  Result.flatMap(decodeReplyFrame(frame), ({ command, payload: encrypted }) => {
    if (encrypted.length === 0 || encrypted.length % BLOCK !== 0) {
      return Result.fail(new BootloaderFrameError({ reason: "length" }));
    }
    const plain = aes(wireKey, encrypted, "decrypt");
    const length = new DataView(plain.buffer).getUint16(0);
    if (plain.length !== 2 + length + paddingLength(length)) {
      return Result.fail(new BootloaderFrameError({ reason: "length" }));
    }
    return Result.succeed({
      command,
      payload: plain.slice(2, 2 + length),
      padding: plain.slice(2 + length),
    });
  });
