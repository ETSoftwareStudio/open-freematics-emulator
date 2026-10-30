import { MAX_PRESET_NAME_LENGTH } from "@fme/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Dialog, DialogFooter } from "~/components/ui/dialog";
import type { Presets } from "./usePresets";

function SaveForm({ presets, onDone }: { presets: Presets; onDone: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_PRESET_NAME_LENGTH;

  return (
    <form
      className="mt-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || saving) return;
        setSaving(true);
        const saved = await presets.saveNew(trimmed);
        setSaving(false);
        if (saved) onDone();
      }}
    >
      <label htmlFor="preset-name" className="mb-1 block text-muted-foreground">
        Name
      </label>
      <Input
        id="preset-name"
        size="sm"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_PRESET_NAME_LENGTH}
        placeholder="e.g. Highway 120"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <DialogFooter>
        <Button variant="outline" size="xs" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!valid || saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Saves the current values as a user preset, with the PID set of the preset they came from. */
export function SavePresetDialog({
  presets,
  open,
  onOpenChange,
}: {
  presets: Presets;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const count = Object.keys(presets.savePids).length;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save as New Preset"
      description={
        presets.source !== null
          ? `Saves the current values of the ${count} PIDs ${presets.source.name} sets.`
          : `Saves the current values of the ${count} PIDs the built-in presets set.`
      }
    >
      <SaveForm presets={presets} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}
