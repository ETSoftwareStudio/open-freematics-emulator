/**
 * Reads the firmware identity the MK2 prints on reset and compares it with the latest official
 * release. Flashing is left to the vendor's own updater; we only detect and point the user to it.
 */

export interface FirmwareInfo {
  /** The banner version, e.g. "1.2". */
  readonly version: string | null;
  /** Six-digit YYYYMM build code from the info line, e.g. "201910". */
  readonly buildCode: string | null;
  /** The build code as a label, e.g. "October 2019". */
  readonly buildLabel: string | null;
  readonly hardware: string | null;
  readonly serial: string | null;
}

export interface OfficialFirmware {
  readonly version: string;
  readonly buildCode: string;
  readonly buildLabel: string;
  /** Freematics' official GUI + firmware download page. */
  readonly downloadUrl: string;
}

/**
 * The newest image in the official GUI package (Firmware_MK2_20250311.hex, banner V1.3). Update
 * these three fields when Freematics publishes a newer one; the URL is the source of truth.
 */
export const LATEST_OFFICIAL_FIRMWARE: OfficialFirmware = {
  version: "1.3",
  buildCode: "202503",
  buildLabel: "March 2025",
  downloadUrl: "https://freematics.com/software/freematics-obd-emulator-gui/",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const labelForBuildCode = (code: string): string | null => {
  const month = Number(code.slice(4, 6));
  if (month < 1 || month > 12) return null;
  return `${MONTHS[month - 1]} ${code.slice(0, 4)}`;
};

/** `1.2` → `1002`, for an ordered comparison of major.minor versions. */
const versionRank = (version: string | null): number | null => {
  const match = version?.match(/^(\d+)\.(\d+)/);
  return match ? Number(match[1]) * 1000 + Number(match[2]) : null;
};

/**
 * Parses the reset banner (`OBD-II EMULATOR V1.2`) and info line
 * (`<fw>,<hw>,<YYYYMM>,<serial>,<vin>`) into firmware identity.
 */
export const parseFirmwareInfo = (banner: string | null, details: string | null): FirmwareInfo => {
  const version = banner?.match(/v\s*(\d+\.\d+)/i)?.[1] ?? null;
  const fields = details?.split(",").map((field) => field.trim()) ?? [];
  const buildCode = fields[2]?.match(/^\d{6}$/) ? fields[2]! : null;
  return {
    version,
    buildCode,
    buildLabel: buildCode === null ? null : labelForBuildCode(buildCode),
    hardware: fields[1] ?? null,
    serial: fields[3] ?? null,
  };
};

/** Freematics' changelog for GUI 1.2: "Do not update for devices before 2018". */
export const OLDEST_UPDATABLE_BUILD = "201801";

/**
 * When the unit was made, from its serial (`GH201910BN05928` → `201910`). The serial's date
 * matches the build date on the one unit we have; firmware alone can't date the hardware.
 */
export const manufactureCode = (info: FirmwareInfo): string | null => {
  const code = info.serial?.match(/^[A-Z]{2}(\d{6})/)?.[1] ?? null;
  return code !== null && labelForBuildCode(code) !== null ? code : null;
};

export const manufactureLabel = (info: FirmwareInfo): string | null => {
  const code = manufactureCode(info);
  return code === null ? null : labelForBuildCode(code);
};

/** Whether the official firmware is newer than what the device reports. */
const officialIsNewer = (info: FirmwareInfo): boolean | null => {
  const current = versionRank(info.version);
  const latest = versionRank(LATEST_OFFICIAL_FIRMWARE.version);
  if (current !== null && latest !== null && current !== latest) return current < latest;
  if (info.buildCode !== null) return info.buildCode < LATEST_OFFICIAL_FIRMWARE.buildCode;
  return null;
};

export type FirmwareUpdateStatus =
  /** A newer official image exists and this unit is new enough for it. */
  | "available"
  | "current"
  /** A newer image exists, but Freematics advises against it for units made before 2018. */
  | "too-old"
  /** A newer image exists, but the unit's age can't be read, so it isn't suggested. */
  | "unknown-age"
  | "unknown";

/** Unsure means no suggestion: a wrong flash on old hardware is the one costly mistake. */
export const firmwareUpdateStatus = (info: FirmwareInfo): FirmwareUpdateStatus => {
  const newer = officialIsNewer(info);
  if (newer === null) return "unknown";
  if (!newer) return "current";
  const made = manufactureCode(info);
  if (made !== null) return made < OLDEST_UPDATABLE_BUILD ? "too-old" : "available";
  // Firmware built before 2018 can only be on hardware from before 2018.
  if (info.buildCode !== null && info.buildCode < OLDEST_UPDATABLE_BUILD) return "too-old";
  return "unknown-age";
};

export const firmwareUpdateAvailable = (info: FirmwareInfo): boolean =>
  firmwareUpdateStatus(info) === "available";
