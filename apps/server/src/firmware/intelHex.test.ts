import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { parseIntelHex } from "./intelHex.ts";

const record = (type: number, offset: number, data: ReadonlyArray<number> = []) => {
  const fields = [data.length, offset >> 8, offset & 0xff, type, ...data];
  const sum = fields.reduce((acc, byte) => acc + byte, 0);
  return `:${Buffer.from([...fields, -sum & 0xff])
    .toString("hex")
    .toUpperCase()}`;
};

const EXTENDED = record(0x04, 0, [0x08, 0x00]);
const END = record(0x01, 0);

describe("intelHex", () => {
  it("joins adjacent records into segments under the extended linear address", () => {
    const text = [
      EXTENDED,
      record(0x00, 0x3800, [1, 2, 3, 4]),
      record(0x00, 0x3804, [5, 6]),
      record(0x00, 0x3900, [7]),
      record(0x05, 0, [0x08, 0x00, 0x38, 0xed]),
      END,
    ].join("\r\n");
    expect(Result.getOrThrow(parseIntelHex(text))).toEqual({
      segments: [
        { address: 0x08003800, data: Uint8Array.of(1, 2, 3, 4, 5, 6) },
        { address: 0x08003900, data: Uint8Array.of(7) },
      ],
      entry: 0x080038ed,
    });
  });

  it.each([
    ["a line without a colon", [EXTENDED, "0400", END], 2, "syntax"],
    ["a byte count that disagrees", [EXTENDED, `${record(0x00, 0, [1, 2])}00`, END], 2, "syntax"],
    ["a bad checksum", [EXTENDED, ":0100000001FF", END], 2, "checksum"],
    ["an unknown record type", [EXTENDED, record(0x06, 0), END], 2, "recordType"],
    [
      "two records for one address",
      [record(0x00, 0, [1]), record(0x00, 0, [1]), END],
      2,
      "overlap",
    ],
    ["no data", [EXTENDED, END], 2, "empty"],
    ["no end record", [EXTENDED, record(0x00, 0, [1])], 2, "missingEnd"],
  ])("rejects %s", (_, lines, line, reason) => {
    const result = parseIntelHex(lines.join("\n"));
    expect(Result.isFailure(result) && result.failure).toMatchObject({ line, reason });
  });
});
