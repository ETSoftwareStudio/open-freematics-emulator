import type { PidId, PresetPids } from "@fme/contracts";
import { findPid } from "@fme/shared/pids";
import type { PresetChange } from "@fme/shared/presets";

const RPM = "010C" as PidId;
const SPEED = "010D" as PidId;
const THROTTLE = "0111" as PidId;
const COOLANT = "0105" as PidId;

const SHORT_LABELS: Readonly<Record<string, string>> = {
  "010C": "RPM",
  "010D": "Speed",
  "0104": "Load",
  "0143": "Abs. load",
  "0111": "Throttle",
  "0149": "Pedal",
  "010B": "MAP",
  "0110": "MAF",
  "015E": "Fuel rate",
  "010E": "Timing",
  "0105": "Coolant",
  "010F": "Intake air",
  "015C": "Oil",
  "0146": "Ambient",
};

const decimals = (step: number) =>
  Number.isInteger(step) ? 0 : (`${step}`.split(".")[1]?.length ?? 0);

export const formatValue = (pid: PidId, value: number) =>
  value.toLocaleString(undefined, {
    maximumFractionDigits: decimals(findPid(pid)?.step ?? 1),
  });

const withUnit = (pid: PidId, value: number) => {
  const unit = findPid(pid)?.unit ?? "";
  return unit === "" ? formatValue(pid, value) : `${formatValue(pid, value)} ${unit}`;
};

export const pidLabel = (pid: PidId, form: "short" | "full") =>
  (form === "short" ? SHORT_LABELS[pid] : undefined) ?? findPid(pid)?.name ?? pid;

/**
 * One line under a preset's name saying what makes it that scenario: an out-of-range coolant,
 * a wide throttle, the road speed, or the idle RPM.
 */
export const presetSummary = (pids: PresetPids) => {
  const coolant = pids[COOLANT];
  const rpm = pids[RPM];
  const throttle = pids[THROTTLE];
  const speed = pids[SPEED];
  if (coolant !== undefined && (coolant < 40 || coolant > 105)) {
    return `${withUnit(COOLANT, coolant)} coolant`;
  }
  if (rpm !== undefined && throttle !== undefined && throttle >= 70) {
    return `${withUnit(THROTTLE, throttle)} · ${withUnit(RPM, rpm)}`;
  }
  if (rpm !== undefined && speed !== undefined && speed > 0) {
    return `${withUnit(SPEED, speed)} · ${withUnit(RPM, rpm)}`;
  }
  if (rpm !== undefined) return withUnit(RPM, rpm);
  const [first] = Object.entries(pids);
  if (first === undefined) return "No values";
  const [pid, value] = first as [PidId, number];
  return `${pidLabel(pid, "short")} ${withUnit(pid, value)}`;
};

export const changeCount = (count: number) => (count === 1 ? "1 change" : `${count} changes`);

export const describeChange = (change: PresetChange) =>
  `${pidLabel(change.pid, "full")} ${formatValue(change.pid, change.presetValue)} → ${withUnit(change.pid, change.currentValue)}`;
