import type { DtcCode, DtcMode, ObdProtocol, PidId } from "@fme/contracts";

/**
 * Builders for the MK2 control command set. The firmware answers commands with `OK`
 * or `ERROR`, and `ATGET` queries with a single value line.
 */
export const AT = {
  echo: (on: boolean) => (on ? "ATE1" : "ATE0"),
  debugOutput: (on: boolean) => (on ? "ATINF1" : "ATINF0"),
  ignition: (on: boolean) => (on ? "ATACC1" : "ATACC0"),
  vinResponse: (on: boolean) => (on ? "ATVIN1" : "ATVIN0"),
  reset: "ATR",
  init: "ATZ",
  setProtocol: (protocol: ObdProtocol) => `ATBUS ${protocol}`,
  getProtocol: "ATGET BUS",
  setVin: (vin: string) => `ATSET VIN=${vin}`,
  getVin: "ATGET VIN",
  setCalibrationId: (calibrationId: string) => `ATSET CALID=${calibrationId}`,
  getCalibrationId: "ATGET CALID",
  setDtcs: (mode: DtcMode, codes: ReadonlyArray<DtcCode>) =>
    `ATSET ${mode === "03" ? "DTC" : mode === "07" ? "DTC7" : "DTCA"}=${codes.join(",")}`,
  clearDtcs: "ATCLR DTC",
  setPidDecimal: (pid: PidId, value: number) => `ATSET ${pid}=${value}`,
  setPidRaw: (pid: PidId, bytes: ReadonlyArray<number>) =>
    `ATSET ${pid}=${bytes.map((byte) => `0x${byte.toString(16).padStart(2, "0").toUpperCase()}`).join(",")}`,
  getPid: (pid: PidId) => `ATGET ${pid}`,
} as const;

export const isOkLine = (line: string) => line === "OK";
export const isErrorLine = (line: string) => line.includes("ERROR");

/** Parses `ATSET <PID>=` raw values: `0x31,0x64` or `31,64` style byte lists. */
export const parseRawBytes = (value: string): ReadonlyArray<number> | undefined => {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length < 2 && !/^0x/i.test(parts[0] ?? "")) return undefined;
  const bytes = parts.map((part) => Number.parseInt(part.replace(/^0x/i, ""), 16));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : undefined;
};

export const formatHexBytes = (bytes: ReadonlyArray<number>) =>
  bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
