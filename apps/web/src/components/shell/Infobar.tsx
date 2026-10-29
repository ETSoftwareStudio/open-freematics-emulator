import { XIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const TONES = {
  neutral: { bar: "bg-toolbar", icon: "text-muted-foreground" },
  warning: {
    bar: "bg-[color-mix(in_oklab,var(--warning)_8%,var(--toolbar))]",
    icon: "text-warning",
  },
  error: {
    bar: "bg-[color-mix(in_oklab,var(--error)_12%,var(--toolbar))]",
    icon: "text-error",
  },
} as const;

/**
 * A thin bar under the toolbar for a window-wide condition: one line of text, its actions, and
 * an optional dismiss button. Bold parts of `children` read as the headline.
 */
export function Infobar({
  tone = "neutral",
  icon: Icon,
  actions,
  onDismiss,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: keyof typeof TONES;
  icon?: React.ComponentType<{ className?: string }>;
  actions?: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-7.5 shrink-0 select-none items-center gap-2.5 border-separator border-b py-0.75 ps-3.5 pe-2 text-muted-foreground text-xs",
        TONES[tone].bar,
        className,
      )}
      {...props}
    >
      {Icon !== undefined ? <Icon className={cn("size-3.5 shrink-0", TONES[tone].icon)} /> : null}
      <p className="min-w-0 flex-1 truncate [&_b]:font-semibold [&_b]:text-foreground">
        {children}
      </p>
      {actions !== undefined ? (
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      ) : null}
      {onDismiss !== undefined ? (
        <Button variant="ghost-muted" size="icon-micro" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
