import {
  LATEST_OFFICIAL_FIRMWARE,
  firmwareUpdateStatus,
  manufactureLabel,
  parseFirmwareInfo,
} from "@fme/shared/firmware";
import { SquareArrowOutUpRightIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { useEmulatorState } from "~/rpc/hooks";

const STEPS = [
  "Download the official Freematics Emulator GUI below — it bundles the firmware and the vendor's updater.",
  "Keep the emulator on USB with 12 V power connected.",
  "In the GUI, click “Update Firmware” and pick this emulator's serial port.",
  "When it finishes, power-cycle the emulator before reconnecting here.",
];

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

export function UpdateInstructions() {
  const { made } = useFirmware();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="micro" variant="outline">
            Open Freematics Updater…
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-80" width="auto">
        <PopoverTitle className="font-medium text-sm">
          Update to V{LATEST_OFFICIAL_FIRMWARE.version}
        </PopoverTitle>
        <p className="mt-1 text-muted-foreground text-xs">
          Use Freematics' own updater. Flashing a real MK2 from this app is locked for now.
        </p>
        <p className="mt-2 text-xs">
          Freematics advises against updating units made before 2018.
          {made !== null ? ` This one was made in ${made}.` : ""}
        </p>
        <ol className="mt-3 flex list-decimal flex-col gap-1.5 ps-4 text-xs">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a
          href={LATEST_OFFICIAL_FIRMWARE.downloadUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex items-center gap-1.5 font-medium text-info-foreground text-xs hover:underline"
        >
          <SquareArrowOutUpRightIcon className="size-3.5" />
          Official firmware & updater
        </a>
        <p className="mt-2 text-2xs text-muted-foreground">
          The updater is a Windows app; on macOS or Linux run it in a Windows VM.
        </p>
      </PopoverPopup>
    </Popover>
  );
}
