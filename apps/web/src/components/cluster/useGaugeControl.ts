import { type PidDefinition, clampPidValue } from "@fme/shared/pids";
import type * as React from "react";
import { useRef, useState } from "react";
import { formatPidValue, usePidControl } from "../emulator/pidControl";
import { type GaugeRange, keyedValue, snapToStep } from "./gaugeGeometry";
import {
  type EditorExit,
  exitTarget,
  ghostValue,
  parseTyped,
  snapToPid,
  stepValue,
} from "./valueEditing";

/** Pointer movement below this many pixels is a click: it focuses the gauge without moving it. */
const DRAG_THRESHOLD = 4;

/** Where a pointer event lands in an SVG's user units, or null before layout. */
export const svgPoint = (svg: SVGSVGElement | null, event: React.PointerEvent) => {
  const matrix = svg?.getScreenCTM();
  if (matrix == null) return null;
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
};

export type GaugeControl = ReturnType<typeof useGaugeControl>;

/** The shared behaviour of a cluster control: drag, arrow keys, and click-to-type. */
export function useGaugeControl({
  definition,
  value,
  range,
  step,
  valueAtPointer,
}: {
  definition: PidDefinition;
  value: number;
  range: GaugeRange;
  step: number;
  /** The unsnapped value under the pointer, or null when it can't be measured. */
  valueAtPointer: (event: React.PointerEvent) => number | null;
}) {
  const { shown, dragging, change, commit } = usePidControl(definition, value);
  const sliderRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // The text being typed, and the value to restore on Escape.
  const [edit, setEdit] = useState<{ text: string; original: number } | null>(null);

  const pointerValue = (event: React.PointerEvent) => {
    const next = valueAtPointer(event);
    return next === null ? shown : snapToStep(next, range, step);
  };
  const formatted = formatPidValue(definition, shown);
  const parsed = edit === null ? null : parseTyped(edit.text);
  const typed = parsed === null ? null : clampPidValue(definition, parsed);
  const startEditing = () => setEdit({ text: formatted, original: shown });

  /** Applies a step at once, like a drag: the needle moves, the value is sent, the text follows. */
  const stepFrom = (from: number, steps: number) => {
    const next = stepValue(from, steps, definition, step);
    change(next);
    setEdit((current) => current && { ...current, text: formatPidValue(definition, next) });
    return next;
  };

  const finish = (exit: EditorExit) => {
    if (edit === null) return;
    const target = exitTarget(exit, { typed, original: edit.original, shown, live: dragging });
    if (target !== null) {
      // Through the draft, so a key released on the slider can't commit the stale one.
      change(target);
      void commit(target);
    } else if (dragging) void commit(shown);
    setEdit(null);
    if (exit !== "blur") sliderRef.current?.focus();
  };

  return {
    definition,
    shown,
    formatted,
    dragging,
    editing: edit !== null,
    ghost: edit === null ? null : ghostValue(typed, shown, range),
    startEditing,
    slider: {
      ref: sliderRef,
      role: "slider",
      tabIndex: 0,
      "aria-label": definition.name,
      "aria-valuemin": definition.min,
      "aria-valuemax": definition.max,
      "aria-valuenow": shown,
      "aria-valuetext": `${formatted} ${definition.unit}`,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          startEditing();
          return;
        }
        const next = keyedValue(event.key, event.shiftKey, shown, range, step);
        if (next === undefined) return;
        event.preventDefault();
        // Held keys repeat faster than the server echoes, so steps build on the draft until keyup.
        change(snapToPid(definition, next, step));
      },
      onKeyUp: () => {
        if (dragging) void commit(shown);
      },
      onBlur: () => {
        if (dragging) void commit(shown);
      },
    },
    pointer: {
      onPointerDown: (event: React.PointerEvent) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStart.current = { x: event.clientX, y: event.clientY, moved: false };
      },
      onPointerMove: (event: React.PointerEvent) => {
        const start = dragStart.current;
        if (start === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        if (
          !start.moved &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD
        )
          return;
        start.moved = true;
        change(pointerValue(event));
      },
      onPointerUp: (event: React.PointerEvent) => {
        if (dragStart.current?.moved) void commit(pointerValue(event));
        dragStart.current = null;
      },
      onPointerCancel: () => {
        if (dragStart.current?.moved) void commit(shown);
        dragStart.current = null;
      },
    },
    editor: {
      definition,
      text: edit?.text ?? "",
      invalid: typed === null,
      onTextChange: (text: string) => setEdit((current) => current && { ...current, text }),
      onStep: (steps: number) => stepFrom(typed ?? shown, steps),
      onExit: finish,
    },
    stepper: { definition, step, from: typed ?? shown, stepFrom },
  };
}
