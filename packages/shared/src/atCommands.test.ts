import { describe, expect, it } from "vite-plus/test";
import type { DtcCode, PidId } from "@fme/contracts";
import { AT, parseRawBytes } from "./atCommands.ts";
import { makeLineFramer } from "./lineFramer.ts";
import { PIDS, clampPidValue, findPid } from "./pids.ts";
import { encodeMonitorStatus } from "./readiness.ts";
import { makeDefaultState } from "./defaultState.ts";

describe("AT commands", () => {
  it("formats raw PID bytes the way the firmware documents them", () => {
    expect(AT.setPidRaw("010C" as PidId, [0x1f, 0x40])).toBe("ATSET 010C=0x1F,0x40");
  });

  it("maps each DTC mode to its command", () => {
    const codes = ["P0105", "P0106"] as Array<DtcCode>;
    expect(AT.setDtcs("03", codes)).toBe("ATSET DTC=P0105,P0106");
    expect(AT.setDtcs("07", codes)).toBe("ATSET DTC7=P0105,P0106");
    expect(AT.setDtcs("0A", codes)).toBe("ATSET DTCA=P0105,P0106");
  });

  it.each([
    ["0x31,0x64", [0x31, 0x64]],
    ["31,64", [0x31, 0x64]],
    ["0xFF", [0xff]],
    ["2000", undefined],
    ["0x1FF", undefined],
  ])("parses raw value %s", (input, expected) => {
    expect(parseRawBytes(input)).toEqual(expected);
  });
});

describe("line framer", () => {
  it("joins lines split across chunks and drops blanks", () => {
    const frame = makeLineFramer();
    expect(frame("O")).toEqual([]);
    expect(frame("K\r\n\r1FA")).toEqual(["OK"]);
    expect(frame("FP45S5\rERROR\r")).toEqual(["1FAFP45S5", "ERROR"]);
  });
});

describe("PID encoding", () => {
  it.each([
    ["010C", 2000, [0x1f, 0x40]],
    ["0105", 90, [130]],
    ["010D", 50, [50]],
    ["0111", 100, [255]],
    ["0142", 14.2, [0x37, 0x78]],
    ["010E", -64, [0]],
  ])("encodes %s=%d", (id, value, bytes) => {
    expect(findPid(id)?.encode(value)).toEqual(bytes);
  });

  it("decodes what it encodes to within one step of resolution", () => {
    for (const p of PIDS) {
      for (const value of [p.min, p.defaultValue, p.max]) {
        expect(Math.abs(p.decode(p.encode(value)) - value)).toBeLessThanOrEqual(0.5 + p.step);
      }
    }
  });

  it("snaps values to the PID's step without float noise", () => {
    const voltage = findPid("0142")!;
    expect(clampPidValue(voltage, 14.23)).toBe(14.2);
    expect(clampPidValue(voltage, 99)).toBe(65);
  });

  it("has unique ids and defaults inside their range", () => {
    expect(new Set(PIDS.map((p) => p.id)).size).toBe(PIDS.length);
    for (const p of PIDS) expect(clampPidValue(p, p.defaultValue)).toBe(p.defaultValue);
  });
});

describe("monitor status (PID 0101)", () => {
  it("matches the official GUI's defaults with no DTCs", () => {
    expect(encodeMonitorStatus(makeDefaultState().readiness, 0)).toEqual([0x00, 0x07, 0xff, 0x00]);
  });

  it("lights the MIL and counts stored codes", () => {
    expect(encodeMonitorStatus(makeDefaultState().readiness, 2)[0]).toBe(0x82);
  });

  it("flags supported monitors that have not completed", () => {
    const readiness = {
      ...makeDefaultState().readiness,
      misfire: { supported: true, complete: false },
      catalyst: { supported: true, complete: false },
      egrSystem: { supported: false, complete: false },
    };
    expect(encodeMonitorStatus(readiness, 0)).toEqual([0x00, 0x17, 0x7f, 0x01]);
  });
});
