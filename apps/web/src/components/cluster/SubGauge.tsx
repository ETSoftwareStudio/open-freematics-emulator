import type { PidReading } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import type { PidDefinition } from "@fme/shared/pids";
import { TriangleAlertIcon } from "lucide-react";
import { useRef } from "react";
import { cn } from "~/lib/utils";
import { formatPidValue, readingMatches } from "../emulator/pidControl";
import {
  DIAL,
  type GaugeRange,
  type GaugeZone,
  SUB_END_ANGLE,
  SUB_START_ANGLE,
  arcPath,
  polar,
  subAngleToValue,
  subValueToAngle,
} from "./gaugeGeometry";
import { svgPoint, useGaugeControl } from "./useGaugeControl";
import { GaugeHint, GaugeNumber } from "./ValueEditor";

const { center: C, subRadius: R } = DIAL;
// The sub-gauge's own SVG shows this window of the parent dial, so both share one coordinate space.
const VIEW = { x: 90, y: 318, width: 240, height: 84 };
const cqw = (units: number) => `${(units / DIAL.size) * 100}cqw`;

const NO_ZONES: ReadonlyArray<GaugeZone> = [];
const ZONE_STROKE = { warning: "stroke-gauge-warning", critical: "stroke-gauge-critical" };

/** A small arc gauge along the bottom of a `Gauge`, e.g. coolant C–H inside the tachometer. */
export function SubGauge({
  definition,
  value,
  reading,
  range,
  zones = NO_ZONES,
  ends,
  label,
  fill = false,
  step = definition.step,
}: {
  definition: PidDefinition;
  value: number;
  reading: PidReading | undefined;
  range: GaugeRange;
  zones?: ReadonlyArray<GaugeZone>;
  /** Letters at the low and high ends, e.g. ["E", "F"]. */
  ends: readonly [string, string];
  label: string;
  /** Fill the arc up to the value, like a fuel gauge. */
  fill?: boolean;
  step?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const control = useGaugeControl({
    definition,
    value,
    range,
    step,
    valueAtPointer: (event) => {
      const point = svgPoint(svgRef.current, event);
      if (point === null) return null;
      return subAngleToValue((Math.atan2(point.y - C, point.x - C) * 180) / Math.PI, range);
    },
  });
  const { shown, dragging, ghost } = control;
  const angle = subValueToAngle(shown, range);
  const low = polar(C, R, SUB_START_ANGLE);
  const high = polar(C, R, SUB_END_ANGLE);
  const readbackMatches = reading !== undefined && readingMatches(definition, value, reading);

  return (
    <div className="group/sub contents">
      <div
        {...control.slider}
        style={{
          left: cqw(VIEW.x),
          top: cqw(VIEW.y),
          width: cqw(VIEW.width),
          height: cqw(VIEW.height),
        }}
        className="group/slider absolute cursor-grab touch-none select-none outline-none active:cursor-grabbing"
      >
        <svg
          ref={svgRef}
          viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
          className="block size-full overflow-visible"
          {...control.pointer}
        >
          <path
            d={arcPath(C, R + 16, SUB_END_ANGLE - 4, SUB_START_ANGLE + 4)}
            className="fill-none stroke-focus-ring opacity-0 group-focus-visible/slider:opacity-100"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <path
            d={arcPath(C, R, SUB_END_ANGLE, SUB_START_ANGLE)}
            className="fill-none stroke-gauge-track transition-colors group-focus-within/sub:stroke-gauge-tick"
            strokeWidth={4}
          />
          {zones.map((zone) => (
            <path
              key={`${zone.min}-${zone.tone}`}
              d={arcPath(C, R, subValueToAngle(zone.max, range), subValueToAngle(zone.min, range))}
              className={cn("fill-none opacity-80", ZONE_STROKE[zone.tone])}
              strokeWidth={4}
            />
          ))}
          {fill ? (
            <path
              d={arcPath(C, R, angle, SUB_START_ANGLE)}
              className="fill-none stroke-gauge-ink-muted transition-colors group-focus-within/sub:stroke-gauge-ink-muted-focus"
              strokeWidth={4}
            />
          ) : null}
          {(
            [
              [ends[0], low.x - 13],
              [ends[1], high.x + 13],
            ] as const
          ).map(([text, x]) => (
            <text
              key={text}
              x={x}
              y={low.y + 5}
              textAnchor="middle"
              className="fill-gauge-ink-muted font-instrument transition-colors group-focus-within/sub:fill-gauge-ink-muted-focus"
              fontSize={15}
            >
              {text}
            </text>
          ))}
          {reading === undefined ? null : (
            <polygon
              points={`${C + R + 4},${C} ${C + R + 14},${C - 5} ${C + R + 14},${C + 5}`}
              className="fill-gauge-readback stroke-gauge-face transition-transform duration-300 ease-out"
              strokeWidth={1.5}
              style={{
                transform: `rotate(${subValueToAngle(reading.value, range)}deg)`,
                transformOrigin: `${C}px ${C}px`,
              }}
            >
              <title>{`Scan tool read ${formatPidValue(definition, reading.value)} ${definition.unit}`}</title>
            </polygon>
          )}
          {ghost === null ? null : (
            <line
              aria-hidden
              x1={C + R - 9}
              y1={C}
              x2={C + R + 9}
              y2={C}
              className="stroke-gauge-ink-muted"
              style={{
                transform: `rotate(${subValueToAngle(ghost, range)}deg)`,
                transformOrigin: `${C}px ${C}px`,
              }}
              strokeWidth={2.5}
              strokeDasharray="0 4.5"
              strokeLinecap="round"
            />
          )}
          <line
            x1={C + R - 7}
            y1={C}
            x2={C + R + 7}
            y2={C}
            className={cn(
              "stroke-gauge-set drop-shadow-[0_0_2px_var(--gauge-set)]",
              !dragging && "transition-transform duration-300 ease-out",
            )}
            style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${C}px ${C}px` }}
            strokeWidth={3}
            strokeLinecap="round"
          />
        </svg>
      </div>

      <GaugeNumber
        control={control}
        style={{ top: cqw(C + 129) }}
        className="absolute left-1/2 -translate-1/2 gap-[1cqw] whitespace-nowrap text-[max(0.625rem,3.8cqw)] text-gauge-ink-muted transition-colors group-focus-within/sub:text-gauge-ink-muted-focus"
        numberClassName="h-[1.5em] px-[0.25em]"
        buttonClassName="group-focus-within/sub:text-gauge-ink-focus"
      >
        <span>{definition.unit}</span>
        {label}
        {reading === undefined ? null : (
          <span
            className="ms-[0.5em] text-gauge-ink-muted tabular-nums"
            title={`Scan tool read ${formatHexBytes(reading.raw)}`}
          >
            <span aria-hidden className="text-gauge-readback">
              ▲
            </span>{" "}
            {formatPidValue(definition, reading.value)}
            {readbackMatches ? null : (
              <TriangleAlertIcon
                className="ms-1 inline size-[1em] text-gauge-warning"
                aria-label="differs"
              />
            )}
          </span>
        )}
      </GaugeNumber>

      <GaugeHint
        definition={definition}
        step={step}
        target="value"
        className="absolute inset-x-0 bottom-0 h-5 group-focus-within/sub:opacity-100"
      />
    </div>
  );
}
