import type { PidDefinition } from "@fme/shared/pids";
import type * as React from "react";
import { useRef, useState } from "react";
import { formatPidValue, usePidControl } from "../emulator/pidControl";
import { type GaugeRange, keyedValue, snapToStep } from "./gaugeGeometry";

/** Pointer movement below this many pixels is a click: it focuses the gauge without moving it. */
const DRAG_THRESHOLD = 4;

/** Where a pointer event lands in an SVG's user units, or null before layout. */
export const svgPoint = (svg: SVGSVGElement | null, event: React.PointerEvent) => {
  const matrix = svg?.getScreenCTM();
  if (matrix == null) return null;
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
};

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
  const [editing, setEditing] = useState(false);

  const pointerValue = (event: React.PointerEvent) => {
    const next = valueAtPointer(event);
    return next === null ? shown : snapToStep(next, range, step);
  };
  const formatted = formatPidValue(definition, shown);

  return {
    shown,
    formatted,
    dragging,
    editing,
    startEditing: () => setEditing(true),
    slider: {
      ref: sliderRef,
      role: "slider",
      tabIndex: 0,
      "aria-label": definition.name,
      "aria-valuemin": range.min,
      "aria-valuemax": range.max,
      "aria-valuenow": shown,
      "aria-valuetext": `${formatted} ${definition.unit}`,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          setEditing(true);
          return;
        }
        const next = keyedValue(event.key, event.shiftKey, shown, range, step);
        if (next === undefined) return;
        event.preventDefault();
        // Held keys repeat faster than the server echoes, so steps build on the draft until keyup.
        change(snapToStep(next, range, step));
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
      value: shown,
      step,
      onSubmit: (typed: number) => void commit(typed),
      /** Leaves edit mode; `refocus` hands focus back to the slider after Enter or Escape. */
      onDone: (refocus: boolean) => {
        setEditing(false);
        if (refocus) sliderRef.current?.focus();
      },
    },
  };
}
