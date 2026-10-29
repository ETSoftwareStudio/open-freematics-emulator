import { MAX_PRESET_NAME_LENGTH, type Preset } from "@fme/contracts";
import { LockIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type * as React from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { PresetDialog, PresetDialogFooter } from "./dialog";
import { presetSummary } from "./presetText";
import type { Presets } from "./usePresets";

type RowMode = { readonly _tag: "rename" } | { readonly _tag: "confirm-delete" };

function RenameField({
  preset,
  onSubmit,
  onCancel,
}: {
  preset: Preset;
  onSubmit: (name: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(preset.name);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_PRESET_NAME_LENGTH;
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        if (trimmed === preset.name) onCancel();
        else void onSubmit(trimmed);
      }}
    >
      <Input
        size="sm"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_PRESET_NAME_LENGTH}
        aria-label={`New name for ${preset.name}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          // Escape cancels the rename instead of closing the dialog.
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      />
      <Button type="submit" size="xs" disabled={!valid}>
        Rename
      </Button>
    </form>
  );
}

function UserPresetRow({ preset, presets }: { preset: Preset; presets: Presets }) {
  const [mode, setMode] = useState<RowMode | null>(null);
  if (mode?._tag === "rename") {
    return (
      <li className="flex h-9 items-center px-2">
        <RenameField
          preset={preset}
          onCancel={() => setMode(null)}
          onSubmit={async (name) => {
            if (await presets.rename(preset, name)) setMode(null);
          }}
        />
      </li>
    );
  }
  if (mode?._tag === "confirm-delete") {
    return (
      <li className="flex h-9 items-center gap-1.5 bg-error-surface px-2">
        <span className="min-w-0 flex-1 truncate text-foreground">Delete “{preset.name}”?</span>
        <Button variant="outline" size="xs" autoFocus onClick={() => setMode(null)}>
          Cancel
        </Button>
        <Button variant="destructive" size="xs" onClick={() => void presets.remove(preset)}>
          Delete
        </Button>
      </li>
    );
  }
  return (
    <li className="group flex h-9 items-center gap-1 px-2 hover:bg-accent/60">
      <PresetLabel preset={preset} />
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Rename ${preset.name}`}
        title="Rename"
        onClick={() => setMode({ _tag: "rename" })}
      >
        <PencilIcon />
      </Button>
      <Button
        variant="ghost-destructive"
        size="icon-xs"
        aria-label={`Delete ${preset.name}`}
        title="Delete"
        onClick={() => setMode({ _tag: "confirm-delete" })}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

function PresetLabel({ preset }: { preset: Preset }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-foreground">{preset.name}</span>
      <span className="truncate text-2xs text-muted-foreground tabular-nums">
        {presetSummary(preset.pids)}
      </span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-3">
      <h3 className="mb-1 font-semibold text-2xs text-subtle-foreground">{title}</h3>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-pane">
        {children}
      </ul>
    </section>
  );
}

/** Renames and deletes user presets; the built-ins are listed read-only. */
export function ManagePresetsDialog({
  presets,
  open,
  onOpenChange,
}: {
  presets: Presets;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <PresetDialog open={open} onOpenChange={onOpenChange} title="Manage Presets" className="w-96">
      <div className="-mx-1 min-h-0 overflow-y-auto px-1">
        <Section title="My presets">
          {presets.userPresets.length === 0 ? (
            <li className="px-2 py-2.5 text-muted-foreground">
              No presets yet. Use Save as New Preset to keep the current values.
            </li>
          ) : (
            presets.userPresets.map((preset) => (
              <UserPresetRow key={preset.id} preset={preset} presets={presets} />
            ))
          )}
        </Section>
        <Section title="Built-in">
          {presets.builtIns.map((preset) => (
            <li key={preset.id} className="flex h-9 items-center gap-1 px-2">
              <PresetLabel preset={preset} />
              <LockIcon aria-label="Read-only" className="me-1.5 size-3 text-muted-foreground" />
            </li>
          ))}
        </Section>
      </div>
      <PresetDialogFooter>
        <Button variant="outline" size="xs" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </PresetDialogFooter>
    </PresetDialog>
  );
}
