import { type PidDefinition, clampPidValue } from "@fme/shared/pids";
import { useState } from "react";
import { cn } from "~/lib/utils";

/** Parses a typed value, tolerating digit grouping ("1,000") and stray spaces. */
const parseTyped = (text: string) => {
  const cleaned = text.replace(/[\s,]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
};

// Stable, so React calls it once on mount rather than re-selecting on every keystroke.
const selectOnMount = (input: HTMLInputElement | null) => input?.select();

/** Types a gauge's value: Enter commits, Escape cancels, Up and Down step (Shift steps ten). */
export function ValueEditor({
  definition,
  value,
  step,
  onSubmit,
  onDone,
  className,
}: {
  definition: PidDefinition;
  value: number;
  step: number;
  onSubmit: (value: number) => void;
  onDone: (refocus: boolean) => void;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const invalid = parseTyped(text) === null;
  return (
    <input
      ref={selectOnMount}
      inputMode="decimal"
      aria-label={`${definition.name} (${definition.unit})`}
      aria-invalid={invalid}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const delta = (event.key === "ArrowUp" ? step : -step) * (event.shiftKey ? 10 : 1);
          setText(String(clampPidValue(definition, (parseTyped(text) ?? value) + delta)));
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDone(true);
        } else if (event.key === "Enter") {
          event.preventDefault();
          const typed = parseTyped(text);
          if (typed === null) return;
          onSubmit(typed);
          onDone(true);
        }
      }}
      onBlur={() => onDone(false)}
      style={{ width: `${Math.max(text.length, 3) + 1}ch` }}
      className={cn(
        "rounded-sm bg-gauge-bezel text-center font-instrument text-gauge-ink-focus tabular-nums leading-none outline-none ring-1 ring-focus-ring aria-invalid:ring-gauge-critical",
        className,
      )}
    />
  );
}

/** The keys a focused gauge answers to, shown under it. */
export function GaugeHint({
  definition,
  step,
  target,
  className,
}: {
  definition: PidDefinition;
  step: number;
  /** What to click to type, e.g. "number". */
  target: string;
  className?: string;
}) {
  const format = (n: number) =>
    Number(n.toFixed(6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <p
      aria-hidden
      className={cn(
        "pointer-events-none flex items-center justify-center gap-3 whitespace-nowrap text-2xs text-gauge-ink-muted opacity-0 transition-opacity duration-150",
        className,
      )}
    >
      <span>
        <kbd className="font-sans text-gauge-ink">↑ ↓</kbd> {format(step)} {definition.unit}
      </span>
      <span>
        <kbd className="font-sans text-gauge-ink">⇧</kbd> {format(step * 10)}
      </span>
      <span className="@max-[17rem]:hidden">Click the {target} to type</span>
    </p>
  );
}
