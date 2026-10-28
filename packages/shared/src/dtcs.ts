import type { PidId } from "@fme/contracts";

export interface DtcEntry {
  readonly code: string;
  readonly description: string;
}

const misfires = Array.from({ length: 8 }, (_, i) => ({
  code: `P030${i + 1}`,
  description: `Cylinder ${i + 1} misfire detected`,
}));
const injectors = Array.from({ length: 4 }, (_, i) => ({
  code: `P020${i + 1}`,
  description: `Injector circuit malfunction, cylinder ${i + 1}`,
}));

/** Common generic (SAE J2012) codes. Codes outside it get a category from `describeDtc`. */
export const DTC_CATALOG: ReadonlyArray<DtcEntry> = [
  { code: "P0100", description: "Mass air flow circuit malfunction" },
  { code: "P0101", description: "Mass air flow circuit range/performance" },
  { code: "P0102", description: "Mass air flow circuit low input" },
  { code: "P0103", description: "Mass air flow circuit high input" },
  { code: "P0105", description: "Manifold absolute pressure circuit malfunction" },
  { code: "P0106", description: "Manifold absolute pressure circuit range/performance" },
  { code: "P0107", description: "Manifold absolute pressure circuit low input" },
  { code: "P0108", description: "Manifold absolute pressure circuit high input" },
  { code: "P0110", description: "Intake air temperature circuit malfunction" },
  { code: "P0112", description: "Intake air temperature circuit low input" },
  { code: "P0113", description: "Intake air temperature circuit high input" },
  { code: "P0115", description: "Engine coolant temperature circuit malfunction" },
  { code: "P0116", description: "Engine coolant temperature circuit range/performance" },
  { code: "P0117", description: "Engine coolant temperature circuit low input" },
  { code: "P0118", description: "Engine coolant temperature circuit high input" },
  { code: "P0120", description: "Throttle position sensor A circuit malfunction" },
  { code: "P0121", description: "Throttle position sensor A circuit range/performance" },
  { code: "P0122", description: "Throttle position sensor A circuit low input" },
  { code: "P0123", description: "Throttle position sensor A circuit high input" },
  { code: "P0125", description: "Insufficient coolant temperature for closed loop fuel control" },
  { code: "P0128", description: "Coolant thermostat below regulating temperature" },
  { code: "P0130", description: "O2 sensor circuit malfunction (bank 1 sensor 1)" },
  { code: "P0131", description: "O2 sensor circuit low voltage (bank 1 sensor 1)" },
  { code: "P0132", description: "O2 sensor circuit high voltage (bank 1 sensor 1)" },
  { code: "P0133", description: "O2 sensor circuit slow response (bank 1 sensor 1)" },
  { code: "P0134", description: "O2 sensor circuit no activity detected (bank 1 sensor 1)" },
  { code: "P0135", description: "O2 sensor heater circuit malfunction (bank 1 sensor 1)" },
  { code: "P0136", description: "O2 sensor circuit malfunction (bank 1 sensor 2)" },
  { code: "P0141", description: "O2 sensor heater circuit malfunction (bank 1 sensor 2)" },
  { code: "P0150", description: "O2 sensor circuit malfunction (bank 2 sensor 1)" },
  { code: "P0155", description: "O2 sensor heater circuit malfunction (bank 2 sensor 1)" },
  { code: "P0171", description: "System too lean (bank 1)" },
  { code: "P0172", description: "System too rich (bank 1)" },
  { code: "P0174", description: "System too lean (bank 2)" },
  { code: "P0175", description: "System too rich (bank 2)" },
  { code: "P0200", description: "Injector circuit malfunction" },
  ...injectors,
  { code: "P0217", description: "Engine overtemperature condition" },
  { code: "P0230", description: "Fuel pump primary circuit malfunction" },
  { code: "P0300", description: "Random/multiple cylinder misfire detected" },
  ...misfires,
  { code: "P0325", description: "Knock sensor 1 circuit malfunction (bank 1)" },
  { code: "P0335", description: "Crankshaft position sensor A circuit malfunction" },
  { code: "P0340", description: "Camshaft position sensor circuit malfunction" },
  { code: "P0351", description: "Ignition coil A primary/secondary circuit malfunction" },
  { code: "P0400", description: "Exhaust gas recirculation flow malfunction" },
  { code: "P0401", description: "Exhaust gas recirculation flow insufficient" },
  { code: "P0402", description: "Exhaust gas recirculation flow excessive" },
  { code: "P0410", description: "Secondary air injection system malfunction" },
  { code: "P0420", description: "Catalyst system efficiency below threshold (bank 1)" },
  { code: "P0430", description: "Catalyst system efficiency below threshold (bank 2)" },
  { code: "P0440", description: "Evaporative emission system malfunction" },
  { code: "P0441", description: "Evaporative emission system incorrect purge flow" },
  { code: "P0442", description: "Evaporative emission system leak detected (small leak)" },
  { code: "P0446", description: "Evaporative emission system vent control circuit malfunction" },
  { code: "P0455", description: "Evaporative emission system leak detected (large leak)" },
  { code: "P0456", description: "Evaporative emission system leak detected (very small leak)" },
  { code: "P0500", description: "Vehicle speed sensor malfunction" },
  { code: "P0505", description: "Idle control system malfunction" },
  { code: "P0506", description: "Idle control system RPM lower than expected" },
  { code: "P0507", description: "Idle control system RPM higher than expected" },
  { code: "P0560", description: "System voltage malfunction" },
  { code: "P0562", description: "System voltage low" },
  { code: "P0563", description: "System voltage high" },
  { code: "P0600", description: "Serial communication link malfunction" },
  { code: "P0601", description: "Internal control module memory checksum error" },
  { code: "P0700", description: "Transmission control system malfunction" },
  { code: "P0715", description: "Input/turbine speed sensor circuit malfunction" },
  { code: "P0720", description: "Output speed sensor circuit malfunction" },
  { code: "P0740", description: "Torque converter clutch circuit malfunction" },
  { code: "C0035", description: "Left front wheel speed sensor circuit" },
  { code: "C0040", description: "Right front wheel speed sensor circuit" },
  { code: "C0045", description: "Left rear wheel speed sensor circuit" },
  { code: "C0050", description: "Right rear wheel speed sensor circuit" },
  { code: "U0001", description: "High speed CAN communication bus" },
  { code: "U0100", description: "Lost communication with ECM/PCM A" },
  { code: "U0101", description: "Lost communication with TCM" },
  { code: "U0121", description: "Lost communication with ABS control module" },
  { code: "U0140", description: "Lost communication with body control module" },
  { code: "U0155", description: "Lost communication with instrument panel cluster" },
];

const byCode = new Map(DTC_CATALOG.map((entry) => [entry.code, entry.description]));

const SYSTEMS: Record<string, string> = {
  P: "Powertrain",
  C: "Chassis",
  B: "Body",
  U: "Network",
};

/** A catalog description, or the system and whether the code is generic or maker-specific. */
export const describeDtc = (code: string) => {
  const known = byCode.get(code.toUpperCase());
  if (known !== undefined) return { description: known, known: true };
  const system = SYSTEMS[code.charAt(0).toUpperCase()] ?? "Unknown";
  // The second character is 1 (and 3 for most systems) for manufacturer-defined codes.
  const makerSpecific =
    code.charAt(1) === "1" || (code.charAt(0) !== "P" && code.charAt(1) === "3");
  return {
    description: `${makerSpecific ? "Manufacturer-specific" : "Generic"} ${system.toLowerCase()} code`,
    known: false,
  };
};

/** Counters SAE J1979 Mode 04 (clear diagnostic information) resets to zero. */
export const PIDS_RESET_BY_CLEAR: ReadonlyArray<PidId> = [
  "0121",
  "014D",
  "0130",
  "0131",
  "014E",
].map((id) => id as PidId);
