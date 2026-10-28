import type { PidId } from "@fme/contracts";
import { type PidDefinition, findPid } from "@fme/shared/pids";
import { BatteryWarningIcon, FuelIcon, KeyRoundIcon, ThermometerIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { useEmulatorState, useReaderState } from "~/rpc/hooks";
import { Panel } from "../emulator/Panel";
import { Gauge, type GaugeProps } from "./Gauge";
import { type GaugeTone, type GaugeZone, zoneAt } from "./gaugeGeometry";

interface DialSpec extends Pick<GaugeProps, "range" | "zones" | "label" | "tickDivisor" | "step"> {
  readonly definition: PidDefinition;
}

const dial = (id: string, spec: Omit<DialSpec, "definition">): DialSpec => {
  const definition = findPid(id);
  if (definition === undefined) throw new Error(`PID ${id} is not in the catalog`);
  return { definition, ...spec };
};

const zone = (min: number, max: number, tone: GaugeTone): GaugeZone => ({ min, max, tone });

const TACHOMETER = dial("010C", {
  label: "rpm × 1000",
  range: { min: 0, max: 8000 },
  zones: [zone(6500, 8000, "critical")],
  tickDivisor: 1000,
  step: 50,
});
const SPEEDOMETER = dial("010D", { label: "Speed", range: { min: 0, max: 260 } });
const COOLANT = dial("0105", {
  label: "Coolant",
  range: { min: 40, max: 130 },
  zones: [zone(105, 115, "warning"), zone(115, 130, "critical")],
});
const FUEL = dial("012F", {
  label: "Fuel",
  range: { min: 0, max: 100 },
  zones: [zone(0, 10, "critical"), zone(10, 20, "warning")],
});
const BATTERY = dial("0142", {
  label: "Battery",
  range: { min: 8, max: 16 },
  zones: [zone(8, 11.5, "critical"), zone(11.5, 12.2, "warning"), zone(14.8, 16, "warning")],
  step: 0.1,
});
const SECONDARY = [
  dial("0111", { label: "Throttle", range: { min: 0, max: 100 } }),
  dial("0104", { label: "Load", range: { min: 0, max: 100 } }),
  BATTERY,
  dial("015C", {
    label: "Oil temp",
    range: { min: 40, max: 160 },
    zones: [zone(130, 145, "warning"), zone(145, 160, "critical")],
  }),
];
const ODOMETER = "0131" as PidId;

export const CLUSTER_PIDS: ReadonlyArray<PidId> = [
  TACHOMETER,
  SPEEDOMETER,
  COOLANT,
  FUEL,
  ...SECONDARY,
].map((spec) => spec.definition.id);

const LAMP_TONE = { warning: "text-gauge-warning", critical: "text-gauge-critical" };

/** Same outline style as the lucide icons beside it; lucide has no engine. */
function EngineIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M2 10v6M2 13h3M5 9h3V7h6v2h2l2 2h1V9h3v9h-3v-2h-1l-2 3H9l-4-3z" />
    </svg>
  );
}

function Lamp({
  icon: Icon,
  label,
  lit,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  lit: boolean;
  tone?: GaugeTone;
}) {
  return (
    <li className={cn("flex items-center gap-1.5", lit ? "text-gauge-ink" : "text-gauge-tick")}>
      <Icon className={cn("size-4", lit && tone !== undefined && LAMP_TONE[tone])} />
      {label}
      <span className="sr-only">{lit ? "on" : "off"}</span>
    </li>
  );
}

export function ClusterPanel({ className }: { className?: string }) {
  const { state } = useEmulatorState();
  const reader = useReaderState();
  if (state === null) return null;

  // With the ignition off nothing answers, so last readings would be stale.
  const readingBack = reader?.connection._tag === "connected" && reader.vehicleResponding;
  const valueOf = ({ definition }: DialSpec) =>
    state.pids[definition.id] ?? definition.defaultValue;
  const gauge = (spec: DialSpec, size: GaugeProps["size"], className: string) => (
    <Gauge
      key={spec.definition.id}
      {...spec}
      value={valueOf(spec)}
      reading={readingBack ? reader.readings[spec.definition.id] : undefined}
      size={size}
      className={className}
    />
  );
  const inCritical = (spec: DialSpec) => zoneAt(spec.zones ?? [], valueOf(spec)) === "critical";
  const odometer = state.pids[ODOMETER] ?? 0;

  return (
    <Panel.Root className={cn("border-gauge-bezel bg-gauge-face text-gauge-ink", className)}>
      <Panel.Header className="flex-wrap border-gauge-bezel">
        <Panel.Title>Instrument cluster</Panel.Title>
        <p className="text-gauge-ink-muted text-xs">Drag a needle or use the arrow keys.</p>
        {readingBack ? (
          <Panel.Actions className="text-gauge-ink-muted text-xs">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="h-1 w-3 rounded-full bg-gauge-set" />
              Set on emulator
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="text-gauge-readback">
                ▲
              </span>
              Read by scan tool
            </span>
          </Panel.Actions>
        ) : null}
      </Panel.Header>
      <Panel.Body
        className={cn("flex flex-col gap-6 transition-opacity", !state.ignition && "opacity-50")}
      >
        <div className="grid items-center gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,1fr)]">
          {gauge(TACHOMETER, "lg", "mx-auto w-full max-w-80")}
          <div className="mx-auto grid w-full max-w-80 grid-cols-2 gap-4 md:grid-cols-1">
            {gauge(COOLANT, "sm", "mx-auto w-full max-w-36")}
            {gauge(FUEL, "sm", "mx-auto w-full max-w-36")}
          </div>
          {gauge(SPEEDOMETER, "lg", "mx-auto w-full max-w-80")}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {SECONDARY.map((spec) => gauge(spec, "sm", "mx-auto w-full max-w-36"))}
        </div>
      </Panel.Body>
      <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-gauge-bezel border-t px-4 py-3 text-xs">
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Warning lights">
          <Lamp
            icon={KeyRoundIcon}
            label={state.ignition ? "Ignition on" : "Ignition off"}
            lit={state.ignition}
          />
          <Lamp
            icon={EngineIcon}
            label="Check engine"
            lit={state.dtcs["03"].length > 0}
            tone="warning"
          />
          <Lamp
            icon={ThermometerIcon}
            label="Coolant temp"
            lit={inCritical(COOLANT)}
            tone="critical"
          />
          <Lamp
            icon={BatteryWarningIcon}
            label="Charging"
            lit={inCritical(BATTERY)}
            tone="critical"
          />
          <Lamp
            icon={FuelIcon}
            label="Low fuel"
            lit={zoneAt(FUEL.zones ?? [], valueOf(FUEL)) !== undefined}
            tone="warning"
          />
        </ul>
        <p className="ms-auto font-mono text-gauge-ink-muted tabular-nums">
          {odometer.toLocaleString()} km since codes cleared
        </p>
      </footer>
    </Panel.Root>
  );
}
