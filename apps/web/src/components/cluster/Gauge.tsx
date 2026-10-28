import type { PidReading } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import { type PidDefinition, clampPidValue } from "@fme/shared/pids";
import { TriangleAlertIcon } from "lucide-react";
import type * as React from "react";
import { useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { formatPidValue, readingMatches, usePidControl } from "../emulator/pidControl";
import {
  type GaugeRange,
  type GaugeZone,
  START_ANGLE,
  SWEEP,
  angleToValue,
  arcPath,
  majorTicks,
  polar,
  valueFraction,
  valueToAngle,
  zoneAt,
} from "./gaugeGeometry";

const CENTER = 100;
const TRACK_RADIUS = 80;
const END_ANGLE = START_ANGLE + SWEEP;
const TRACK = arcPath(CENTER, TRACK_RADIUS, START_ANGLE, END_ANGLE);

const FILL_TONE = {
  normal: "stroke-gauge-set",
  warning: "stroke-gauge-warning",
  critical: "stroke-gauge-critical",
};

const NO_ZONES: ReadonlyArray<GaugeZone> = [];

const ZONE_TONE = { warning: "stroke-gauge-warning", critical: "stroke-gauge-critical" };

export interface GaugeProps {
  readonly definition: PidDefinition;
  /** The value the emulator was told to serve. */
  readonly value: number;
  /** What the scan tool last read for this PID, when one is connected. */
  readonly reading: PidReading | undefined;
  /** Display range; may be narrower than the PID's encodable range. */
  readonly range: GaugeRange;
  readonly zones?: ReadonlyArray<GaugeZone>;
  readonly label: string;
  /** Tick labels are divided by this, e.g. 1000 for an rpm dial labelled 0–8. */
  readonly tickDivisor?: number;
  /** Granularity of dragging and arrow keys. */
  readonly step?: number;
  readonly size: "lg" | "sm";
  readonly className?: string;
}

/** Parses a typed value, tolerating digit grouping ("1,000") and stray spaces. */
const parseTyped = (text: string) => {
  const cleaned = text.replace(/[\s,]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
};

// Stable, so React calls it once on mount rather than re-selecting on every keystroke.
const selectOnMount = (input: HTMLInputElement | null) => input?.select();

function ReadoutEditor({
  definition,
  value,
  step,
  onSubmit,
  onDone,
}: {
  definition: PidDefinition;
  value: number;
  step: number;
  onSubmit: (value: number) => void;
  /** Leaves edit mode; `refocus` hands focus back to the dial after Enter or Escape. */
  onDone: (refocus: boolean) => void;
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
      className="absolute left-1/2 top-[72.5cqw] h-[15cqw] -translate-x-1/2 rounded-md bg-gauge-bezel text-center font-semibold text-[13cqw] text-gauge-ink tabular-nums leading-none outline-none ring-2 ring-gauge-set aria-invalid:ring-gauge-critical"
    />
  );
}

export function Gauge({
  definition,
  value,
  reading,
  range,
  zones = NO_ZONES,
  label,
  tickDivisor = 1,
  step = definition.step,
  size,
  className,
}: GaugeProps) {
  const { shown, dragging, change, commit } = usePidControl(definition, value);
  const svgRef = useRef<SVGSVGElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  // A click only focuses the dial (for arrow keys); the needle follows the pointer once it drags.
  const dragStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const large = size === "lg";

  const snap = (next: number) =>
    Math.min(range.max, Math.max(range.min, Math.round(next / step) * step));
  const valueAtPointer = (event: React.PointerEvent) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (box === undefined) return shown;
    const x = ((event.clientX - box.left) / box.width) * 200 - CENTER;
    const y = ((event.clientY - box.top) / box.height) * 200 - CENTER;
    return snap(angleToValue((Math.atan2(y, x) * 180) / Math.PI, range));
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setEditing(true);
      return;
    }
    const bigStep = Math.max(step, (range.max - range.min) / 10);
    const next = {
      ArrowUp: shown + step,
      ArrowRight: shown + step,
      ArrowDown: shown - step,
      ArrowLeft: shown - step,
      PageUp: shown + bigStep,
      PageDown: shown - bigStep,
      Home: range.min,
      End: range.max,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    // Held keys repeat faster than the server echoes, so steps build on the draft until keyup.
    change(snap(next));
  };

  const tone = zoneAt(zones, shown) ?? "normal";
  const { ticks, step: tickStep } = majorTicks(range, large ? 8 : 4);
  const minorTicks = large
    ? ticks.slice(0, -1).map((tick) => tick + tickStep / 2)
    : ([] as Array<number>);
  const fraction = valueFraction(shown, range);
  const needleAngle = valueToAngle(shown, range);
  const formatted = formatPidValue(definition, shown);
  const readbackMatches = reading !== undefined && readingMatches(definition, value, reading);

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div className="@container relative w-full">
        <div
          ref={sliderRef}
          role="slider"
          tabIndex={0}
          aria-label={definition.name}
          aria-valuemin={range.min}
          aria-valuemax={range.max}
          aria-valuenow={shown}
          aria-valuetext={`${formatted} ${definition.unit}`}
          onKeyDown={onKeyDown}
          onKeyUp={() => {
            if (dragging) void commit(shown);
          }}
          onBlur={() => {
            if (dragging) void commit(shown);
          }}
          className="w-full cursor-grab touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-gauge-set active:cursor-grabbing"
        >
          <svg
            ref={svgRef}
            viewBox="0 0 200 200"
            className="block w-full"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStart.current = { x: event.clientX, y: event.clientY, moved: false };
            }}
            onPointerMove={(event) => {
              const start = dragStart.current;
              if (start === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4)
                return;
              start.moved = true;
              change(valueAtPointer(event));
            }}
            onPointerUp={(event) => {
              if (dragStart.current?.moved) void commit(valueAtPointer(event));
              dragStart.current = null;
            }}
            onPointerCancel={() => {
              if (dragStart.current?.moved) void commit(shown);
              dragStart.current = null;
            }}
          >
            <circle cx={CENTER} cy={CENTER} r={98} className="fill-gauge-bezel" />
            <circle cx={CENTER} cy={CENTER} r={94} className="fill-gauge-face" />

            {zones.map((zone) => (
              <path
                key={`${zone.min}-${zone.tone}`}
                d={arcPath(
                  CENTER,
                  TRACK_RADIUS + 10,
                  valueToAngle(zone.min, range),
                  valueToAngle(zone.max, range),
                )}
                className={cn("fill-none", ZONE_TONE[zone.tone])}
                strokeWidth={3}
              />
            ))}

            <path
              d={TRACK}
              className="fill-none stroke-gauge-track"
              strokeWidth={large ? 8 : 12}
              strokeLinecap="round"
            />
            {/* The fill is the track with a dash: dash lengths animate where path data can't. */}
            {fraction > 0 ? (
              <path
                d={TRACK}
                pathLength={100}
                // A gap longer than the path keeps a second round cap from showing at the far end.
                strokeDasharray={`${fraction * 100} 200`}
                className={cn(
                  "fill-none",
                  FILL_TONE[tone],
                  !dragging && "transition-[stroke-dasharray] duration-300 ease-out",
                )}
                strokeWidth={large ? 8 : 12}
                strokeLinecap="round"
              />
            ) : null}

            {ticks.map((tick) => {
              const angle = valueToAngle(tick, range);
              const outer = polar(CENTER, TRACK_RADIUS - 8, angle);
              const inner = polar(CENTER, TRACK_RADIUS - (large ? 16 : 14), angle);
              const text = polar(CENTER, TRACK_RADIUS - 26, angle);
              return (
                <g key={tick}>
                  <line
                    x1={inner.x}
                    y1={inner.y}
                    x2={outer.x}
                    y2={outer.y}
                    className="stroke-gauge-ink-muted"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  {large ? (
                    <text
                      x={text.x}
                      y={text.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="fill-gauge-ink-muted font-sans"
                      fontSize={11}
                    >
                      {Number((tick / tickDivisor).toFixed(2)).toLocaleString()}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {minorTicks.map((tick) => {
              const angle = valueToAngle(tick, range);
              const outer = polar(CENTER, TRACK_RADIUS - 8, angle);
              const inner = polar(CENTER, TRACK_RADIUS - 12, angle);
              return (
                <line
                  key={tick}
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  className="stroke-gauge-tick"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              );
            })}

            <text
              x={CENTER}
              y={128}
              textAnchor="middle"
              className="fill-gauge-ink-muted font-sans uppercase tracking-wider"
              fontSize={large ? 9 : 12}
            >
              {label}
            </text>

            {reading === undefined ? null : (
              <polygon
                points={`${CENTER + TRACK_RADIUS + 5},${CENTER} ${CENTER + 97},${CENTER - 6} ${CENTER + 97},${CENTER + 6}`}
                className="fill-gauge-readback stroke-gauge-face transition-transform duration-300 ease-out"
                strokeWidth={2}
                style={{
                  transform: `rotate(${valueToAngle(reading.value, range)}deg)`,
                  transformOrigin: `${CENTER}px ${CENTER}px`,
                }}
              >
                <title>{`Scan tool read ${formatPidValue(definition, reading.value)} ${definition.unit}`}</title>
              </polygon>
            )}

            <g
              className={cn(!dragging && "transition-transform duration-300 ease-out")}
              style={{
                transform: `rotate(${needleAngle}deg)`,
                transformOrigin: `${CENTER}px ${CENTER}px`,
              }}
            >
              <line
                x1={CENTER - 10}
                y1={CENTER}
                x2={CENTER + TRACK_RADIUS - 4}
                y2={CENTER}
                className="stroke-gauge-ink"
                strokeWidth={large ? 3 : 4}
                strokeLinecap="round"
              />
            </g>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={large ? 7 : 9}
              className="fill-gauge-bezel stroke-gauge-ink"
              strokeWidth={2}
            />

            <text
              x={CENTER}
              y={186}
              textAnchor="middle"
              className="fill-gauge-ink-muted font-sans"
              fontSize={large ? 10 : 12}
            >
              {definition.unit}
            </text>
          </svg>
        </div>
        {editing ? (
          <ReadoutEditor
            definition={definition}
            value={shown}
            step={step}
            onSubmit={(typed) => void commit(typed)}
            onDone={(refocus) => {
              setEditing(false);
              if (refocus) sliderRef.current?.focus();
            }}
          />
        ) : (
          <button
            type="button"
            title="Type a value"
            aria-label={`${definition.name}: ${formatted} ${definition.unit}. Type a value`}
            onClick={() => setEditing(true)}
            className="absolute left-1/2 top-[72.5cqw] h-[15cqw] -translate-x-1/2 cursor-text rounded-md px-[0.25em] font-semibold text-[13cqw] text-gauge-ink tabular-nums leading-none outline-none transition-colors hover:bg-gauge-ink/10 focus-visible:ring-2 focus-visible:ring-gauge-set"
          >
            {formatted}
          </button>
        )}
      </div>
      {reading === undefined ? null : (
        <p
          className="flex items-center gap-1 text-2xs text-gauge-ink-muted tabular-nums"
          title={`Scan tool read ${formatHexBytes(reading.raw)}`}
        >
          <span aria-hidden className="text-gauge-readback">
            ▲
          </span>
          {large ? "Scan tool " : null}
          {formatPidValue(definition, reading.value)}
          {readbackMatches ? null : (
            <TriangleAlertIcon className="size-3 text-gauge-warning" aria-label="differs" />
          )}
        </p>
      )}
    </div>
  );
}
