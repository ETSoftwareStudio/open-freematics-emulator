import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import {
  BootloaderCommand,
  decodeCommandFrame,
  decodeReplyFrame,
  encodeCommandFrame,
  paddingLength,
} from "./bootloaderFrame.ts";

// The FIPS-197 example key, standing in for the wire key the user supplies.
const TEST_KEY = Uint8Array.from({ length: 16 }, (_, i) => i);
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");

// From the reference encoder that reproduced a capture of the vendor updater byte for byte.
const GOLDEN = [
  {
    name: "an empty request",
    command: BootloaderCommand.readChipId,
    payload: "",
    padding: "a0a1a2a3a4a5a6a7a8a9aaabacad",
    frame: "bb0042907530f8584122f38ae6ef36fc9bb4fdee",
  },
  {
    name: "a write whose payload holds every escaped byte",
    command: BootloaderCommand.write,
    payload: "08003800000aaabbee0102aabbee0304",
    padding: "303132333435363738393a3b3c3d",
    frame: "bb076044c2ce96dd1bf17fe4b0ccecaf297e67e6223bf32a071ffcb83f18679b9b55c5ee",
  },
  {
    name: "an aligned payload, which still gets a full padding block",
    command: BootloaderCommand.readCheck,
    payload: "0000000000000000000000000000",
    padding: "55555555555555555555555555555555",
    frame: "bb03c846abf5e5514dd92bde03027407adfaa5548f94150184202f8200aa0aa9d02d566aee",
  },
];

describe("bootloaderFrame", () => {
  it.each(GOLDEN)("encodes and decodes $name", ({ command, payload, padding, frame }) => {
    const encoded = encodeCommandFrame(command, bytes(payload), TEST_KEY, bytes(padding));
    expect(hex(encoded)).toBe(frame);
    const decoded = Result.getOrThrow(decodeCommandFrame(encoded, TEST_KEY));
    expect({ ...decoded, payload: hex(decoded.payload), padding: hex(decoded.padding) }).toEqual({
      command,
      payload,
      padding,
    });
  });

  it("pads to the next block, never by zero bytes", () => {
    expect([0, 13, 14, 30].map(paddingLength)).toEqual([14, 1, 16, 16]);
    const frame = encodeCommandFrame(BootloaderCommand.run, bytes("08003800"), TEST_KEY);
    expect(Result.getOrThrow(decodeCommandFrame(frame, TEST_KEY)).padding).toHaveLength(10);
  });

  it("reads clear replies, unescaping the payload", () => {
    expect(Result.getOrThrow(decodeReplyFrame(bytes("bb200020ee")))).toEqual({
      command: BootloaderCommand.ack,
      payload: Uint8Array.of(0),
    });
    expect(Result.getOrThrow(decodeReplyFrame(bytes("bb00aa0baa0ea9ee"))).payload).toEqual(
      Uint8Array.of(0xbb, 0xee),
    );
  });

  it.each([
    ["no start byte", "200020ee", "delimiters"],
    ["no end byte", "bb200020", "delimiters"],
    ["an unknown escape", "bb20aa0120ee", "escape"],
    ["a wrong checksum", "bb200021ee", "checksum"],
    ["no checksum", "bb20ee", "length"],
  ])("rejects a reply with %s", (_, frame, reason) => {
    const result = decodeReplyFrame(bytes(frame));
    expect(Result.isFailure(result) && result.failure.reason).toBe(reason);
  });

  it("rejects a command whose ciphertext isn't whole blocks", () => {
    const result = decodeCommandFrame(bytes("bb070102030dee"), TEST_KEY);
    expect(Result.isFailure(result) && result.failure.reason).toBe("length");
  });
});
