import type { PidId, Preset, PresetId } from "@fme/contracts";
import { findPid } from "./pids.ts";

type PidValues = Readonly<Record<PidId, number>>;

export interface PresetChange {
  readonly pid: PidId;
  readonly presetValue: number;
  readonly currentValue: number;
}

export type PresetProvenance<P extends Preset = Preset> =
  | { readonly _tag: "preset"; readonly preset: P }
  | { readonly _tag: "edited"; readonly preset: P; readonly changes: ReadonlyArray<PresetChange> }
  | { readonly _tag: "custom" };

// Within half a step both values snap to the same setting, so the device reports the same thing.
const sameSetting = (pid: PidId, a: number, b: number) =>
  Math.abs(a - b) < (findPid(pid)?.step ?? 1) / 2;

/** The preset's PIDs whose current value differs from it, in the preset's order. */
export const presetChanges = (
  current: PidValues,
  preset: Pick<Preset, "pids">,
): ReadonlyArray<PresetChange> =>
  Object.entries(preset.pids).flatMap(([key, presetValue]) => {
    const pid = key as PidId;
    const currentValue = current[pid];
    return currentValue === undefined || sameSetting(pid, presetValue, currentValue)
      ? []
      : [{ pid, presetValue, currentValue }];
  });

/** The first preset every one of whose PIDs matches the current values. */
export const findMatchingPreset = <P extends Pick<Preset, "pids">>(
  current: PidValues,
  presets: ReadonlyArray<P>,
): P | undefined =>
  presets.find(
    (preset) => Object.keys(preset.pids).length > 0 && presetChanges(current, preset).length === 0,
  );

/**
 * What the PIDs show: the last applied preset, another preset the edits landed on, the last
 * preset with edits, or custom values once that preset is gone.
 */
export const presetProvenance = <P extends Preset>(
  current: PidValues,
  presets: ReadonlyArray<P>,
  lastPresetId: PresetId | null,
): PresetProvenance<P> => {
  const last = presets.find((preset) => preset.id === lastPresetId);
  const changes = last === undefined ? [] : presetChanges(current, last);
  if (last !== undefined && changes.length === 0) return { _tag: "preset", preset: last };
  const match = findMatchingPreset(current, presets);
  if (match !== undefined) return { _tag: "preset", preset: match };
  if (last !== undefined) return { _tag: "edited", preset: last, changes };
  return { _tag: "custom" };
};
