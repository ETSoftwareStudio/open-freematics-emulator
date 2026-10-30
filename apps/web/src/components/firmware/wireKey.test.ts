import { describe, expect, it } from "vite-plus/test";
import { parseWireKeyFile } from "./wireKey";

const KEY = "000102030405060708090a0b0c0d0e0f";
const text = (value: string) => new TextEncoder().encode(value);

describe("parseWireKeyFile", () => {
  it.each([
    ["16 raw bytes", Uint8Array.from({ length: 16 }, (_, i) => i), KEY],
    ["16 raw bytes that aren't text", new Uint8Array(16).fill(0xff), "f".repeat(32)],
    ["32 hex digits", text(KEY), KEY],
    ["upper-case digits with a trailing newline", text(`${KEY.toUpperCase()}\n`), KEY],
    ["digits wrapped in whitespace", text(`  ${KEY}\r\n`), KEY],
  ])("reads %s", (_, bytes, key) => {
    expect(parseWireKeyFile(bytes)).toBe(key);
  });

  it.each([
    ["an empty file", new Uint8Array()],
    ["31 hex digits", text(KEY.slice(1))],
    ["33 hex digits", text(`${KEY}0`)],
    ["a non-hex digit", text(`${KEY.slice(1)}g`)],
    ["spaced bytes", text(KEY.match(/../g)!.join(" "))],
    ["15 raw bytes", new Uint8Array(15)],
    ["17 raw bytes", new Uint8Array(17)],
    ["a large file", new Uint8Array(4096)],
  ])("rejects %s", (_, bytes) => {
    expect(parseWireKeyFile(bytes)).toBeNull();
  });
});
