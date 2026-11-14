import type { PidId } from "@fme/contracts";
import { type PidDefinition, findPid } from "@fme/shared/pids";
import { cn } from "~/lib/utils";
import { useEmulatorState, useReaderState } from "~/rpc/hooks";
import { Gauge } from "./Gauge";
import { type GaugeRange, type GaugeTone, type GaugeZone, zoneAt } from "./gaugeGeometry";
import { Readout } from "./Readout";
import { SubGauge } from "./SubGauge";

interface Spec {
  readonly definition: PidDefinition;
  readonly range: GaugeRange;
  readonly zones?: ReadonlyArray<GaugeZone>;
  readonly step?: number;
}

const spec = (id: string, rest: Omit<Spec, "definition">): Spec => {
  const definition = findPid(id);
  if (definition === undefined) throw new Error(`PID ${id} is not in the catalog`);
  return { definition, ...rest };
};

const zone = (min: number, max: number, tone: GaugeTone): GaugeZone => ({ min, max, tone });

const TACHOMETER = spec("010C", {
  range: { min: 0, max: 8000 },
  zones: [zone(6500, 8000, "critical")],
  step: 50,
});
const SPEEDOMETER = spec("010D", { range: { min: 0, max: 260 } });
const COOLANT = spec("0105", {
  range: { min: 40, max: 130 },
  zones: [zone(105, 115, "warning"), zone(115, 130, "critical")],
});
const FUEL = spec("012F", {
  range: { min: 0, max: 100 },
  zones: [zone(0, 10, "critical"), zone(10, 20, "warning")],
});
const VOLTAGE = spec("0142", {
  range: { min: 8, max: 16 },
  zones: [zone(8, 11.5, "critical"), zone(11.5, 12.2, "warning"), zone(14.8, 16, "warning")],
  step: 0.1,
});
const READOUTS = [
  { label: "Throttle", ...spec("0111", { range: { min: 0, max: 100 } }) },
  { label: "Engine load", ...spec("0104", { range: { min: 0, max: 100 } }) },
  { label: "Module voltage", ...VOLTAGE },
  {
    label: "Oil temp",
    ...spec("015C", {
      range: { min: 40, max: 160 },
      zones: [zone(130, 145, "warning"), zone(145, 160, "critical")],
    }),
  },
  { label: "Fuel rate", ...spec("015E", { range: { min: 0, max: 30 }, step: 0.1 }) },
];
const ODOMETER = "0131" as PidId;

export const CLUSTER_PIDS: ReadonlyArray<PidId> = [
  TACHOMETER,
  SPEEDOMETER,
  COOLANT,
  FUEL,
  ...READOUTS,
].map((s) => s.definition.id);

/** Dash telltales in one 24px outline style; lucide has no engine or coolant symbol. */
const TELLTALE = {
  ignition: (
    <>
      <circle cx="7.5" cy="12" r="4" />
      <path d="M11.5 12H21M18 12v3.5M21 12v2.5" />
    </>
  ),
  engine: (
    <>
      <path d="M2.5 10.5v5M2.5 13H5M5 9.5h3.5V7.5h6v2h2.5l2 2H21v4.5h-1.5L17 18.5H9.5L7 16H5z" />
      <path d="M10 5.5h3" />
    </>
  ),
  coolant: (
    <>
      <path d="M12 3.5v9.2M12 6h3M12 9h3" />
      <circle cx="12" cy="15" r="2.4" />
      <path d="M3 20.5c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0" />
    </>
  ),
  charging: (
    <>
      <rect x="3" y="7.5" width="18" height="11.5" rx="1" />
      <path d="M6.5 7.5V5.5h3v2M14.5 7.5V5.5h3v2M6.5 13.5h3.5M14 13.5h3.5M15.75 11.75v3.5" />
    </>
  ),
  fuel: (
    <>
      <path d="M4.5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M3 20h12M6.5 6.5h5v4h-5z" />
      <path d="M13.5 9.5H15l2 2v6a1.5 1.5 0 0 0 3 0V9l-2.5-2.5" />
    </>
  ),
};

const LAMP_TONE = {
  on: "text-success",
  warning: "text-gauge-warning",
  critical: "text-gauge-critical",
};

function Lamp({
  icon,
  label,
  lit,
  tone,
  href,
}: {
  icon: keyof typeof TELLTALE;
  label: string;
  lit: boolean;
  tone: keyof typeof LAMP_TONE;
  /** Where the lamp's settings live; the lamp becomes a link there. */
  href?: string;
}) {
  const content = (
    <>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={cn("size-6.5 transition-colors", lit ? LAMP_TONE[tone] : "text-gauge-track")}
      >
        {TELLTALE[icon]}
      </svg>
      {label}
      <span className="sr-only">{lit ? "on" : "off"}</span>
    </>
  );
  const className = "flex flex-col items-center gap-1.5 text-center leading-tight";
  return (
    <li className={cn("text-2xs", lit ? "text-gauge-ink" : "text-gauge-ink-muted")}>
      {href === undefined ? (
        <span className={className}>{content}</span>
      ) : (
        <a
          href={href}
          className={cn(
            className,
            "cursor-default rounded-sm outline-none hover:text-gauge-ink-focus focus-visible:ring-1 focus-visible:ring-focus-ring",
          )}
        >
          {content}
        </a>
      )}
    </li>
  );
}

export function ClusterPanel({ className }: { className?: string }) {
  const { state } = useEmulatorState();
  const reader = useReaderState();
  if (state === null) return null;

  // With the ignition off nothing answers, so last readings would be stale.
  const readingBack = reader?.connection._tag === "connected" && reader.vehicleResponding;
  const valueOf = ({ definition }: Spec) => state.pids[definition.id] ?? definition.defaultValue;
  const live = <S extends Spec>(s: S) => ({
    ...s,
    value: valueOf(s),
    reading: readingBack ? reader.readings[s.definition.id] : undefined,
  });
  const toneOf = (s: Spec) => zoneAt(s.zones ?? [], valueOf(s), s.range);
  const odometer = state.pids[ODOMETER] ?? 0;
  // Container units: the dash is a size container, so dials fit its width and its height.
  // The dials stay dark in a light window, on a face painted behind the SVG; isolate keeps the
  // face above the pane.
  const dial = cn(
    "w-[min(37.5cqw,calc(100cqh-1.75rem))] shrink-0",
    "gauge-dark isolate before:absolute before:inset-x-0 before:top-0 before:-z-10 before:aspect-square before:rounded-full before:bg-(image:--dial-face) before:shadow-(--dial-shadow)",
  );

  return (
    <section
      aria-label="Instrument cluster"
      className={cn("@container flex flex-col text-gauge-ink", className)}
    >
      <div
        className={cn(
          "flex min-h-60 flex-1 items-center justify-center gap-[1.5cqw] px-3.5 pt-2 transition-opacity [container-type:size]",
          !state.ignition && "opacity-50",
        )}
      >
        <Gauge
          {...live(TACHOMETER)}
          majorTickCount={8}
          minorDivisions={4}
          tickDivisor={1000}
          scale="×1000 r/min"
          className={dial}
        >
          <SubGauge {...live(COOLANT)} ends={["C", "H"]} label="coolant" />
        </Gauge>
        <div className="@container flex min-w-0 max-w-60 flex-1 flex-col items-center gap-[min(9cqh,3rem)]">
          <ul
            className="grid grid-cols-2 justify-center gap-x-1 gap-y-3.5 @[12rem]:grid-cols-3 [&>li]:w-15.5"
            aria-label="Warning lamps"
          >
            <Lamp icon="ignition" label="Ignition" lit={state.ignition} tone="on" />
            <Lamp
              icon="engine"
              label="Check engine"
              lit={state.dtcs["03"].length > 0}
              tone="warning"
              href="#inspector-diagnostics"
            />
            <Lamp
              icon="coolant"
              label="Coolant"
              lit={toneOf(COOLANT) === "critical"}
              tone="critical"
            />
            <Lamp
              icon="charging"
              label="Charging"
              lit={toneOf(VOLTAGE) === "critical"}
              tone="critical"
            />
            <Lamp icon="fuel" label="Low fuel" lit={toneOf(FUEL) !== undefined} tone="warning" />
          </ul>
          <p className="flex flex-col items-center gap-0.5 text-center">
            <span className="font-instrument text-2xl text-gauge-ink tabular-nums leading-none">
              {odometer.toLocaleString()}
              <span className="ms-1 font-sans text-gauge-ink-muted text-xs">km</span>
            </span>
            <span className="text-2xs text-gauge-ink-muted">since codes cleared</span>
          </p>
        </div>
        <Gauge {...live(SPEEDOMETER)} majorTickCount={13} minorDivisions={2} className={dial}>
          <SubGauge {...live(FUEL)} ends={["E", "F"]} label="fuel" fill />
        </Gauge>
      </div>
      <div
        className={cn(
          "@container grid shrink-0 grid-cols-5 border-gauge-track border-t transition-opacity",
          !state.ignition && "opacity-50",
        )}
      >
        {READOUTS.map((s) => (
          <Readout key={s.definition.id} {...live(s)} />
        ))}
      </div>
    </section>
  );
}
