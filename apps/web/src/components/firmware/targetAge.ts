import type { ConnectTarget, Connection } from "@fme/contracts";
import { firmwareUpdateStatus, manufactureLabel, parseFirmwareInfo } from "@fme/shared/firmware";

const sameTarget = (a: ConnectTarget, b: ConnectTarget) =>
  a._tag === "serial" ? b._tag === "serial" && a.path === b.path : b._tag === "simulated";

/**
 * What the confirm step must say about the age of the unit an update targets. Only a connected
 * unit has reported its age, so a serial target that isn't the connected one counts as unreadable.
 * The server refuses a "too-old" unit until the update confirms it.
 */
export const targetAge = (
  connection: Connection | undefined,
  target: ConnectTarget,
): { readonly warning: "too-old" | "unknown-age" | null; readonly made: string | null } => {
  const unread = { warning: target._tag === "serial" ? "unknown-age" : null, made: null } as const;
  if (connection?._tag !== "connected" || !sameTarget(connection.target, target)) return unread;
  const device = connection.device;
  const info = parseFirmwareInfo(device?.banner ?? null, device?.details ?? null);
  const status = firmwareUpdateStatus(info);
  if (status === "too-old") return { warning: "too-old", made: manufactureLabel(info) };
  return status === "unknown-age" ? unread : { warning: null, made: null };
};
