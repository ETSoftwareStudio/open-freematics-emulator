import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type * as React from "react";
import { cn } from "~/lib/utils";

export interface SegmentedItem<V extends string> {
  readonly value: V;
  readonly label: React.ReactNode;
  readonly icon?: React.ReactNode;
  /** Shown after the label, e.g. `⌘1`. */
  readonly shortcut?: string;
  readonly title?: string;
  readonly disabled?: boolean;
}

const SIZES = {
  default: { root: "h-6 rounded-md", item: "px-2.5 text-xs" },
  toolbar: { root: "h-7.5 rounded-[7px]", item: "px-3.5 text-[13px]" },
} as const;

/** One choice out of a few, shown side by side. Selecting the current item keeps it selected. */
export function SegmentedControl<V extends string>({
  items,
  value,
  onValueChange,
  size = "default",
  fill = false,
  className,
  "aria-label": ariaLabel,
}: {
  items: ReadonlyArray<SegmentedItem<V>>;
  value: V;
  onValueChange: (value: V) => void;
  size?: keyof typeof SIZES;
  /** Stretch to the parent's width with equal segments. */
  fill?: boolean;
  className?: string;
  "aria-label": string;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        const picked = items.find((item) => item.value === next[0]);
        if (picked !== undefined) onValueChange(picked.value);
      }}
      aria-label={ariaLabel}
      className={cn(
        "gap-0.5 bg-pane-sunken p-0.75 shadow-[inset_0_0_0_1px_var(--color-border)]",
        fill ? "flex" : "inline-flex",
        SIZES[size].root,
        className,
      )}
    >
      {items.map((item) => (
        <Toggle
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          title={item.title}
          className={cn(
            "inline-flex cursor-default select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-popover data-pressed:text-foreground data-pressed:shadow-[0_0_0_0.5px_rgb(0_0_0/0.18),0_1px_1px_rgb(0_0_0/0.12)] dark:data-pressed:bg-white/12 [&_svg]:size-3 [&_svg]:shrink-0",
            fill && "flex-1",
            SIZES[size].item,
          )}
        >
          {item.icon}
          {item.label}
          {item.shortcut !== undefined ? (
            <kbd className="font-sans text-2xs text-muted-foreground tracking-wide">
              {item.shortcut}
            </kbd>
          ) : null}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
