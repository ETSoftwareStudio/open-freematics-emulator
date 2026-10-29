import type { PidId, Preset, PresetId } from "@fme/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeDefaultState } from "./defaultState.ts";
import { findMatchingPreset, presetChanges, presetProvenance } from "./presets.ts";

const preset = (id: string, name: string, pids: Record<string, number>): Preset => ({
  id: id as PresetId,
  name,
  builtIn: id.startsWith("builtin:"),
  pids: pids as Record<PidId, number>,
});

const cruise = preset("builtin:cruise", "Cruise", { "010C": 2350, "010D": 72, "0110": 14.5 });
const idle = preset("builtin:idle", "Idle", { "010C": 750, "010D": 0 });
const presets = [idle, cruise];

const withPids = (values: Record<string, number>) => ({
  ...makeDefaultState().pids,
  ...(values as Record<PidId, number>),
});

describe("presetChanges", () => {
  it("lists differing PIDs in the preset's order, ignoring differences under half a step", () => {
    const current = withPids({ "010C": 3100, "010D": 72.4, "0110": 14.504 });
    expect(presetChanges(current, cruise)).toEqual([
      { pid: "010C", presetValue: 2350, currentValue: 3100 },
    ]);
    expect(presetChanges(withPids({ "010C": 2350, "010D": 72, "0110": 14.52 }), cruise)).toEqual([
      { pid: "0110", presetValue: 14.5, currentValue: 14.52 },
    ]);
  });
});

describe("findMatchingPreset", () => {
  it("finds the preset whose PIDs all match, ignoring PIDs it doesn't set", () => {
    expect(findMatchingPreset(withPids({ "010C": 750, "010D": 0, "0105": 20 }), presets)).toBe(
      idle,
    );
    expect(findMatchingPreset(withPids({ "010C": 760, "010D": 0 }), presets)).toBeUndefined();
    expect(findMatchingPreset(withPids({}), [preset("user:empty", "Empty", {})])).toBeUndefined();
  });
});

describe("presetProvenance", () => {
  it("names the last preset, its edits, a preset the edits land on, or custom values", () => {
    const applied = withPids({ "010C": 2350, "010D": 72, "0110": 14.5 });
    expect(presetProvenance(applied, presets, cruise.id)).toEqual({
      _tag: "preset",
      preset: cruise,
    });
    expect(presetProvenance({ ...applied, ["010C" as PidId]: 3100 }, presets, cruise.id)).toEqual({
      _tag: "edited",
      preset: cruise,
      changes: [{ pid: "010C", presetValue: 2350, currentValue: 3100 }],
    });
    expect(presetProvenance(withPids({ "010C": 750, "010D": 0 }), presets, cruise.id)).toEqual({
      _tag: "preset",
      preset: idle,
    });
    expect(presetProvenance(applied, [idle], cruise.id)).toEqual({ _tag: "custom" });
    expect(presetProvenance(withPids({ "010C": 3100 }), presets, null)).toEqual({
      _tag: "custom",
    });
  });
});
