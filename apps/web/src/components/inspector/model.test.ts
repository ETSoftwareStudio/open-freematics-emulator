import type { DtcCode } from "@fme/contracts";
import { DTC_CATALOG } from "@fme/shared/dtcs";
import { PID_GROUPS, PIDS, type PidDefinition } from "@fme/shared/pids";
import { describe, expect, it } from "vite-plus/test";
import {
  INSPECTOR_PID_GROUPS,
  filterGroupRows,
  firmwareLock,
  firmwareSupport,
  matchesDtcQuery,
  monitorFromStatus,
  monitorStatus,
  pidWords,
  readinessProgress,
  unsentNote,
} from "./model.ts";

const temperatures = PIDS.filter((pid) => pid.group === "Temperatures");
const filterPids = (filter: string, groupWords = "Temperatures") =>
  filterGroupRows(filter, groupWords, temperatures, pidWords);
const ids = (rows: ReadonlyArray<PidDefinition>) => rows.map((pid) => pid.id);

describe("inspector filter", () => {
  it("keeps every row when the filter is empty or matches the group itself", () => {
    expect(filterPids("").rows).toHaveLength(temperatures.length);
    expect(filterPids("temperatures").rows).toHaveLength(temperatures.length);
  });

  it("finds PIDs by name, code and unit, ignoring case", () => {
    expect(ids(filterPids("coolant").rows)).toEqual(["0105"]);
    expect(ids(filterPids("015c").rows)).toEqual(["015C"]);
    expect(filterPids("°c").rows).toHaveLength(temperatures.length);
  });

  it("hides the group when no row matches, even across row boundaries", () => {
    expect(filterPids("rpm").keywords).toBe("");
    const lastWordOfOne = pidWords(temperatures[0]!).split(" ").at(-1)!.toLowerCase();
    const firstWordOfNext = pidWords(temperatures[1]!).split(" ")[0]!.toLowerCase();
    expect(filterPids(`${lastWordOfOne} ${firstWordOfNext}`).keywords).toBe("");
  });

  it("gives the group keywords that contain the filter when a row matches", () => {
    expect(filterPids("oil").keywords).toContain("oil");
  });

  it("lists every PID group once", () => {
    expect([...INSPECTOR_PID_GROUPS].sort()).toEqual([...PID_GROUPS].sort());
  });
});

describe("trouble code search", () => {
  const misfire = DTC_CATALOG.find((entry) => entry.code === "P0300")!;

  it("matches the start of a code or any part of the description", () => {
    expect(matchesDtcQuery(misfire, "p03")).toBe(true);
    expect(matchesDtcQuery(misfire, "0300")).toBe(false);
    expect(matchesDtcQuery(misfire, " Misfire ")).toBe(true);
  });
});

describe("readiness monitors", () => {
  it("round-trips each status through the monitor flags", () => {
    for (const status of ["complete", "incomplete", "unsupported"] as const) {
      expect(monitorStatus(monitorFromStatus(status))).toBe(status);
    }
    expect(monitorStatus({ supported: false, complete: true })).toBe("unsupported");
  });

  it("counts completed monitors among the supported ones", () => {
    const monitor = (supported: boolean, complete: boolean) => ({ supported, complete });
    const readiness = {
      misfire: monitor(true, true),
      fuelSystem: monitor(true, false),
      components: monitor(true, true),
      catalyst: monitor(true, false),
      heatedCatalyst: monitor(false, true),
      evaporativeSystem: monitor(false, false),
      secondaryAirSystem: monitor(false, false),
      acRefrigerant: monitor(false, false),
      oxygenSensor: monitor(true, true),
      oxygenSensorHeater: monitor(false, false),
      egrSystem: monitor(false, false),
    };
    expect(readinessProgress(readiness)).toEqual({ supported: 5, complete: 3 });
  });
});

describe("firmware support", () => {
  const v12 = { dtcModes: ["03" as const], calibrationId: false };
  const v13 = { dtcModes: ["03" as const, "07" as const, "0A" as const], calibrationId: true };

  it("is unknown before the first connect, except for stored codes", () => {
    expect(firmwareSupport(null, "03")).toBe("supported");
    expect(firmwareSupport(null, "07")).toBe("unknown");
    expect(firmwareSupport(null, "calibrationId")).toBe("unknown");
  });

  it("follows what the firmware took on the last connect", () => {
    expect(firmwareSupport(v12, "0A")).toBe("unsupported");
    expect(firmwareSupport(v12, "calibrationId")).toBe("unsupported");
    expect(firmwareSupport(v13, "0A")).toBe("supported");
    expect(firmwareSupport(v13, "calibrationId")).toBe("supported");
  });

  it("asks to connect while unknown and never promises an update adds a feature", () => {
    expect(firmwareLock("supported", "1.2")).toBeNull();
    expect(firmwareLock("unknown", null)?.label).toBe("Connect to check firmware support");
    expect(firmwareLock("unsupported", "1.2")?.label).toBe("Not supported by V1.2");
    expect(firmwareLock("unsupported", null)?.label).toBe("Not on this firmware");
    expect(firmwareLock("unsupported", "1.2")?.title).toMatch(/may add it/);
  });

  it("says which staged edits weren't sent and why", () => {
    expect(unsentNote({ _tag: "dtcs", mode: "07", codes: ["P0420" as DtcCode] })).toBe(
      "Pending code P0420 wasn't sent: this firmware doesn't support Mode 07.",
    );
    expect(
      unsentNote({ _tag: "dtcs", mode: "0A", codes: ["P0171", "P0174"] as Array<DtcCode> }),
    ).toBe("Permanent codes P0171, P0174 weren't sent: this firmware doesn't support Mode 0A.");
    expect(unsentNote({ _tag: "calibrationId", calibrationId: "CAL-1" })).toBe(
      "Calibration ID CAL-1 wasn't sent: this firmware doesn't support it.",
    );
  });
});
