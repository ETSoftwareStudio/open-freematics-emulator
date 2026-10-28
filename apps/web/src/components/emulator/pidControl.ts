import type { PidReading } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import { type PidDefinition, clampPidValue } from "@fme/shared/pids";
import { useRef, useState } from "react";
import { setPidAtom } from "~/rpc/atoms";
import { useCommand } from "~/rpc/hooks";

export const formatPidValue = (definition: PidDefinition, value: number) =>
  value.toLocaleString(undefined, {
    maximumFractionDigits: Number.isInteger(definition.step) ? 1 : 2,
  });

/** The bytes decide: a match means the vehicle side reports exactly what was configured. */
export const readingMatches = (definition: PidDefinition, value: number, reading: PidReading) =>
  formatHexBytes(reading.raw) === formatHexBytes(definition.encode(value));

/**
 * Drives one PID from a control that streams changes while dragging and commits on release.
 * The draft holds the control's position so server echoes don't fight the pointer.
 */
export function usePidControl(definition: PidDefinition, value: number) {
  const setPid = useCommand(setPidAtom(definition.id));
  const [draft, setDraft] = useState<number | null>(null);
  // Controls fire change and commit with the same value; send it once.
  const lastSent = useRef<number | null>(null);
  const send = (next: number) => {
    lastSent.current = next;
    return setPid({ pid: definition.id, value: next });
  };

  return {
    shown: draft ?? value,
    dragging: draft !== null,
    change: (next: number) => {
      const clamped = clampPidValue(definition, next);
      if (clamped === lastSent.current) return;
      setDraft(clamped);
      void send(clamped);
    },
    commit: async (next: number) => {
      const clamped = clampPidValue(definition, next);
      if (clamped !== lastSent.current) await send(clamped);
      lastSent.current = null;
      setDraft(null);
    },
  };
}
