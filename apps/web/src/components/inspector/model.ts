import type { EmulatorState, ReadinessMonitor, ReadinessMonitorId } from "@fme/contracts";
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

/** What the connected firmware accepts; null while disconnected, when edits wait for connect. */
export const connectedCapabilities = (state: EmulatorState) =>
  state.connection._tag === "connected" ? state.connection.capabilities : null;

export const NEEDS_LATEST_FIRMWARE = `firmware V${LATEST_OFFICIAL_FIRMWARE.version}`;
