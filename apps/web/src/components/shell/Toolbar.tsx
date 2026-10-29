import type * as React from "react";
import { cn } from "~/lib/utils";
import { useWindowChrome } from "~/lib/windowChrome";

/**
 * The window's unified title bar. It drags the window in the desktop app and leaves room for the
 * platform's window buttons.
 */
export function Toolbar({ className, ...props }: React.ComponentProps<"header">) {
  const chrome = useWindowChrome();
  return (
    <header
      className={cn(
        "drag-region grid h-13 shrink-0 select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-separator border-b bg-toolbar text-xs",
        chrome.trafficLights ? "ps-[86px]" : "ps-3",
        chrome.windowControlsOverlay ? "pe-[146px]" : "pe-3",
        className,
      )}
      {...props}
    />
  );
}

const ALIGN = { start: "justify-start", center: "justify-center", end: "justify-end" } as const;

export function ToolbarSection({
  align,
  className,
  ...props
}: React.ComponentProps<"div"> & { align: keyof typeof ALIGN }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", ALIGN[align], className)} {...props} />
  );
}

export function ToolbarSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div aria-hidden className={cn("mx-1 h-4.5 w-px shrink-0 bg-border", className)} {...props} />
  );
}
