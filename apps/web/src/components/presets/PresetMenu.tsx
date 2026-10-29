import { Menu } from "@base-ui/react/menu";
import type { Preset } from "@fme/contracts";
import { MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator } from "./menu";
import { changeCount, describeChange } from "./presetText";
import { useShortcutLabels } from "./usePresetShortcuts";
import type { Presets } from "./usePresets";

function PresetHeader({ presets }: { presets: Presets }) {
  const { provenance } = presets;
  return (
    <div className="px-2 ps-6.5 pt-1 pb-1.5 text-xs">
      {provenance._tag === "edited" ? (
        <>
          <p className="text-muted-foreground">
            {provenance.preset.name}, edited
            <span className="text-subtle-foreground">
              {" "}
              · {changeCount(provenance.changes.length)}
            </span>
          </p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {provenance.changes.map((change) => (
              <li key={change.pid} className="truncate tabular-nums">
                {describeChange(change)}
              </li>
            ))}
          </ul>
        </>
      ) : provenance._tag === "preset" ? (
        <p className="text-muted-foreground">Values match {provenance.preset.name}</p>
      ) : (
        <p className="text-muted-foreground">Custom values, not from a preset</p>
      )}
    </div>
  );
}

function PresetItems({
  label,
  items,
  offset,
  presets,
}: {
  label: string;
  items: ReadonlyArray<Preset>;
  /** The shortcut index of the first item. */
  offset: number;
  presets: Presets;
}) {
  const shortcuts = useShortcutLabels();
  return (
    <Menu.Group>
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {items.map((preset, index) => (
        <MenuItem
          key={preset.id}
          // macOS's mixed-state mark: the values came from here, but a preset is never "on".
          mark={preset.id === presets.source?.id ? "–" : undefined}
          shortcut={offset + index < 9 ? shortcuts.apply(offset + index) : undefined}
          onClick={() => void presets.apply(preset.id)}
        >
          {preset.name}
          {preset.id === presets.source?.id ? (
            <span className="sr-only"> (current values)</span>
          ) : null}
        </MenuItem>
      ))}
    </Menu.Group>
  );
}

/** The preset field's menu: what changed, revert/update/save, every preset, and Manage. */
export function PresetMenuPopup({
  presets,
  onSaveNew,
  onManage,
}: {
  presets: Presets;
  onSaveNew: () => void;
  onManage: () => void;
}) {
  const { provenance, builtIns, userPresets } = presets;
  const shortcuts = useShortcutLabels();
  const edited = provenance._tag === "edited" ? provenance.preset : null;
  return (
    <MenuPopup aria-label="Presets" className="w-66">
      <PresetHeader presets={presets} />
      {edited !== null ? (
        <MenuItem onClick={() => void presets.apply(edited.id)}>Revert to {edited.name}</MenuItem>
      ) : null}
      {edited !== null && !edited.builtIn ? (
        <MenuItem onClick={() => void presets.update(edited)}>Update {edited.name}</MenuItem>
      ) : null}
      <MenuItem shortcut={shortcuts.saveNew} onClick={onSaveNew}>
        Save as New Preset…
      </MenuItem>
      <MenuSeparator />
      <PresetItems label="Built-in" items={builtIns} offset={0} presets={presets} />
      {userPresets.length > 0 ? (
        <>
          <MenuSeparator />
          <PresetItems
            label="My presets"
            items={userPresets}
            offset={builtIns.length}
            presets={presets}
          />
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem onClick={onManage}>Manage Presets…</MenuItem>
    </MenuPopup>
  );
}
