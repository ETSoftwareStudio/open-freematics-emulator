import type { PidReading } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import type { PidDefinition } from "@fme/shared/pids";
import { TriangleAlertIcon } from "lucide-react";
import type * as React from "react";
import { useRef } from "react";
import { cn } from "~/lib/utils";
import { formatPidValue, readingMatches } from "../emulator/pidControl";
import {
  DIAL,
  type GaugeRange,
  type GaugeZone,
  START_ANGLE,
  SWEEP,
  angleToValue,
  arcPath,
  majorTicks,
  minorTicks,
  polar,
  valueToAngle,
  zoneAt,
} from "./gaugeGeometry";
import { svgPoint, useGaugeControl } from "./useGaugeControl";
import { GaugeHint, ValueEditor } from "./ValueEditor";

const { size: SIZE, center: C, radius: R } = DIAL;

const NO_ZONES: ReadonlyArray<GaugeZone> = [];
const ZONE_STROKE = { warning: "stroke-gauge-warning", critical: "stroke-gauge-critical" };
const ZONE_FILL = { warning: "fill-gauge-warning", critical: "fill-gauge-critical" };

export interface GaugeProps {
  readonly definition: PidDefinition;
  /** The value the emulator was told to serve. */
  readonly value: number;
  /** What the scan tool last read for this PID, when one is connected. */
  readonly reading: PidReading | undefined;
  /** Display range; may be narrower than the PID's encodable range. */
  readonly range: GaugeRange;
  readonly zones?: ReadonlyArray<GaugeZone>;
  /** About this many numbered ticks. */
  readonly majorTickCount: number;
  /** Minor ticks split each numbered interval into this many parts. */
  readonly minorDivisions: number;
  /** Tick labels are divided by this, e.g. 1000 for an rpm dial labelled 0–8. */
  readonly tickDivisor?: number;
  /** A small caption above the number, e.g. "×1000 r/min". */
  readonly scale?: string;
  /** Granularity of dragging and arrow keys. */
  readonly step?: number;
  readonly className?: string;
  /** A `SubGauge` drawn in the gap at the bottom of the dial. */
  readonly children?: React.ReactNode;
}

/**
 * A round dial that is also a slider. Its box is a container: everything inside is sized in `cqw`
 * so the dial scales with the pane, and the SVG is drawn in `DIAL` units.
 */
export function Gauge({
  definition,
  value,
  reading,
  range,
  zones = NO_ZONES,
  majorTickCount,
  minorDivisions,
  tickDivisor = 1,
  scale,
  step = definition.step,
  className,
  children,
}: GaugeProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const control = useGaugeControl({
    definition,
    value,
    range,
    step,
    valueAtPointer: (event) => {
      const point = svgPoint(svgRef.current, event);
      if (point === null) return null;
      return angleToValue((Math.atan2(point.y - C, point.x - C) * 180) / Math.PI, range);
    },
  });
  const { shown, formatted, dragging } = control;

  const { ticks, step: tickStep } = majorTicks(range, majorTickCount);
  const minor = minorTicks(ticks, tickStep, minorDivisions);
  const crowded = ticks.length > 10;
  const readbackMatches = reading !== undefined && readingMatches(definition, value, reading);

  return (
    <div className={cn("@container relative pb-5", className)}>
      <div className="group/dial contents">
        <div
          {...control.slider}
          className="group/slider block cursor-grab touch-none select-none rounded-full outline-none active:cursor-grabbing"
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="block w-full overflow-visible"
            {...control.pointer}
          >
            <circle
              cx={C}
              cy={C}
              r={C - 10}
              className="fill-none stroke-focus-ring opacity-0 group-focus-visible/slider:opacity-100"
              strokeWidth={1.5}
            />
            <path
              d={arcPath(C, R, START_ANGLE, START_ANGLE + SWEEP)}
              className="fill-none stroke-gauge-track"
              strokeWidth={1.5}
            />
            {zones.map((zone) => (
              <path
                key={`${zone.min}-${zone.tone}`}
                d={arcPath(C, R + 5, valueToAngle(zone.min, range), valueToAngle(zone.max, range))}
                className={cn("fill-none", ZONE_STROKE[zone.tone])}
                strokeWidth={3}
              />
            ))}

            {minor.map((tick) => {
              const angle = valueToAngle(tick, range);
              const outer = polar(C, R, angle);
              const inner = polar(C, R - 7, angle);
              const tone = zoneAt(zones, tick);
              return (
                <line
                  key={tick}
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  className={cn(
                    "transition-colors",
                    tone === undefined
                      ? "stroke-gauge-tick group-focus-within/dial:stroke-gauge-tick-focus"
                      : ZONE_STROKE[tone],
                  )}
                  strokeWidth={1.2}
                />
              );
            })}
            {ticks.map((tick) => {
              const angle = valueToAngle(tick, range);
              const outer = polar(C, R, angle);
              const inner = polar(C, R - 16, angle);
              const label = polar(C, R - (crowded ? 38 : 36), angle);
              const tone = zoneAt(zones, tick);
              return (
                <g key={tick}>
                  <line
                    x1={inner.x}
                    y1={inner.y}
                    x2={outer.x}
                    y2={outer.y}
                    className={cn(
                      "transition-colors",
                      tone === undefined
                        ? "stroke-gauge-ink-muted group-focus-within/dial:stroke-gauge-ink-muted-focus"
                        : ZONE_STROKE[tone],
                    )}
                    strokeWidth={2}
                  />
                  <text
                    x={label.x}
                    y={label.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className={cn(
                      "font-instrument tabular-nums transition-colors",
                      tone === undefined
                        ? "fill-gauge-ink-muted group-focus-within/dial:fill-gauge-ink-muted-focus"
                        : ZONE_FILL[tone],
                    )}
                    fontSize={crowded ? 18 : 22}
                  >
                    {Number((tick / tickDivisor).toFixed(2)).toLocaleString()}
                  </text>
                </g>
              );
            })}

            {scale === undefined ? null : (
              <text
                x={C}
                y={C - 64}
                textAnchor="middle"
                className="fill-gauge-ink-muted font-instrument transition-colors group-focus-within/dial:fill-gauge-ink-muted-focus"
                fontSize={16}
              >
                {scale}
              </text>
            )}
            <text
              x={C}
              y={C + 56}
              textAnchor="middle"
              className="fill-gauge-ink-muted font-instrument transition-colors group-focus-within/dial:fill-gauge-ink-muted-focus"
              fontSize={18}
            >
              {definition.unit}
            </text>

            {reading === undefined ? null : (
              <polygon
                points={`${C + R + 4},${C} ${C + R + 18},${C - 7} ${C + R + 18},${C + 7}`}
                className="fill-gauge-readback stroke-gauge-face transition-transform duration-300 ease-out"
                strokeWidth={2}
                style={{
                  transform: `rotate(${valueToAngle(reading.value, range)}deg)`,
                  transformOrigin: `${C}px ${C}px`,
                }}
              >
                <title>{`Scan tool read ${formatPidValue(definition, reading.value)} ${definition.unit}`}</title>
              </polygon>
            )}

            <g
              className={cn(
                "drop-shadow-[0_0_2.5px_var(--gauge-set)]",
                !dragging && "transition-transform duration-300 ease-out",
              )}
              style={{
                transform: `rotate(${valueToAngle(shown, range)}deg)`,
                transformOrigin: `${C}px ${C}px`,
              }}
            >
              <line
                x1={C + 108}
                y1={C}
                x2={C + R + 2}
                y2={C}
                className="stroke-gauge-set"
                strokeWidth={4}
                strokeLinecap="round"
              />
            </g>
          </svg>
        </div>

        {control.editing ? (
          <ValueEditor
            {...control.editor}
            className="absolute top-[39.5cqw] left-1/2 h-[18.6cqw] -translate-x-1/2 text-[17cqw]"
          />
        ) : (
          <button
            type="button"
            title="Type a value"
            aria-label={`${definition.name}: ${formatted} ${definition.unit}. Type a value`}
            onClick={control.startEditing}
            className="absolute top-[39.5cqw] left-1/2 flex h-[18.6cqw] -translate-x-1/2 cursor-text items-center rounded-sm border border-transparent border-dashed px-[2.5cqw] font-instrument text-[18.6cqw] text-gauge-ink tabular-nums leading-none tracking-tight outline-none transition-colors hover:border-gauge-tick focus-visible:border-focus-ring focus-visible:border-solid group-focus-within/dial:border-gauge-tick group-focus-within/dial:text-gauge-ink-focus"
          >
            {formatted}
          </button>
        )}

        {reading === undefined ? null : (
          <p
            className="absolute top-[72cqw] left-1/2 flex -translate-1/2 items-center gap-1 whitespace-nowrap text-2xs text-gauge-ink-muted tabular-nums"
            title={`Scan tool read ${formatHexBytes(reading.raw)}`}
          >
            <span aria-hidden className="text-gauge-readback">
              ▲
            </span>
            <span className="@max-[17rem]:sr-only">Scan tool</span>
            {formatPidValue(definition, reading.value)}
            {readbackMatches ? null : (
              <TriangleAlertIcon className="size-3 text-gauge-warning" aria-label="differs" />
            )}
          </p>
        )}

        <GaugeHint
          definition={definition}
          step={step}
          target="number"
          className="absolute inset-x-0 bottom-0 h-5 group-focus-within/dial:opacity-100"
        />
      </div>
      {children}
    </div>
  );
}
