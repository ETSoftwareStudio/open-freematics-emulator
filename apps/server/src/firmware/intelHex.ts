import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export interface FirmwareSegment {
  readonly address: number;
  readonly data: Uint8Array;
}

export interface FirmwareImage {
  /** Contiguous runs of bytes, sorted by address. */
  readonly segments: ReadonlyArray<FirmwareSegment>;
  /** From a start-linear-address record, when the file has one. */
  readonly entry: number | undefined;
}

export class IntelHexError extends Schema.TaggedError<IntelHexError>()("IntelHexError", {
  line: Schema.Number,
  reason: Schema.Literals(["syntax", "checksum", "recordType", "overlap", "missingEnd", "empty"]),
}) {
  override get message(): string {
    return `Invalid Intel HEX file at line ${this.line} (${this.reason}).`;
  }
}

const toSegments = (bytes: Map<number, number>): Array<FirmwareSegment> => {
  const segments: Array<FirmwareSegment> = [];
  let run: Array<number> = [];
  let start = 0;
  for (const address of [...bytes.keys()].sort((a, b) => a - b)) {
    if (run.length > 0 && address !== start + run.length) {
      segments.push({ address: start, data: Uint8Array.from(run) });
      run = [];
    }
    if (run.length === 0) start = address;
    run.push(bytes.get(address)!);
  }
  if (run.length > 0) segments.push({ address: start, data: Uint8Array.from(run) });
  return segments;
};

export const parseIntelHex = (text: string): Result.Result<FirmwareImage, IntelHexError> => {
  const lines = text.split(/\r?\n/);
  const bytes = new Map<number, number>();
  let base = 0;
  let entry: number | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const record = raw.trim();
    if (record === "") continue;
    if (!/^:([0-9a-fA-F]{2})+$/.test(record)) {
      return Result.fail(new IntelHexError({ line, reason: "syntax" }));
    }
    const fields = Uint8Array.from(Buffer.from(record.slice(1), "hex"));
    const count = fields[0]!;
    if (fields.length !== count + 5) {
      return Result.fail(new IntelHexError({ line, reason: "syntax" }));
    }
    if (fields.reduce((sum, byte) => (sum + byte) & 0xff, 0) !== 0) {
      return Result.fail(new IntelHexError({ line, reason: "checksum" }));
    }
    const offset = (fields[1]! << 8) | fields[2]!;
    const data = fields.subarray(4, 4 + count);
    const value = data.reduce((acc, byte) => acc * 256 + byte, 0);
    switch (fields[3]) {
      case 0x00:
        for (const [i, byte] of data.entries()) {
          if (bytes.has(base + offset + i)) {
            return Result.fail(new IntelHexError({ line, reason: "overlap" }));
          }
          bytes.set(base + offset + i, byte);
        }
        break;
      case 0x01:
        if (bytes.size === 0) return Result.fail(new IntelHexError({ line, reason: "empty" }));
        return Result.succeed({ segments: toSegments(bytes), entry });
      case 0x02:
        base = value * 16;
        break;
      case 0x03:
        break;
      case 0x04:
        base = value * 0x10000;
        break;
      case 0x05:
        entry = value;
        break;
      default:
        return Result.fail(new IntelHexError({ line, reason: "recordType" }));
    }
  }
  return Result.fail(new IntelHexError({ line: lines.length, reason: "missingEnd" }));
};
