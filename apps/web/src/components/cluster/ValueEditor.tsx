import type { PidDefinition } from "@fme/shared/pids";
import { MinusIcon, PlusIcon } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";
import type { GaugeControl } from "./useGaugeControl";
import type { EditorExit } from "./valueEditing";

const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 60;
const STEPPER_SLOT = "absolute top-1/2 z-10 flex h-[55%] min-h-5 -translate-y-1/2";

const formatStep = (n: number) =>
  Number(n.toFixed(6)).toLocaleString(undefined, { maximumFractionDigits: 2 });

// Stable, so React calls it once on mount rather than re-selecting on every keystroke.
const selectOnMount = (input: HTMLInputElement | null) => input?.select();

/**
 * A gauge's number: a button that becomes a `ValueEditor` in the same box, with steppers either
 * side while editing, or both after it where the left edge has no room. `numberClassName` styles
 * both, so opening the editor moves nothing.
 */
export function GaugeNumber({
  control,
  numberClassName,
  buttonClassName,
  steppers = "flank",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  control: GaugeControl;
  numberClassName: string;
  buttonClassName?: string;
  steppers?: "flank" | "after";
}) {
  const { definition, formatted } = control;
  const number = cn(
    "flex items-center rounded-sm border font-instrument tabular-nums outline-none",
    numberClassName,
    // An input centres its text by the font's own metrics; line-height normal makes the button match.
    "leading-[normal]",
  );
  return (
    <div className={cn("relative flex items-baseline", className)} {...props}>
      {control.editing ? (
        <ValueEditor {...control.editor} className={number} />
      ) : (
        <button
          type="button"
          title="Type a value"
          aria-label={`${definition.name}: ${formatted} ${definition.unit}. Type a value`}
          onClick={control.startEditing}
          className={cn(
            number,
            "cursor-text border-transparent text-gauge-ink transition-colors hover:border-focus-ring focus-visible:border-focus-ring",
            buttonClassName,
          )}
        >
          {formatted}
        </button>
      )}
      {children}
      {!control.editing ? null : steppers === "flank" ? (
        <>
          <span className={cn(STEPPER_SLOT, "right-full me-1")}>
            <Stepper {...control.stepper} direction={-1} />
          </span>
          <span className={cn(STEPPER_SLOT, "left-full ms-1")}>
            <Stepper {...control.stepper} direction={1} />
          </span>
        </>
      ) : (
        <span className={cn(STEPPER_SLOT, "left-full ms-1.5 gap-1")}>
          <Stepper {...control.stepper} direction={-1} />
          <Stepper {...control.stepper} direction={1} />
        </span>
      )}
    </div>
  );
}

/** Types a gauge's value: Enter commits, Escape restores, Up and Down step live (Shift steps ten). */
function ValueEditor({
  definition,
  text,
  invalid,
  onTextChange,
  onStep,
  onExit,
  className,
}: {
  definition: PidDefinition;
  text: string;
  invalid: boolean;
  onTextChange: (text: string) => void;
  onStep: (steps: number) => void;
  onExit: (exit: EditorExit) => void;
  className: string;
}) {
  // Enter and Escape hand focus back to the gauge, and the blur that causes must not exit again.
  const exited = useRef(false);
  const exit = (how: EditorExit) => {
    exited.current = true;
    onExit(how);
  };
  return (
    <input
      ref={selectOnMount}
      inputMode="decimal"
      aria-label={`${definition.name} (${definition.unit})`}
      aria-invalid={invalid}
      value={text}
      onChange={(event) => onTextChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          onStep((event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1));
        } else if (event.key === "Escape") {
          event.preventDefault();
          exit("escape");
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (!invalid) exit("enter");
        }
      }}
      onBlur={() => {
        if (!exited.current) onExit("blur");
      }}
      className={cn(
        className,
        "field-sizing-content min-w-[1ch] border-focus-ring bg-gauge-bezel text-gauge-ink-focus aria-invalid:border-gauge-critical",
      )}
    />
  );
}

/** A − or + beside the editor: a click steps, Shift steps ten, holding repeats. Keeps the focus. */
function Stepper({
  definition,
  step,
  from,
  stepFrom,
  direction,
}: GaugeControl["stepper"] & { direction: 1 | -1 }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = () => clearTimeout(timer.current);
  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- clears a held stepper's repeat timer when the editor closes mid-hold
  useEffect(() => () => clearTimeout(timer.current), []);
  const Icon = direction === 1 ? PlusIcon : MinusIcon;

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${direction === 1 ? "Increase" : "Decrease"} ${definition.name} by ${formatStep(step)}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const steps = direction * (event.shiftKey ? 10 : 1);
        let value = stepFrom(from, steps);
        const repeat = (delay: number) => {
          timer.current = setTimeout(() => {
            value = stepFrom(value, steps);
            repeat(REPEAT_INTERVAL);
          }, delay);
        };
        stop();
        repeat(REPEAT_DELAY);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      // Pointer handling does the work; this keeps the mouse from taking focus from the input.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        // A click without a pointer comes from assistive tech.
        if (event.detail === 0) stepFrom(from, direction);
      }}
      className="flex aspect-square h-full cursor-default items-center justify-center rounded-sm border border-gauge-tick bg-gauge-bezel text-gauge-ink-muted transition-colors hover:border-gauge-tick-focus hover:bg-gauge-track hover:text-gauge-ink-focus"
    >
      <Icon aria-hidden className="size-[60%]" strokeWidth={2.5} />
    </button>
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
  return (
    <p
      aria-hidden
      className={cn(
        "gauge-themed pointer-events-none flex items-center justify-center gap-3 whitespace-nowrap text-2xs text-gauge-ink-muted opacity-0 transition-opacity duration-150",
        className,
      )}
    >
      <span>
        <kbd className="font-sans text-gauge-ink">↑ ↓</kbd> {formatStep(step)} {definition.unit}
      </span>
      <span>
        <kbd className="font-sans text-gauge-ink">⇧</kbd> {formatStep(step * 10)}
      </span>
      <span className="@max-[17rem]:hidden">Click the {target} to type</span>
    </p>
  );
}
