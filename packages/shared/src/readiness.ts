import type { ReadinessMonitor, ReadinessMonitorId } from "@fme/contracts";

interface MonitorBits {
  readonly label: string;
  /** Byte index (B=1, C=2, D=3) and bit of the "supported" flag in PID 0101. */
  readonly supported: readonly [number, number];
  /** Byte and bit of the "incomplete" flag; SAE sets the bit while the test has not run. */
  readonly incomplete: readonly [number, number];
}

export const READINESS_MONITORS: Readonly<Record<ReadinessMonitorId, MonitorBits>> = {
  misfire: { label: "Misfire", supported: [1, 0], incomplete: [1, 4] },
  fuelSystem: { label: "Fuel system", supported: [1, 1], incomplete: [1, 5] },
  components: { label: "Components", supported: [1, 2], incomplete: [1, 6] },
  catalyst: { label: "Catalyst", supported: [2, 0], incomplete: [3, 0] },
  heatedCatalyst: { label: "Heated catalyst", supported: [2, 1], incomplete: [3, 1] },
  evaporativeSystem: { label: "Evaporative system", supported: [2, 2], incomplete: [3, 2] },
  secondaryAirSystem: { label: "Secondary air system", supported: [2, 3], incomplete: [3, 3] },
  acRefrigerant: { label: "A/C refrigerant", supported: [2, 4], incomplete: [3, 4] },
  oxygenSensor: { label: "Oxygen sensor", supported: [2, 5], incomplete: [3, 5] },
  oxygenSensorHeater: { label: "Oxygen sensor heater", supported: [2, 6], incomplete: [3, 6] },
  egrSystem: { label: "EGR system", supported: [2, 7], incomplete: [3, 7] },
};

export const READINESS_MONITOR_IDS = Object.keys(
  READINESS_MONITORS,
) as ReadonlyArray<ReadinessMonitorId>;

/**
 * Encodes Mode 01 PID 01 (monitor status since DTCs cleared). Byte A carries the MIL
 * and the stored DTC count, so it is derived from the Mode 03 codes.
 */
export const encodeMonitorStatus = (
  readiness: Readonly<Record<ReadinessMonitorId, ReadinessMonitor>>,
  storedDtcCount: number,
): readonly [number, number, number, number] => {
  const bytes: [number, number, number, number] = [
    (storedDtcCount > 0 ? 0x80 : 0) | (storedDtcCount & 0x7f),
    0,
    0,
    0,
  ];
  for (const id of READINESS_MONITOR_IDS) {
    const bits = READINESS_MONITORS[id];
    const monitor = readiness[id];
    if (monitor.supported) bytes[bits.supported[0]]! |= 1 << bits.supported[1];
    if (monitor.supported && !monitor.complete)
      bytes[bits.incomplete[0]]! |= 1 << bits.incomplete[1];
  }
  return bytes;
};
