import { DTC_CATALOG } from "@fme/shared/dtcs";
import { PID_GROUPS, PIDS, type PidDefinition } from "@fme/shared/pids";
import { describe, expect, it } from "vite-plus/test";
import {
  INSPECTOR_PID_GROUPS,
  filterGroupRows,
  matchesDtcQuery,
  monitorFromStatus,
  monitorStatus,
  pidWords,
  readinessProgress,
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
