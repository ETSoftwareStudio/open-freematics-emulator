import { describe, expect, it } from "vite-plus/test";
import {
  LATEST_OFFICIAL_FIRMWARE,
  firmwareUpdateAvailable,
  parseFirmwareInfo,
} from "./firmware.ts";

describe("firmware", () => {
  it("reads the version and build date a V1.2 unit reports", () => {
    const info = parseFirmwareInfo(
      "OBD-II EMULATOR V1.2",
      "00.00.02,00.01.05,201910,GH201910BN05928,1HGCD5654VA061985",
    );
    expect(info).toEqual({
      version: "1.2",
      buildCode: "201910",
      buildLabel: "October 2019",
      hardware: "00.01.05",
      serial: "GH201910BN05928",
    });
  });

  it("copes with a missing or short info line", () => {
    expect(parseFirmwareInfo("OBD-II EMULATOR V1.3", null)).toMatchObject({
      version: "1.3",
      buildCode: null,
      buildLabel: null,
    });
    expect(parseFirmwareInfo(null, null).version).toBeNull();
  });

  it("flags an update when the device is behind the latest release", () => {
    expect(firmwareUpdateAvailable(parseFirmwareInfo("…V1.2", "x,y,201910,z"))).toBe(true);
  });

  it("reports no update once the device is on the latest version", () => {
    const latest = `…V${LATEST_OFFICIAL_FIRMWARE.version}`;
    expect(firmwareUpdateAvailable(parseFirmwareInfo(latest, "x,y,202503,z"))).toBe(false);
  });

  it("uses the build date when the version is the same", () => {
    const current = `…V${LATEST_OFFICIAL_FIRMWARE.version}`;
    expect(firmwareUpdateAvailable(parseFirmwareInfo(current, "x,y,202403,z"))).toBe(true);
  });

  it("stays quiet when the identity can't be read", () => {
    expect(firmwareUpdateAvailable(parseFirmwareInfo(null, null))).toBe(false);
  });
});
