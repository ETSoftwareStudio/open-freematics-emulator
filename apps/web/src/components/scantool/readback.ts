import type {
  EmulatorState,
  PidId,
  PidReading,
  ReadinessMonitorId,
  ReaderState,
  TrafficEntry,
} from "@fme/contracts";
import { findPid, type PidDefinition } from "@fme/shared/pids";
import { READINESS_MONITORS, READINESS_MONITOR_IDS } from "@fme/shared/readiness";

export type ResultKind =
  | "match"
  | "rounded"
  | "mismatch"
  | "waiting"
  | "no-answer"
  | "unchecked"
  | "offline";

export interface ReadbackRow {
  readonly pid: PidId;
  readonly name: string;
  readonly unit: string;
  readonly definition: PidDefinition | undefined;
  /** What the emulator is set to; null for PIDs outside the catalog it hasn't been set to. */
  readonly set: number | null;
  readonly reading: PidReading | undefined;
  readonly result: ResultKind;
}

const sameBytes = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Compares what the emulator serves with what the scan tool read. A reading older than the
 * emulator's last change to that PID predates the change, so it waits rather than mismatches.
 */
export const compareReading = (
  definition: PidDefinition | undefined,
  set: number | null,
  reading: PidReading | undefined,
  unanswered: boolean,
  staleThrough: number,
): ResultKind => {
  if (unanswered) return "no-answer";
  if (reading === undefined || reading.at <= staleThrough) return "waiting";
  if (definition === undefined || set === null) return "unchecked";
  if (!sameBytes(reading.raw, definition.encode(set))) return "mismatch";
  return Math.abs(definition.decode(reading.raw) - set) < 1e-9 ? "match" : "rounded";
};

export const buildRows = (
  watching: ReadonlyArray<PidId>,
  emulator: EmulatorState | null,
  reader: ReaderState | null,
  staleThrough: Readonly<Record<string, number>>,
): ReadonlyArray<ReadbackRow> => {
  const connected = reader?.connection._tag === "connected";
  return watching.map((pid) => {
    const definition = findPid(pid);
    const set = emulator?.pids[pid] ?? definition?.defaultValue ?? null;
    const reading = connected ? reader.readings[pid] : undefined;
    const unanswered = connected && reader.unanswered.includes(pid);
    return {
      pid,
      name: definition?.name ?? "Not in the catalog",
      unit: definition?.unit ?? "",
      definition,
      set,
      reading,
      result: connected
        ? compareReading(definition, set, reading, unanswered, staleThrough[pid] ?? -1)
        : "offline",
    };
  });
};

export type SortKey = "pid" | "name" | "set" | "read" | "result" | "age";
export interface Sort {
  readonly key: SortKey;
  readonly direction: "asc" | "desc";
}

const RESULT_ORDER: Record<ResultKind, number> = {
  mismatch: 0,
  "no-answer": 1,
  waiting: 2,
  unchecked: 3,
  rounded: 4,
  match: 5,
  offline: 6,
};

const sortValue = (row: ReadbackRow, key: SortKey, now: number): string | number => {
  switch (key) {
    case "pid":
      return row.pid;
    case "name":
      return row.name;
    case "set":
      return row.set ?? -Infinity;
    case "read":
      return row.reading?.value ?? -Infinity;
    case "result":
      return RESULT_ORDER[row.result];
    case "age":
      return row.reading === undefined ? Infinity : now - row.reading.at;
  }
};

export const sortRows = (rows: ReadonlyArray<ReadbackRow>, sort: Sort | null, now: number) => {
  if (sort === null) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows.toSorted((a, b) => {
    const x = sortValue(a, sort.key, now);
    const y = sortValue(b, sort.key, now);
    return sign * (typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y));
  });
};

const decimalsOf = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

/** The emulator value at the PID's step; a reading with at least one decimal when it isn't whole. */
export const formatValue = (value: number, definition: PidDefinition | undefined, read = false) => {
  const stepDecimals = definition === undefined ? 0 : decimalsOf(definition.step);
  const decimals = read && !Number.isInteger(value) ? Math.max(1, stepDecimals) : stepDecimals;
  return value
    .toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
    .replace("-", "−");
};

export const formatAge = (ms: number) => {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 120) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
};

/** Whether a traffic line is a request for `pid` or its answer, from either side. */
export const trafficMentionsPid = (entry: TrafficEntry, pid: PidId) => {
  const text = entry.text.replaceAll(" ", "").toUpperCase();
  if (entry.channel === "emulator") return entry.direction === "tx" && text.includes(pid);
  return entry.direction === "tx" ? text === pid : text.startsWith(`41${pid.slice(2)}`);
};

export interface MonitorReadback {
  readonly id: ReadinessMonitorId;
  readonly label: string;
  readonly supported: boolean;
  readonly complete: boolean;
}

/** Monitor bits from PID 0101 bytes B–D, the inverse of `encodeMonitorStatus`. */
export const decodeMonitorStatus = (bytes: ReadonlyArray<number>): ReadonlyArray<MonitorReadback> =>
  READINESS_MONITOR_IDS.map((id) => {
    const bits = READINESS_MONITORS[id];
    const bit = ([index, shift]: readonly [number, number]) =>
      ((bytes[index] ?? 0) & (1 << shift)) !== 0;
    const supported = bit(bits.supported);
    return { id, label: bits.label, supported, complete: supported && !bit(bits.incomplete) };
  });

/** PID 0101 byte A: the MIL bit. */
export const milOn = (bytes: ReadonlyArray<number>) => ((bytes[0] ?? 0) & 0x80) !== 0;
