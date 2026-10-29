import { useAtomValue } from "@effect/atom-react";
import type { EmulatorState, PidId, Preset, PresetId, PresetPids } from "@fme/contracts";
import { presetProvenance } from "@fme/shared/presets";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useState } from "react";
import { applyPresetAtom, deletePresetAtom, presetsAtom, savePresetAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";

const NO_PRESETS: ReadonlyArray<Preset> = [];
const NO_PIDS: EmulatorState["pids"] = {};
// Long enough to read as a press when a shortcut applies a preset the simulator sets at once.
const MIN_PRESS_MS = 140;

/** The current values for `pids`' keys, so a saved preset keeps the same PID set. */
const currentValues = (current: EmulatorState["pids"], pids: PresetPids): PresetPids =>
  Object.fromEntries(
    Object.entries(pids).map(([pid, value]) => [pid, current[pid as PidId] ?? value]),
  );

/** Everything the strip, its menu and dialogs need: the list, where the values came from, actions. */
export function usePresets() {
  const result = useAtomValue(presetsAtom);
  const presets = AsyncResult.isSuccess(result) ? result.value : NO_PRESETS;
  const { state } = useEmulatorState();
  const current = state?.pids ?? NO_PIDS;
  const provenance = presetProvenance(current, presets, state?.lastPreset?.id ?? null);
  const source = provenance._tag === "custom" ? null : provenance.preset;
  const builtIns = presets.filter((preset) => preset.builtIn);
  const userPresets = presets.filter((preset) => !preset.builtIn);
  // Custom values save the built-ins' PID set: every state PID would add distance and time counters.
  const savePids = source?.pids ?? builtIns[0]?.pids ?? {};

  const applyCommand = useCommand(applyPresetAtom);
  const saveCommand = useCommand(savePresetAtom);
  const deleteCommand = useCommand(deletePresetAtom);
  const [applying, setApplying] = useState<PresetId | null>(null);

  const apply = async (id: PresetId) => {
    // A second apply would interrupt the first halfway through its PIDs.
    if (applying !== null) return;
    setApplying(id);
    await Promise.all([
      applyCommand({ id }),
      new Promise((resolve) => setTimeout(resolve, MIN_PRESS_MS)),
    ]);
    setApplying(null);
  };

  return {
    presets,
    builtIns,
    userPresets,
    provenance,
    source,
    savePids,
    applying,
    apply,
    /** Overwrites a user preset with the current values of its own PIDs. */
    update: (preset: Preset) =>
      saveCommand({ id: preset.id, name: preset.name, pids: currentValues(current, preset.pids) }),
    saveNew: (name: string) => saveCommand({ name, pids: currentValues(current, savePids) }),
    rename: (preset: Preset, name: string) =>
      saveCommand({ id: preset.id, name, pids: preset.pids }),
    remove: (preset: Preset) => deleteCommand({ id: preset.id }),
  };
}

export type Presets = ReturnType<typeof usePresets>;
