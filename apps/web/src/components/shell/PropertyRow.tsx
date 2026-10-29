import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * One setting at inspector density: the label on the left (with an optional PID code or sub-label
 * under it) and its control on the right.
 */
export function PropertyRow({
  label,
  code,
  detail,
  htmlFor,
  className,
  children,
}: {
  label: React.ReactNode;
  /** A PID or command, set in mono under the label, e.g. `010C`. */
  code?: string;
  /** A plain sub-label under the label. */
  detail?: React.ReactNode;
  /** The control's id, so clicking the label focuses it. */
  htmlFor?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const Label = htmlFor !== undefined ? "label" : "span";
  return (
    <div
      className={cn(
        "grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs",
        (code !== undefined || detail !== undefined) && "min-h-8.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col">
        <Label htmlFor={htmlFor} className="truncate text-muted-foreground">
          {label}
        </Label>
        {code !== undefined ? (
          <code className="font-mono text-2xs text-muted-foreground/75 leading-tight">{code}</code>
        ) : null}
        {detail !== undefined ? (
          <span className="truncate text-2xs text-muted-foreground/75 leading-tight">{detail}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1.5 text-foreground">
        {children}
      </div>
    </div>
  );
}
