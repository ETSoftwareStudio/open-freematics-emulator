import { cn } from "~/lib/utils";

const TONES = {
  ok: "bg-success",
  busy: "bg-warning",
  error: "bg-error",
  off: "bg-muted-foreground/50",
} as const;

export type StatusTone = keyof typeof TONES;

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.75 shrink-0 rounded-full", TONES[tone], className)}
    />
  );
}
