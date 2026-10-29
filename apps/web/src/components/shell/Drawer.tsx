import { useRef, useState } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { usePersistentState } from "~/lib/usePersistentState";

const KEY_STEP = 24;
/** The space a drawer leaves above itself, so it can't push its neighbours off screen. */
const RESERVED_ABOVE = 160;

/**
 * A pane docked to the bottom of its column. Drag its top edge (or focus the edge and use the
 * arrow keys) to resize; the height is remembered under `storageKey`.
 */
export function Drawer({
  storageKey,
  defaultHeight = 150,
  minHeight = 64,
  className,
  children,
  ...props
}: React.ComponentProps<"section"> & {
  storageKey: string;
  defaultHeight?: number;
  minHeight?: number;
}) {
  const [height, setHeight] = usePersistentState(`fme:drawer:${storageKey}`, defaultHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  const clamp = (next: number) => {
    const available = (ref.current?.parentElement?.clientHeight ?? Infinity) - RESERVED_ABOVE;
    return Math.round(Math.max(minHeight, Math.min(next, available)));
  };
  const shown = dragHeight ?? height;

  return (
    <section
      ref={ref}
      style={{ height: shown }}
      className={cn("relative flex min-h-0 shrink-0 flex-col bg-window text-xs", className)}
      {...props}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize"
        aria-valuenow={shown}
        tabIndex={0}
        className="absolute inset-x-0 -top-0.75 z-10 h-1.5 cursor-row-resize touch-none outline-none before:absolute before:inset-x-0 before:top-0.75 before:h-px before:bg-separator focus-visible:before:h-0.5 focus-visible:before:bg-ring"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startY: event.clientY, startHeight: shown };
        }}
        onPointerMove={(event) => {
          if (drag.current === null) return;
          setDragHeight(clamp(drag.current.startHeight + drag.current.startY - event.clientY));
        }}
        onPointerUp={() => {
          drag.current = null;
          if (dragHeight !== null) setHeight(dragHeight);
          setDragHeight(null);
        }}
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowUp" ? KEY_STEP : event.key === "ArrowDown" ? -KEY_STEP : 0;
          if (step === 0) return;
          event.preventDefault();
          setHeight(clamp(height + step));
        }}
      />
      {children}
    </section>
  );
}
