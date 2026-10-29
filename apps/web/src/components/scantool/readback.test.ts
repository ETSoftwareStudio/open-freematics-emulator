import type { PidId, TrafficEntry } from "@fme/contracts";
import { encodeMonitorStatus } from "@fme/shared/readiness";
import { findPid } from "@fme/shared/pids";
import { makeDefaultState } from "@fme/shared/defaultState";
import { describe, expect, it } from "vite-plus/test";
import { compareReading, decodeMonitorStatus, trafficMentionsPid } from "./readback.ts";

const rpm = findPid("010C");
const fuel = findPid("012F");
const reading = (raw: ReadonlyArray<number>, at = 100) => ({ value: 0, raw, at });

describe("readback comparison", () => {
  it("tells an exact match from one rounded by the encoding step", () => {
    expect(compareReading(rpm, 3000, reading([0x2e, 0xe0]), false, 0)).toBe("match");
    expect(compareReading(fuel, 64, reading(fuel!.encode(64)), false, 0)).toBe("rounded");
    expect(compareReading(rpm, 3000, reading([0x2e, 0xe4]), false, 0)).toBe("mismatch");
  });

  it("waits for a poll newer than the emulator's last change", () => {
    expect(compareReading(rpm, 3000, undefined, false, 0)).toBe("waiting");
    expect(compareReading(rpm, 3000, reading([0x00, 0x00], 100), false, 200)).toBe("waiting");
    expect(compareReading(rpm, 3000, reading([0x2e, 0xe0]), true, 0)).toBe("no-answer");
  });
});

describe("monitor status", () => {
  it("decodes what the emulator encodes", () => {
    const { readiness } = makeDefaultState();
    const decoded = decodeMonitorStatus(encodeMonitorStatus(readiness, 0));
    for (const monitor of decoded) {
      expect({ supported: monitor.supported, complete: monitor.complete }).toEqual({
        supported: readiness[monitor.id].supported,
        complete: readiness[monitor.id].supported && readiness[monitor.id].complete,
      });
    }
  });
});

describe("traffic for a PID", () => {
  const entry = (
    channel: TrafficEntry["channel"],
    direction: TrafficEntry["direction"],
    text: string,
  ) => ({ sequence: 1, at: 0, channel, direction, text }) satisfies TrafficEntry;

  it("matches the request, its answer and the emulator's set command", () => {
    const pid = "010C" as PidId;
    expect(trafficMentionsPid(entry("reader", "tx", "010C"), pid)).toBe(true);
    expect(trafficMentionsPid(entry("reader", "rx", "41 0C 2E E0"), pid)).toBe(true);
    expect(trafficMentionsPid(entry("emulator", "tx", "ATSET 010C=2E,E0"), pid)).toBe(true);
    expect(trafficMentionsPid(entry("reader", "rx", "41 0D 48"), pid)).toBe(false);
    expect(trafficMentionsPid(entry("reader", "tx", "010D"), pid)).toBe(false);
  });
});
