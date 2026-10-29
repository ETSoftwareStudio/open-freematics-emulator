import { Menu } from "@base-ui/react/menu";
import { ChevronsUpDownIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { PresetMenuPopup } from "./PresetMenu";
import { changeCount, formatValue, pidLabel, presetSummary } from "./presetText";
import type { Presets } from "./usePresets";

function Detail({ presets }: { presets: Presets }) {
  const { provenance } = presets;
  if (provenance._tag === "custom") return <span className="truncate">No preset matches</span>;
  if (provenance._tag === "preset") {
    return <span className="truncate">{presetSummary(provenance.preset.pids)}</span>;
  }
  const [first, ...rest] = provenance.changes;
  if (first === undefined) return null;
  return (
    <>
      <span className="truncate">
        {pidLabel(first.pid, "short")} {formatValue(first.pid, first.presetValue)} →{" "}
        <span className="text-foreground">{formatValue(first.pid, first.currentValue)}</span>
      </span>
      {rest.length > 0 ? <span className="shrink-0">+{rest.length} more</span> : null}
    </>
  );
}

/** The strip's leading cell: where the values came from, its menu, and Revert when edited. */
export function PresetField({
  presets,
  onSaveNew,
  onManage,
}: {
  presets: Presets;
  onSaveNew: () => void;
  onManage: () => void;
}) {
  const { provenance, applying } = presets;
  const name = provenance._tag === "custom" ? "Custom" : provenance.preset.name;
  const label =
    provenance._tag === "edited"
      ? `Preset: ${name}, edited, ${changeCount(provenance.changes.length)}`
      : `Preset: ${name}`;
  return (
    <div className="flex w-60 shrink-0 flex-col justify-center gap-1 border-border border-e ps-3 pe-2.5">
      <Menu.Root>
        <Menu.Trigger
          render={<Button variant="outline" size="xs" />}
          aria-label={label}
          className="w-full justify-start gap-1.5 ps-2 pe-1.5"
        >
          <span className="min-w-0 truncate font-semibold">{name}</span>
          {provenance._tag === "edited" ? (
            <span className="flex shrink-0 items-center gap-1.25 font-normal text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              edited
            </span>
          ) : null}
          <ChevronsUpDownIcon className="ms-auto size-3 text-muted-foreground" />
        </Menu.Trigger>
        <PresetMenuPopup presets={presets} onSaveNew={onSaveNew} onManage={onManage} />
      </Menu.Root>
      <div className="flex h-5 items-center gap-1.5 text-2xs text-subtle-foreground">
        <span className="flex min-w-0 flex-1 gap-1 whitespace-nowrap tabular-nums">
          <Detail presets={presets} />
        </span>
        {provenance._tag === "edited" ? (
          <Button
            variant="outline"
            size="micro"
            title={`Revert to ${name}`}
            disabled={applying !== null}
            onClick={() => void presets.apply(provenance.preset.id)}
          >
            Revert
          </Button>
        ) : null}
      </div>
    </div>
  );
}
