import type { PidId } from "@fme/contracts";

export type PidGroup =
  | "Engine"
  | "Speed & distance"
  | "Throttle"
  | "Air & fuel"
  | "Temperatures"
  | "Emissions";

export interface PidDefinition {
  readonly id: PidId;
  readonly name: string;
  readonly unit: string;
  readonly group: PidGroup;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
  /** SAE J1979 encoding: the bytes a vehicle reports for `value`. */
  readonly encode: (value: number) => ReadonlyArray<number>;
  /** SAE J1979 decoding: what a scan tool shows for the reported bytes. */
  readonly decode: (bytes: ReadonlyArray<number>) => number;
}

/** Every catalog PID is linear: `value = raw * scale + offset`, big-endian over 1 or 2 bytes. */
interface Linear {
  readonly bytes: 1 | 2;
  readonly scale: number;
  readonly offset?: number;
}

const linear = ({ bytes, scale, offset = 0 }: Linear) => {
  const maxRaw = bytes === 1 ? 0xff : 0xffff;
  return {
    encode: (value: number) => {
      const raw = Math.min(maxRaw, Math.max(0, Math.round((value - offset) / scale)));
      return bytes === 1 ? [raw] : [raw >> 8, raw & 0xff];
    },
    decode: (data: ReadonlyArray<number>) => {
      const raw = bytes === 1 ? (data[0] ?? 0) : ((data[0] ?? 0) << 8) | (data[1] ?? 0);
      return raw * scale + offset;
    },
  };
};

const plain = linear({ bytes: 1, scale: 1 });
const word = linear({ bytes: 2, scale: 1 });
const temperature = linear({ bytes: 1, scale: 1, offset: -40 });
const percent = linear({ bytes: 1, scale: 100 / 255 });
const torquePercent = linear({ bytes: 1, scale: 1, offset: -125 });
const catalystTemperature = linear({ bytes: 2, scale: 0.1, offset: -40 });

const pid = (
  id: string,
  name: string,
  unit: string,
  group: PidGroup,
  range: { min: number; max: number; step?: number; defaultValue?: number },
  codec: Pick<PidDefinition, "encode" | "decode">,
): PidDefinition => ({
  id: id as PidId,
  name,
  unit,
  group,
  min: range.min,
  max: range.max,
  step: range.step ?? 1,
  defaultValue: range.defaultValue ?? Math.max(range.min, 0),
  ...codec,
});

/**
 * The PIDs the official GUI exposes. Defaults match the official GUI's `defaults.xml`.
 */
export const PIDS: ReadonlyArray<PidDefinition> = [
  pid(
    "010C",
    "Engine RPM",
    "rpm",
    "Engine",
    { min: 0, max: 9999, defaultValue: 1000 },
    linear({ bytes: 2, scale: 0.25 }),
  ),
  pid(
    "0104",
    "Calculated engine load",
    "%",
    "Engine",
    { min: 0, max: 100, defaultValue: 50 },
    percent,
  ),
  pid(
    "0143",
    "Absolute load value",
    "%",
    "Engine",
    { min: 0, max: 100, defaultValue: 50 },
    linear({ bytes: 2, scale: 100 / 255 }),
  ),
  pid(
    "010E",
    "Timing advance",
    "°",
    "Engine",
    { min: -64, max: 63 },
    linear({ bytes: 1, scale: 0.5, offset: -64 }),
  ),
  pid(
    "0161",
    "Driver's demand torque",
    "%",
    "Engine",
    { min: -125, max: 125, defaultValue: 90 },
    torquePercent,
  ),
  pid(
    "0162",
    "Actual engine torque",
    "%",
    "Engine",
    { min: -125, max: 125, defaultValue: 50 },
    torquePercent,
  ),
  pid(
    "0163",
    "Engine reference torque",
    "Nm",
    "Engine",
    { min: 0, max: 65535, defaultValue: 240 },
    word,
  ),
  pid(
    "0142",
    "Control module voltage",
    "V",
    "Engine",
    { min: 0, max: 65, step: 0.1, defaultValue: 14 },
    linear({ bytes: 2, scale: 0.001 }),
  ),
  pid("011F", "Run time since engine start", "s", "Engine", { min: 0, max: 65535 }, word),

  pid(
    "010D",
    "Vehicle speed",
    "km/h",
    "Speed & distance",
    { min: 0, max: 255, defaultValue: 50 },
    plain,
  ),
  pid("0121", "Distance with MIL on", "km", "Speed & distance", { min: 0, max: 65535 }, word),
  pid(
    "0131",
    "Distance since codes cleared",
    "km",
    "Speed & distance",
    { min: 0, max: 65535 },
    word,
  ),
  pid("014D", "Time run with MIL on", "min", "Speed & distance", { min: 0, max: 65535 }, word),
  pid("014E", "Time since codes cleared", "min", "Speed & distance", { min: 0, max: 65535 }, word),
  pid("0130", "Warm-ups since codes cleared", "", "Speed & distance", { min: 0, max: 255 }, plain),

  pid(
    "0111",
    "Throttle position",
    "%",
    "Throttle",
    { min: 0, max: 100, defaultValue: 20 },
    percent,
  ),
  pid("0145", "Relative throttle position", "%", "Throttle", { min: 0, max: 100 }, percent),
  pid("0147", "Absolute throttle position B", "%", "Throttle", { min: 0, max: 100 }, percent),
  pid("0148", "Absolute throttle position C", "%", "Throttle", { min: 0, max: 100 }, percent),
  pid("0149", "Accelerator pedal position D", "%", "Throttle", { min: 0, max: 100 }, percent),
  pid("014A", "Accelerator pedal position E", "%", "Throttle", { min: 0, max: 100 }, percent),
  pid("014B", "Accelerator pedal position F", "%", "Throttle", { min: 0, max: 100 }, percent),
  pid("014C", "Commanded throttle actuator", "%", "Throttle", { min: 0, max: 100 }, percent),
  pid(
    "015A",
    "Relative accelerator pedal position",
    "%",
    "Throttle",
    { min: 0, max: 100 },
    percent,
  ),

  pid(
    "010B",
    "Intake manifold pressure",
    "kPa",
    "Air & fuel",
    { min: 0, max: 255, defaultValue: 100 },
    plain,
  ),
  pid(
    "0110",
    "MAF air flow rate",
    "g/s",
    "Air & fuel",
    { min: 0, max: 655, step: 0.01, defaultValue: 80 },
    linear({ bytes: 2, scale: 0.01 }),
  ),
  pid(
    "0133",
    "Barometric pressure",
    "kPa",
    "Air & fuel",
    { min: 0, max: 255, defaultValue: 101 },
    plain,
  ),
  pid(
    "010A",
    "Fuel pressure",
    "kPa",
    "Air & fuel",
    { min: 0, max: 765, step: 3, defaultValue: 150 },
    linear({ bytes: 1, scale: 3 }),
  ),
  pid(
    "0122",
    "Fuel rail pressure (relative)",
    "kPa",
    "Air & fuel",
    { min: 0, max: 5177, defaultValue: 200 },
    linear({ bytes: 2, scale: 0.079 }),
  ),
  pid(
    "0123",
    "Fuel rail gauge pressure",
    "kPa",
    "Air & fuel",
    { min: 0, max: 655350, step: 10 },
    linear({ bytes: 2, scale: 10 }),
  ),
  pid(
    "012F",
    "Fuel tank level",
    "%",
    "Air & fuel",
    { min: 0, max: 100, defaultValue: 75 },
    percent,
  ),
  pid("0152", "Ethanol fuel", "%", "Air & fuel", { min: 0, max: 100 }, percent),
  pid(
    "015D",
    "Fuel injection timing",
    "°",
    "Air & fuel",
    { min: -210, max: 301 },
    linear({ bytes: 2, scale: 1 / 128, offset: -210 }),
  ),
  pid(
    "015E",
    "Engine fuel rate",
    "L/h",
    "Air & fuel",
    { min: 0, max: 3212, step: 0.05, defaultValue: 20 },
    linear({ bytes: 2, scale: 0.05 }),
  ),

  pid(
    "0105",
    "Engine coolant temperature",
    "°C",
    "Temperatures",
    { min: -40, max: 215, defaultValue: 90 },
    temperature,
  ),
  pid(
    "010F",
    "Intake air temperature",
    "°C",
    "Temperatures",
    { min: -40, max: 215, defaultValue: 20 },
    temperature,
  ),
  pid(
    "0146",
    "Ambient air temperature",
    "°C",
    "Temperatures",
    { min: -40, max: 215, defaultValue: 25 },
    temperature,
  ),
  pid(
    "015C",
    "Engine oil temperature",
    "°C",
    "Temperatures",
    { min: -40, max: 210, defaultValue: 95 },
    temperature,
  ),
  pid(
    "013C",
    "Catalyst temp. bank 1 sensor 1",
    "°C",
    "Temperatures",
    { min: -40, max: 6513 },
    catalystTemperature,
  ),
  pid(
    "013D",
    "Catalyst temp. bank 2 sensor 1",
    "°C",
    "Temperatures",
    { min: -40, max: 6513 },
    catalystTemperature,
  ),
  pid(
    "013E",
    "Catalyst temp. bank 1 sensor 2",
    "°C",
    "Temperatures",
    { min: -40, max: 6513 },
    catalystTemperature,
  ),
  pid(
    "013F",
    "Catalyst temp. bank 2 sensor 2",
    "°C",
    "Temperatures",
    { min: -40, max: 6513 },
    catalystTemperature,
  ),

  pid("012C", "Commanded EGR", "%", "Emissions", { min: 0, max: 100 }, percent),
  pid(
    "012D",
    "EGR error",
    "%",
    "Emissions",
    { min: -100, max: 99 },
    linear({ bytes: 1, scale: 100 / 128, offset: -100 }),
  ),
  pid("012E", "Commanded evaporative purge", "%", "Emissions", { min: 0, max: 100 }, percent),
];

export const PID_GROUPS: ReadonlyArray<PidGroup> = [
  "Engine",
  "Speed & distance",
  "Throttle",
  "Air & fuel",
  "Temperatures",
  "Emissions",
];

const byId = new Map(PIDS.map((definition) => [definition.id, definition]));

export const findPid = (id: string): PidDefinition | undefined => byId.get(id as PidId);

const decimals = (step: number) =>
  Number.isInteger(step) ? 0 : (String(step).split(".")[1]?.length ?? 0);

export const clampPidValue = (definition: PidDefinition, value: number): number => {
  const clamped = Math.min(definition.max, Math.max(definition.min, value));
  const snapped = Math.round(clamped / definition.step) * definition.step;
  return Number(snapped.toFixed(decimals(definition.step)));
};
