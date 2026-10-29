import { Menu } from "@base-ui/react/menu";
import type { Preset } from "@fme/contracts";
import { ChevronsRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { MenuItem, MenuPopup } from "./menu";
import { presetSummary } from "./presetText";
import { useShortcutLabels } from "./usePresetShortcuts";
import type { Presets } from "./usePresets";

// Widths the overflow sums up; the cells themselves share whatever room is left.
const MIN_BUTTON = 108;
const PLUS = 40;
const OVERFLOW = 32;
const DIVIDER = 4;

const cell =
  "flex shrink-0 cursor-default items-center justify-center text-muted-foreground outline-none hover:bg-hover/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-hover data-popup-open:bg-hover";

/** How many presets fit before the rest move to the overflow menu. Never wraps. */
const fitCount = (width: number, total: number, divider: boolean) => {
  const room = width - PLUS - (divider ? DIVIDER : 0);
  if (total * MIN_BUTTON <= room) return total;
  return Math.max(0, Math.floor((room - OVERFLOW) / MIN_BUTTON));
};

function PresetButton({
  preset,
  index,
  presets,
}: {
  preset: Preset;
  index: number;
  presets: Presets;
}) {
  const shortcuts = useShortcutLabels();
  const pending = presets.applying === preset.id;
  const shortcut = index < 9 ? shortcuts.apply(index) : null;
  return (
    <button
      type="button"
      title={shortcut === null ? `Apply ${preset.name}` : `Apply ${preset.name} (${shortcut})`}
      aria-keyshortcuts={shortcut === null ? undefined : shortcuts.applyAria(index)}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      onClick={() => void presets.apply(preset.id)}
      className="flex min-w-0 flex-[1_1_auto] cursor-default select-none flex-col justify-center gap-0.5 border-border border-e px-2.5 text-start outline-none transition-colors duration-75 hover:bg-hover/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-hover data-pending:bg-hover"
    >
      <span className="truncate font-medium text-foreground text-xs">{preset.name}</span>
      <span className="truncate text-2xs text-subtle-foreground tabular-nums">
        {pending ? "Applying…" : presetSummary(preset.pids)}
      </span>
    </button>
  );
}

/** Momentary buttons: built-ins, a divider, user presets, then "+" for Save as New. */
export function PresetButtons({ presets, onSaveNew }: { presets: Presets; onSaveNew: () => void }) {
  const shortcuts = useShortcutLabels();
  const [width, setWidth] = useState(0);
  const all = presets.presets;
  const builtInCount = presets.builtIns.length;
  const count = fitCount(width, all.length, presets.userPresets.length > 0);
  const shown = all.slice(0, count);
  const hidden = all.slice(count);

  const measure = (node: HTMLDivElement | null) => {
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  };

  return (
    <div ref={measure} className="flex min-w-0 flex-1">
      {shown.map((preset, index) => (
        <div key={preset.id} className="contents">
          {index === builtInCount && index > 0 ? (
            <span aria-hidden className="w-1 shrink-0 bg-separator" />
          ) : null}
          <PresetButton preset={preset} index={index} presets={presets} />
        </div>
      ))}
      {hidden.length > 0 ? (
        <Menu.Root>
          <Menu.Trigger
            aria-label={`${hidden.length} more presets`}
            title="More presets"
            className={cn(cell, "w-8 border-border border-e")}
          >
            <ChevronsRightIcon className="size-3.5" />
          </Menu.Trigger>
          <MenuPopup aria-label="More presets" align="end">
            {hidden.map((preset, index) => (
              <MenuItem
                key={preset.id}
                shortcut={count + index < 9 ? shortcuts.apply(count + index) : undefined}
                onClick={() => void presets.apply(preset.id)}
              >
                {preset.name}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu.Root>
      ) : null}
      <button
        type="button"
        aria-label="Save current values as a preset"
        aria-keyshortcuts={shortcuts.saveNewAria}
        title={`Save as New Preset (${shortcuts.saveNew})`}
        onClick={onSaveNew}
        className={cn(cell, "ms-auto w-10")}
      >
        <PlusIcon className="size-4" />
      </button>
    </div>
  );
}
