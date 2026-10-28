import { describe, expect, it } from "vite-plus/test";
import {
  decodeDtc,
  isCanProtocol,
  isNoAnswer,
  parseDtcReply,
  parsePidReply,
  parseVinReply,
} from "./elm327.ts";

describe("ELM327 replies", () => {
  it.each([
    [["41 0C 1F 40"], "010C", [0x1f, 0x40]],
    [["7E8 03 41 0D 58", "41 0D 58"], "010D", [0x58]],
    [["SEARCHING...", "41 05 82"], "0105", [0x82]],
    [["NO DATA"], "0105", undefined],
  ])("reads PID data from %j", (lines, pid, bytes) => {
    expect(parsePidReply(lines, pid)).toEqual(bytes);
  });

  it.each([
    [0x01, 0x05, "P0105"],
    [0x03, 0x00, "P0300"],
    [0x41, 0x23, "C0123"],
    [0xc1, 0x00, "U0100"],
  ])("decodes DTC bytes %d %d as %s", (high, low, code) => {
    expect(decodeDtc(high, low)).toBe(code);
  });

  it("reads DTCs from CAN and legacy replies", () => {
    expect(parseDtcReply(["43 02 01 05 03 00"], 0x03, true)).toEqual(["P0105", "P0300"]);
    expect(parseDtcReply(["43 01 05 03 00 00 00"], 0x03, false)).toEqual(["P0105", "P0300"]);
    expect(parseDtcReply(["43 00"], 0x03, true)).toEqual([]);
  });

  it("reassembles a multi-frame CAN VIN", () => {
    expect(
      parseVinReply([
        "014",
        "0: 49 02 01 31 48 47",
        "1: 43 44 35 36 35 34 56",
        "2: 41 30 36 31 39 38 35",
      ]),
    ).toBe("1HGCD5654VA061985");
  });

  it("reassembles a legacy-bus VIN", () => {
    expect(
      parseVinReply([
        "49 02 01 00 00 00 31",
        "49 02 02 48 47 43 44",
        "49 02 03 35 36 35 34",
        "49 02 04 56 41 30 36",
        "49 02 05 31 39 38 35",
      ]),
    ).toBe("1HGCD5654VA061985");
  });

  it("recognizes silence and CAN protocols", () => {
    expect(isNoAnswer(["SEARCHING...", "UNABLE TO CONNECT"])).toBe(true);
    expect(isNoAnswer(["41 0C 1F 40"])).toBe(false);
    expect(isCanProtocol("A6")).toBe(true);
    expect(isCanProtocol("3")).toBe(false);
  });
});
