import type * as React from "react";
import { cn } from "~/lib/utils";

/** A region of the window: an optional header and a body that scrolls on its own. */
export function Pane({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("flex min-h-0 min-w-0 flex-col bg-pane text-xs", className)}
      {...props}
    />
  );
}

/** The 32px bar at the top of a pane: a title, then meta text and actions, or just controls. */
export function PaneHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "flex h-8 shrink-0 select-none items-center gap-2 border-separator border-b bg-pane ps-3 pe-2",
        className,
      )}
      {...props}
    />
  );
}

export { PaneHeader as PaneToolbar };

export function PaneTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("whitespace-nowrap font-semibold text-foreground text-xs", className)}
      {...props}
    />
  );
}

export function PaneMeta({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p className={cn("min-w-0 truncate text-2xs text-muted-foreground", className)} {...props} />
  );
}

export function PaneActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("ms-auto flex shrink-0 items-center gap-1", className)} {...props} />;
}

export function PaneBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-auto", className)} {...props} />;
}
