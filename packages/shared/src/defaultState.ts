import type { EmulatorState, PidId, ReadinessMonitor, ReadinessMonitorId } from "@fme/contracts";
import { PIDS } from "./pids.ts";
import { READINESS_MONITOR_IDS } from "./readiness.ts";

export const makeDefaultState = (): EmulatorState => ({
  connection: { _tag: "disconnected" },
  ignition: true,
  protocol: "CAN_11B_500K",
  vinEnabled: true,
  vin: null,
  calibrationId: null,
  dtcs: { "03": [], "07": [], "0A": [] },
  pids: Object.fromEntries(
    PIDS.map((definition) => [definition.id, definition.defaultValue]),
  ) as Record<PidId, number>,
  readiness: Object.fromEntries(
    READINESS_MONITOR_IDS.map((id): [ReadinessMonitorId, ReadinessMonitor] => [
      id,
      { supported: true, complete: true },
    ]),
  ) as Record<ReadinessMonitorId, ReadinessMonitor>,
});
