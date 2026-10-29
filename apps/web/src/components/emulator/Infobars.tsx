import { useAtom } from "@effect/atom-react";
import { LATEST_OFFICIAL_FIRMWARE } from "@fme/shared/firmware";
import { CircleAlertIcon, DownloadIcon, TriangleAlertIcon } from "lucide-react";
import { Infobar } from "~/components/shell/Infobar";
import { Button } from "~/components/ui/button";
import { usePersistentState } from "~/lib/usePersistentState";
import { lastErrorAtom } from "~/rpc/hooks";
import { useEmulatorTarget } from "./ConnectionControls";
import { UpdateInstructions, useFirmware } from "./Firmware";

function FirmwareInfobar() {
  const { updatable, info } = useFirmware();
  // Dismissing hides this release's notice; a newer release shows it again.
  const [dismissed, setDismissed] = usePersistentState<string>("fme:firmware-notice-dismissed", "");
  if (!updatable || dismissed === LATEST_OFFICIAL_FIRMWARE.version) return null;
  const latest = LATEST_OFFICIAL_FIRMWARE.version;
  return (
    <Infobar
      tone="warning"
      icon={DownloadIcon}
      actions={<UpdateInstructions />}
      onDismiss={() => setDismissed(latest)}
    >
      <b>Firmware V{latest} is available.</b> This MK2 runs V{info.version}
      {info.buildLabel !== null ? ` (${info.buildLabel})` : ""}. Freematics publishes no release
      notes; the V{latest} image has commands for pending and permanent codes and the calibration
      ID, which V{info.version} rejects.
    </Infobar>
  );
}

function ConnectionInfobar() {
  const target = useEmulatorTarget();
  if (!target.serverReachable) return null;
  if (target.connection?._tag === "failed") {
    return (
      <Infobar
        tone="error"
        icon={CircleAlertIcon}
        actions={
          <Button size="micro" variant="outline" onClick={target.connectSelected}>
            Try Again
          </Button>
        }
      >
        <b>Could not connect to {target.label}.</b> {target.connection.reason}
      </Infobar>
    );
  }
  if (target.connection?._tag !== "disconnected") return null;
  return (
    <Infobar
      tone="warning"
      icon={TriangleAlertIcon}
      actions={
        <Button size="micro" variant="outline" onClick={target.connectSelected}>
          Connect
        </Button>
      }
    >
      <b>Not connected to {target.label}.</b> Changes you make are kept here and sent to the device
      when you connect.
    </Infobar>
  );
}

function CommandErrorInfobar() {
  const [error, setError] = useAtom(lastErrorAtom);
  if (error === null) return null;
  return (
    <Infobar tone="error" icon={CircleAlertIcon} onDismiss={() => setError(null)} title={error}>
      <b>Command failed.</b> {error}
    </Infobar>
  );
}

/** Window-wide notices, newest concern last. */
export function Infobars() {
  return (
    <>
      <FirmwareInfobar />
      <ConnectionInfobar />
      <CommandErrorInfobar />
    </>
  );
}
