import type {
  DeviceCapabilities,
  DtcMode,
  ReadinessMonitor,
  ReadinessMonitorId,
  UnsentEdit,
} from "@fme/contracts";
import type { DtcEntry } from "@fme/shared/dtcs";
import { LATEST_OFFICIAL_FIRMWARE } from "@fme/shared/firmware";
import { PIDS, type PidDefinition, type PidGroup } from "@fme/shared/pids";
import { READINESS_MONITOR_IDS } from "@fme/shared/readiness";

/** Whether `words` contain the inspector's filter, which comes trimmed and lower-cased. */
export const matchesFilter = (filter: string, words: string) =>
  filter === "" || words.toLowerCase().includes(filter);

/**
 * The rows of one inspector group the filter keeps: all of them when the group's own words match,
 * else the rows whose words do. `keywords` is what `InspectorGroup` matches, so the group shows
 * exactly when a row does.
 */
export const filterGroupRows = <Row>(
  filter: string,
  groupWords: string,
  rows: ReadonlyArray<Row>,
  wordsOf: (row: Row) => string,
) => {
  const shown = matchesFilter(filter, groupWords)
    ? rows
    : rows.filter((row) => matchesFilter(filter, wordsOf(row)));
  // Rows are joined by a newline, which the filter field can't hold, so no match spans two rows.
  return {
    rows: shown,
    keywords: shown.length > 0 ? [groupWords, ...shown.map(wordsOf)].join("\n") : "",
  };
};

export const pidWords = (definition: PidDefinition) =>
  `${definition.name} ${definition.id} ${definition.unit}`;

/** The inspector's order: the cluster already shows speed and RPM, so temperatures lead. */
export const INSPECTOR_PID_GROUPS: ReadonlyArray<PidGroup> = [
  "Temperatures",
  "Engine",
  "Air & fuel",
  "Throttle",
  "Speed & distance",
  "Emissions",
];

export const pidsInGroup = (group: PidGroup) => PIDS.filter((pid) => pid.group === group);

/** A catalog entry matches on the start of its code or anywhere in its description. */
export const matchesDtcQuery = (entry: DtcEntry, query: string) => {
  const needle = query.trim().toLowerCase();
  return (
    entry.code.toLowerCase().startsWith(needle) || entry.description.toLowerCase().includes(needle)
  );
};

export type MonitorStatus = "complete" | "incomplete" | "unsupported";

export const monitorStatus = (monitor: ReadinessMonitor): MonitorStatus =>
  !monitor.supported ? "unsupported" : monitor.complete ? "complete" : "incomplete";

export const monitorFromStatus = (status: MonitorStatus): ReadinessMonitor => ({
  supported: status !== "unsupported",
  complete: status === "complete",
});

/** How many supported monitors have completed, as a scan tool's readiness check counts them. */
export const readinessProgress = (
  readiness: Readonly<Record<ReadinessMonitorId, ReadinessMonitor>>,
) => {
  const supported = READINESS_MONITOR_IDS.filter((id) => readiness[id].supported);
  return {
    supported: supported.length,
    complete: supported.filter((id) => readiness[id].complete).length,
  };
};

export type FirmwareFeature = DtcMode | "calibrationId";
export type FirmwareSupport = "supported" | "unsupported" | "unknown";

/**
 * Whether the firmware takes a feature, from what it took on the last connect. Every firmware takes
 * stored codes; anything else is unknown until the first connect, when V1.2 would drop it.
 */
export const firmwareSupport = (
  capabilities: DeviceCapabilities | null,
  feature: FirmwareFeature,
): FirmwareSupport => {
  if (feature === "03") return "supported";
  if (capabilities === null) return "unknown";
  const supported =
    feature === "calibrationId"
      ? capabilities.calibrationId
      : capabilities.dtcModes.includes(feature);
  return supported ? "supported" : "unsupported";
};

/**
 * What a locked control says, and its tooltip. Freematics publishes no changelog: V1.2 rejecting
 * these is observed, V1.3 having them is only inferred from strings in its image.
 */
export const firmwareLock = (support: FirmwareSupport, version: string | null) => {
  switch (support) {
    case "supported":
      return null;
    case "unknown":
      return {
        label: "Connect to check firmware support",
        title: "The emulator's firmware is checked on connect. Some firmware rejects this setting.",
      };
    case "unsupported":
      return {
        label: version === null ? "Not on this firmware" : `Not supported by V${version}`,
        title: `This firmware rejects the command. The official V${LATEST_OFFICIAL_FIRMWARE.version} image includes it, so updating may add it.`,
      };
  }
};

export const DTC_MODE_LABELS: Readonly<Record<DtcMode, string>> = {
  "03": "Stored",
  "07": "Pending",
  "0A": "Permanent",
};

/** Why an edit staged while disconnected didn't reach the device. */
export const unsentNote = (edit: UnsentEdit) => {
  if (edit._tag === "calibrationId") {
    return `Calibration ID ${edit.calibrationId} wasn't sent: this firmware doesn't support it.`;
  }
  const one = edit.codes.length === 1;
  return `${DTC_MODE_LABELS[edit.mode]} ${one ? "code" : "codes"} ${edit.codes.join(", ")} ${one ? "wasn't" : "weren't"} sent: this firmware doesn't support Mode ${edit.mode}.`;
};
