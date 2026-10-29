import { type GaugeRange, snapToStep } from "./gaugeGeometry";

const parts = new Intl.NumberFormat().formatToParts(1000.5);
const GROUP = parts.find((part) => part.type === "group")?.value ?? ",";
const DECIMAL = parts.find((part) => part.type === "decimal")?.value ?? ".";

/** Parses a typed value as `formatPidValue` writes it, tolerating digit grouping and stray spaces. */
export const parseTyped = (text: string) => {
  const cleaned = text.replaceAll(GROUP, "").replace(/\s/g, "").replace(DECIMAL, ".");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
};

/** Moves a value by `steps` of `step`, snapped to the step and kept in the gauge's range. */
export const stepValue = (value: number, steps: number, range: GaugeRange, step: number) =>
  snapToStep(value + steps * step, range, step);

/** Where the ghost needle points: the typed value, pegged to the range, unless it is the shown one. */
export const ghostValue = (typed: number | null, shown: number, { min, max }: GaugeRange) =>
  typed === null || typed === shown ? null : Math.min(max, Math.max(min, typed));

export type EditorExit = "enter" | "escape" | "blur";

/**
 * What leaving the editor sends, or null to send nothing. Enter keeps the typed value; Escape
 * restores the value from before editing; blur keeps a valid changed value and otherwise restores.
 * `live` says the arrows or steppers already sent something, so a restore has to be sent too.
 */
export const exitTarget = (
  exit: EditorExit,
  {
    typed,
    original,
    shown,
    live,
  }: { typed: number | null; original: number; shown: number; live: boolean },
) => {
  const keep = exit === "enter" || (exit === "blur" && typed !== null && typed !== original);
  const target = keep ? typed : live ? original : null;
  return target === null || target === shown ? null : target;
};
