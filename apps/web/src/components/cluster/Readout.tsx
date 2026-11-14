import type { PidReading } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import type { PidDefinition } from "@fme/shared/pids";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatPidValue, readingMatches } from "../emulator/pidControl";
import { type GaugeRange, type GaugeZone, valueFraction, zoneAt } from "./gaugeGeometry";
import { useGaugeControl } from "./useGaugeControl";
import { GaugeNumber } from "./ValueEditor";

const NO_ZONES: ReadonlyArray<GaugeZone> = [];
const ZONE_TEXT = { warning: "text-gauge-warning", critical: "text-gauge-critical" };
const ZONE_BG = { warning: "bg-gauge-warning", critical: "bg-gauge-critical" };

/** One cell of the row under the dials: name, PID, value and a bar that is also a slider. */
export function Readout({
  definition,
  value,
  reading,
  range,
  zones = NO_ZONES,
  label,
  step = definition.step,
}: {
  definition: PidDefinition;
  value: number;
  reading: PidReading | undefined;
  range: GaugeRange;
  zones?: ReadonlyArray<GaugeZone>;
  label: string;
  step?: number;
}) {
  const control = useGaugeControl({
    definition,
    value,
    range,
    step,
    valueAtPointer: (event) => {
      const box = event.currentTarget.getBoundingClientRect();
      return range.min + ((event.clientX - box.left) / box.width) * (range.max - range.min);
    },
  });
  const { shown, dragging, ghost } = control;
  const tone = zoneAt(zones, shown, range);
  const readbackMatches = reading !== undefined && readingMatches(definition, value, reading);

  return (
    <div className="group/readout flex min-w-0 flex-col border-gauge-track border-s px-3.5 pt-2 pb-2.5 first:border-s-0 @max-3xl:px-2.5">
      <p className="truncate text-2xs text-gauge-ink-muted" title={definition.name}>
        {label}
        <code className="ms-1 font-mono">{definition.id}</code>
      </p>
      <div className="flex h-7.5 items-center gap-2">
        <GaugeNumber
          control={control}
          steppers="after"
          className="-ms-1 min-w-0"
          numberClassName="h-7 px-1 text-2xl"
          buttonClassName={cn(
            "group-focus-within/readout:text-gauge-ink-focus",
            tone !== undefined && ZONE_TEXT[tone],
          )}
        >
          <span className="ms-0.5 font-sans text-gauge-ink-muted text-xs">{definition.unit}</span>
        </GaugeNumber>
        {reading === undefined ? null : (
          <span
            className="ms-auto flex shrink-0 items-center gap-1 text-2xs text-gauge-ink-muted tabular-nums"
            title={`Scan tool read ${formatHexBytes(reading.raw)}`}
          >
            <span aria-hidden className="text-gauge-readback">
              ▲
            </span>
            {formatPidValue(definition, reading.value)}
            {readbackMatches ? null : (
              <TriangleAlertIcon className="size-3 text-gauge-warning" aria-label="differs" />
            )}
          </span>
        )}
      </div>
      <div
        {...control.slider}
        {...control.pointer}
        className="group/slider relative mt-1 h-3 cursor-grab touch-none select-none outline-none active:cursor-grabbing"
      >
        <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-gauge-track ring-focus-ring ring-offset-2 ring-offset-gauge-face group-focus-visible/slider:ring-1">
          <div
            className={cn(
              "h-full rounded-full bg-gauge-ink-muted transition-colors group-focus-within/readout:bg-gauge-ink-muted-focus",
              tone !== undefined && ZONE_BG[tone],
              !dragging && "transition-[width,background-color] duration-300 ease-out",
            )}
            style={{ width: `${valueFraction(shown, range) * 100}%` }}
          />
        </div>
        {ghost === null ? null : (
          <span
            aria-hidden
            className="absolute inset-y-0 -translate-x-1/2 border-gauge-ink-muted border-l-2 border-dotted"
            style={{ left: `${valueFraction(ghost, range) * 100}%` }}
          />
        )}
        {reading === undefined ? null : (
          <span
            aria-hidden
            className="absolute -top-1 size-0 -translate-x-1/2 border-x-4 border-x-transparent border-t-5 border-t-gauge-readback transition-[left] duration-300 ease-out"
            style={{ left: `${valueFraction(reading.value, range) * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}
