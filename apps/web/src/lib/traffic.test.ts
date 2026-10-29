import type { TrafficEntry } from "@fme/contracts";
import { describe, expect, it } from "vite-plus/test";
import { lastAck } from "./traffic";

let sequence = 0;
const entry = (
  channel: TrafficEntry["channel"],
  direction: TrafficEntry["direction"],
  text: string,
  at: number,
): TrafficEntry => ({ sequence: ++sequence, channel, direction, text, at });

describe("lastAck", () => {
  it("pairs the newest OK with the command it answered", () => {
    const traffic = [
      entry("emulator", "tx", "ATSET 010C=2FA8", 1000),
      entry("emulator", "rx", "OK", 1018),
      entry("emulator", "tx", "ATSET 010C=3070", 2000),
      entry("reader", "tx", "010C", 2005),
      entry("emulator", "rx", "OK", 2018),
      entry("reader", "rx", "41 0C 30 70", 2040),
    ];
    expect(lastAck(traffic)).toEqual({ command: "ATSET 010C=3070", latencyMs: 18 });
  });

  it("skips replies that are not OK", () => {
    const traffic = [
      entry("emulator", "tx", "ATE0", 0),
      entry("emulator", "rx", "OK", 5),
      entry("emulator", "tx", "ATSET 0199=00", 10),
      entry("emulator", "rx", "ERROR", 30),
    ];
    expect(lastAck(traffic)).toEqual({ command: "ATE0", latencyMs: 5 });
  });

  it("is null before anything was acknowledged", () => {
    expect(lastAck([])).toBeNull();
    expect(lastAck([entry("emulator", "tx", "ATE0", 0)])).toBeNull();
  });
});
