import { Menu } from "@base-ui/react/menu";
import type * as React from "react";
import { cn } from "~/lib/utils";

/** A native-density menu: 13px rows 24px high, a leading mark column and trailing shortcuts. */
export function MenuPopup({
  className,
  align = "start",
  side = "top",
  ...props
}: Menu.Popup.Props & Pick<Menu.Positioner.Props, "align" | "side">) {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={4} className="z-[130] outline-none">
        <Menu.Popup
          className={cn(
            "dropdown-glass max-h-(--available-height) min-w-60 origin-(--transform-origin) select-none overflow-y-auto rounded-[9px] p-1.25 text-[13px] text-popover-foreground shadow-[0_12px_28px_-8px_rgb(0_0_0/35%)] outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:shadow-[0_12px_28px_-6px_rgb(0_0_0/65%)]",
            className,
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function MenuItem({
  mark,
  shortcut,
  className,
  children,
  ...props
}: Menu.Item.Props & {
  /** Drawn in the leading column, e.g. the mixed-state dash. */
  mark?: React.ReactNode;
  shortcut?: string | undefined;
}) {
  return (
    <Menu.Item
      className={cn(
        "flex h-6 cursor-default items-center gap-1.5 whitespace-nowrap rounded-[5px] ps-1.5 pe-2 outline-none data-disabled:text-disabled-foreground data-highlighted:bg-accent",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="w-3 shrink-0 text-center text-muted-foreground text-xs">
        {mark}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut !== undefined ? (
        <kbd className="ms-4 font-sans text-muted-foreground text-xs">{shortcut}</kbd>
      ) : null}
    </Menu.Item>
  );
}

export function MenuGroupLabel({ className, ...props }: Menu.GroupLabel.Props) {
  return (
    <Menu.GroupLabel
      className={cn(
        "px-2 ps-6.5 pt-1.5 pb-0.75 font-semibold text-2xs text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("mx-2 my-1.25 h-px bg-border", className)} {...props} />;
}
