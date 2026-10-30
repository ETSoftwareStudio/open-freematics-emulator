import { firmwareUpdateStatus, manufactureLabel, parseFirmwareInfo } from "@fme/shared/firmware";
import { useEmulatorState } from "~/rpc/hooks";

/** What the connected emulator reported about its firmware, and whether a newer one exists. */
export function useFirmware() {
  const { state } = useEmulatorState();
  const connection = state?.connection;
  const connected = connection?._tag === "connected";
  const device = connected ? connection.device : null;
  const simulated = connected && connection.target._tag === "simulated";
  const info = parseFirmwareInfo(device?.banner ?? null, device?.details ?? null);
  const update = connected && !simulated ? firmwareUpdateStatus(info) : "unknown";
  return {
    connected,
    simulated,
    banner: device?.banner ?? null,
    info,
    made: manufactureLabel(info),
    update,
    updatable: update === "available",
  };
}
