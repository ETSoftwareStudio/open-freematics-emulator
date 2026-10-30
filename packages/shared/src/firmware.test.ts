import { describe, expect, it } from "vite-plus/test";
import {
  LATEST_OFFICIAL_FIRMWARE,
  firmwareUpdateAvailable,
  firmwareUpdateStatus,
  manufactureLabel,
  parseFirmwareInfo,
} from "./firmware.ts";

describe("firmware", () => {
  it("reads the version and date a V1.2 unit reports", () => {
    const info = parseFirmwareInfo(
      "OBD-II EMULATOR V1.2",
      "00.00.02,00.01.05,201910,GH201910BN05928,1HGCD5654VA061985",
    );
    expect(info).toEqual({
      version: "1.2",
      dateCode: "201910",
      hardware: "00.01.05",
      serial: "GH201910BN05928",
    });
  });

  it("copes with a missing or short info line", () => {
    expect(parseFirmwareInfo("OBD-II EMULATOR V1.3", null)).toMatchObject({
      version: "1.3",
      dateCode: null,
    });
    expect(parseFirmwareInfo(null, null).version).toBeNull();
  });

  it("flags an update when the device is behind the latest release", () => {
    expect(firmwareUpdateAvailable(parseFirmwareInfo("…V1.2", "x,y,201910,GH201910BN05928"))).toBe(
      true,
    );
  });

  it("dates the unit from its serial", () => {
    expect(manufactureLabel(parseFirmwareInfo("…V1.2", "x,y,201910,GH201910BN05928"))).toBe(
      "October 2019",
    );
    expect(manufactureLabel(parseFirmwareInfo("…V1.2", "x,y,201910,12345"))).toBeNull();
  });

  it("doesn't suggest the update for units made before 2018", () => {
    expect(firmwareUpdateStatus(parseFirmwareInfo("…V1.2", "x,y,201910,GH201706AA00001"))).toBe(
      "too-old",
    );
    expect(firmwareUpdateStatus(parseFirmwareInfo("…V1.1", "x,y,201705,"))).toBe("too-old");
  });

  it("doesn't suggest the update when the unit's age can't be read", () => {
    const info = parseFirmwareInfo("…V1.2", "x,y,201910,");
    expect(firmwareUpdateStatus(info)).toBe("unknown-age");
    expect(firmwareUpdateAvailable(info)).toBe(false);
  });

  it("reports no update once the device is on the latest version", () => {
    const latest = `…V${LATEST_OFFICIAL_FIRMWARE.version}`;
    expect(firmwareUpdateAvailable(parseFirmwareInfo(latest, "x,y,202503,z"))).toBe(false);
  });

  // A real 2019 unit flashed to V1.3 still reports 201910 in the date field.
  it("reports no update for a unit flashed to the latest version", () => {
    const info = parseFirmwareInfo(
      "OBD-II EMULATOR V1.3",
      "00.00.02,00.01.08,201910,GH201910BN05928,LSGGG54EXE105928",
    );
    expect(firmwareUpdateStatus(info)).toBe("current");
  });

  it("stays quiet when the identity can't be read", () => {
    expect(firmwareUpdateAvailable(parseFirmwareInfo(null, null))).toBe(false);
  });
});
