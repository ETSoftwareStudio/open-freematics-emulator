import { useState } from "react";
import { ManagePresetsDialog } from "~/components/presets/ManagePresetsDialog";
import { PresetButtons } from "~/components/presets/PresetButtons";
import { PresetField } from "~/components/presets/PresetField";
import { SavePresetDialog } from "~/components/presets/SavePresetDialog";
import { usePresetShortcuts } from "~/components/presets/usePresetShortcuts";
import { usePresets } from "~/components/presets/usePresets";

/** Scenario presets under the cluster: one-shot actions, never a mode that stays on. */
export function ScenarioStrip() {
  const presets = usePresets();
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  usePresetShortcuts({
    presets: presets.presets,
    onApply: (preset) => void presets.apply(preset.id),
    onSaveNew: () => setSaveOpen(true),
  });

  return (
    <div
      role="group"
      aria-label="Presets"
      data-slot="scenario-strip"
      className="flex h-14.5 shrink-0 items-stretch border-separator border-t bg-pane py-0.75 text-xs"
    >
      <PresetField
        presets={presets}
        onSaveNew={() => setSaveOpen(true)}
        onManage={() => setManageOpen(true)}
      />
      <PresetButtons presets={presets} onSaveNew={() => setSaveOpen(true)} />
      <SavePresetDialog presets={presets} open={saveOpen} onOpenChange={setSaveOpen} />
      <ManagePresetsDialog presets={presets} open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  );
}
