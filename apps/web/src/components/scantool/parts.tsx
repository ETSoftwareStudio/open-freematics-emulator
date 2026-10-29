import type { PidId, PidReading } from "@fme/contracts";
import {
  CheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  ClockIcon,
  type LucideIcon,
  MinusIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import type { ResultKind } from "./readback";

const RESULTS: Record<
  ResultKind,
  { label: string; icon: LucideIcon; tone: string; iconTone: string }
> = {
  match: {
    label: "Match",
    icon: CheckIcon,
    tone: "text-muted-foreground",
    iconTone: "text-success",
  },
  rounded: {
    label: "Match, rounded",
    icon: CheckIcon,
    tone: "text-muted-foreground",
    iconTone: "text-success",
  },
  mismatch: { label: "Mismatch", icon: CircleXIcon, tone: "text-error-foreground", iconTone: "" },
  waiting: {
    label: "Waiting for poll",
    icon: ClockIcon,
    tone: "text-warning-foreground",
    iconTone: "",
  },
  "no-answer": {
    label: "No answer",
    icon: CircleMinusIcon,
    tone: "text-muted-foreground",
    iconTone: "",
  },
  unchecked: {
    label: "Not compared",
    icon: MinusIcon,
    tone: "text-muted-foreground",
    iconTone: "",
  },
  offline: { label: "Not read", icon: MinusIcon, tone: "text-muted-foreground", iconTone: "" },
};

export function ResultLabel({ result }: { result: ResultKind }) {
  const { label, icon: Icon, tone, iconTone } = RESULTS[result];
  return (
    <span className={cn("inline-flex items-center gap-1.25", tone)}>
      <Icon className={cn("size-3 shrink-0", iconTone)} aria-hidden />
      {label}
    </span>
  );
}

/** A check when the readback agrees with the emulator, a cross when it doesn't. */
export function Verdict({ ok, children }: { ok: boolean; children?: React.ReactNode }) {
  const Icon = ok ? CheckIcon : CircleXIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        ok ? "text-muted-foreground" : "text-error-foreground",
      )}
    >
      <Icon
        className={cn("size-3 shrink-0", ok && "text-success")}
        aria-label={children === undefined ? (ok ? "Matches" : "Differs") : undefined}
      />
      {children}
    </span>
  );
}

/** Read-only facts in two columns: a muted label and its value. */
export function Facts({ className, ...props }: React.ComponentProps<"dl">) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[86px_minmax(0,1fr)] text-xs [&>dd]:flex [&>dd]:min-h-5.5 [&>dd]:min-w-0 [&>dd]:items-center [&>dd]:gap-1.5 [&>dd]:whitespace-nowrap [&>dt]:flex [&>dt]:min-h-5.5 [&>dt]:items-center [&>dt]:text-muted-foreground [&_code]:font-mono [&_code]:text-[11.5px]",
        className,
      )}
      {...props}
    />
  );
}

/** Buttons sharing a row's width under an inspector group. */
export function ButtonRow({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-2 flex gap-1.5 *:min-w-0 *:flex-1", className)} {...props} />;
}

export const formatClock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false });

/** The wall clock, re-read every `intervalMs`. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- ages in the table tick with the wall clock
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * For each PID, the time of the newest reading taken before the emulator last changed it. A
 * reading at or before that mark was polled before the change reached the vehicle side.
 */
export function useStaleMarks(
  values: Readonly<Record<string, number>> | undefined,
  readings: Readonly<Record<PidId, PidReading>> | undefined,
) {
  const [marks, setMarks] = useState<{
    values: typeof values;
    staleThrough: Readonly<Record<string, number>>;
  }>({ values, staleThrough: {} });
  if (marks.values !== values) {
    const staleThrough = { ...marks.staleThrough };
    for (const [pid, value] of Object.entries(values ?? {})) {
      if (marks.values !== undefined && marks.values[pid] !== value) {
        staleThrough[pid] = readings?.[pid as PidId]?.at ?? 0;
      }
    }
    setMarks({ values, staleThrough });
  }
  return marks.staleThrough;
}
