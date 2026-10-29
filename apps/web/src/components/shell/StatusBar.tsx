import type * as React from "react";
import { cn } from "~/lib/utils";

/** The window's bottom strip of read-only facts. Items after the first get a separator. */
export function StatusBar({ className, ...props }: React.ComponentProps<"footer">) {
  return (
    <footer
      className={cn(
        "flex h-6 shrink-0 select-none items-center overflow-hidden whitespace-nowrap border-separator border-t bg-toolbar px-1.5 text-2xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function StatusBarItem({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="status-item"
      className={cn(
        "flex min-w-0 items-center gap-1.5 px-2.5 leading-3 not-first:border-border not-first:border-s [&_code]:font-mono [&_code]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function StatusBarSpacer() {
  return <span aria-hidden className="flex-1" />;
}
