import { clampPidValue, findPid } from "@fme/shared/pids";
import { describe, expect, it } from "@effect/vitest";
import { BUILT_IN_PRESETS } from "./builtInPresets.ts";

describe("built-in presets", () => {
  it("sets only catalog PIDs, each to a value its range and step allow", () => {
    for (const preset of BUILT_IN_PRESETS) {
      for (const [pid, value] of Object.entries(preset.pids)) {
        const definition = findPid(pid);
        expect(definition, `${preset.name} ${pid}`).toBeDefined();
        if (definition !== undefined) {
          expect(clampPidValue(definition, value), `${preset.name} ${pid}`).toBe(value);
        }
      }
    }
  });

  it("all set the same PIDs, so switching between them leaves nothing behind", () => {
    const [first, ...rest] = BUILT_IN_PRESETS.map((preset) => Object.keys(preset.pids));
    for (const pids of rest) expect(pids).toEqual(first);
  });

  it("are read-only and uniquely identified", () => {
    expect(BUILT_IN_PRESETS.map((preset) => preset.name)).toEqual([
      "Idle",
      "Cruise",
      "Cold start",
      "Wide-open throttle",
      "Overheat",
    ]);
    expect(new Set(BUILT_IN_PRESETS.map((preset) => preset.id)).size).toBe(BUILT_IN_PRESETS.length);
    expect(BUILT_IN_PRESETS.every((preset) => preset.builtIn)).toBe(true);
  });
});
