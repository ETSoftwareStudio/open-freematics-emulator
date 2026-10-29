import type { PidId, Preset, PresetId } from "@fme/contracts";

interface Scenario {
  readonly rpm: number;
  readonly speed: number;
  readonly load: number;
  readonly absoluteLoad: number;
  readonly throttle: number;
  readonly pedal: number;
  readonly map: number;
  readonly maf: number;
  readonly fuelRate: number;
  readonly timing: number;
  readonly coolant: number;
  readonly intakeAir: number;
  readonly oil: number;
  readonly ambient: number;
}

// Every built-in sets the same PIDs, so switching between them never leaves one behind.
const builtIn = (slug: string, name: string, s: Scenario): Preset => ({
  id: `builtin:${slug}` as PresetId,
  name,
  builtIn: true,
  pids: {
    ["010C" as PidId]: s.rpm,
    ["010D" as PidId]: s.speed,
    ["0104" as PidId]: s.load,
    ["0143" as PidId]: s.absoluteLoad,
    ["0111" as PidId]: s.throttle,
    ["0149" as PidId]: s.pedal,
    ["010B" as PidId]: s.map,
    ["0110" as PidId]: s.maf,
    ["015E" as PidId]: s.fuelRate,
    ["010E" as PidId]: s.timing,
    ["0105" as PidId]: s.coolant,
    ["010F" as PidId]: s.intakeAir,
    ["015C" as PidId]: s.oil,
    ["0146" as PidId]: s.ambient,
  },
});

/**
 * A 2.0 L naturally aspirated petrol engine. MAF follows RPM, MAP and volumetric
 * efficiency; fuel rate follows MAF at 14.7:1, or about 12.5:1 when cold or at full load.
 */
export const BUILT_IN_PRESETS: ReadonlyArray<Preset> = [
  builtIn("idle", "Idle", {
    rpm: 750,
    speed: 0,
    load: 25,
    absoluteLoad: 22,
    throttle: 14,
    pedal: 15,
    map: 30,
    maf: 3.2,
    fuelRate: 1.05,
    timing: 10,
    coolant: 90,
    intakeAir: 32,
    oil: 95,
    ambient: 22,
  }),
  builtIn("cruise", "Cruise", {
    rpm: 2350,
    speed: 72,
    load: 35,
    absoluteLoad: 31,
    throttle: 18,
    pedal: 24,
    map: 44,
    maf: 14.5,
    fuelRate: 4.75,
    timing: 32,
    coolant: 90,
    intakeAir: 28,
    oil: 98,
    ambient: 22,
  }),
  builtIn("cold-start", "Cold start", {
    rpm: 1250,
    speed: 0,
    load: 32,
    absoluteLoad: 28,
    throttle: 15,
    pedal: 15,
    map: 33,
    maf: 6.4,
    fuelRate: 2.45,
    timing: 4,
    coolant: 6,
    intakeAir: 7,
    oil: 6,
    ambient: 5,
  }),
  builtIn("wide-open-throttle", "Wide-open throttle", {
    rpm: 5500,
    speed: 98,
    load: 98,
    absoluteLoad: 92,
    throttle: 88,
    pedal: 84,
    map: 98,
    maf: 99.8,
    fuelRate: 38.55,
    timing: 24,
    coolant: 96,
    intakeAir: 30,
    oil: 108,
    ambient: 22,
  }),
  builtIn("overheat", "Overheat", {
    rpm: 820,
    speed: 0,
    load: 27,
    absoluteLoad: 24,
    throttle: 14,
    pedal: 15,
    map: 32,
    maf: 3.5,
    fuelRate: 1.15,
    timing: 2,
    coolant: 118,
    intakeAir: 55,
    oil: 128,
    ambient: 35,
  }),
];
