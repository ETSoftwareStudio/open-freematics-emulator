import { describe, expect, it } from "vite-plus/test";
import { DTC_CATALOG, PIDS_RESET_BY_CLEAR, describeDtc } from "./dtcs.ts";
import { findPid } from "./pids.ts";

describe("DTC catalog", () => {
  it("lists each code once, in a valid format", () => {
    const codes = DTC_CATALOG.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[PCBU][0-3][0-9A-F]{3}$/);
  });

  it("names known codes regardless of case", () => {
    expect(describeDtc("p0420")).toEqual({
      description: "Catalyst system efficiency below threshold (bank 1)",
      known: true,
    });
    expect(describeDtc("P0304").description).toBe("Cylinder 4 misfire detected");
  });

  it("falls back to the system and who defines the code", () => {
    expect(describeDtc("P1234")).toEqual({
      description: "Manufacturer-specific powertrain code",
      known: false,
    });
    expect(describeDtc("B0999").description).toBe("Generic body code");
    expect(describeDtc("U3001").description).toBe("Manufacturer-specific network code");
  });

  it("resets only counters the PID catalog knows", () => {
    for (const pid of PIDS_RESET_BY_CLEAR) expect(findPid(pid)).toBeDefined();
  });
});
