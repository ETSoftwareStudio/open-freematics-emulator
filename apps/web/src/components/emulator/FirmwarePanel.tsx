import {
  LATEST_OFFICIAL_FIRMWARE,
  firmwareUpdateAvailable,
  parseFirmwareInfo,
} from "@fme/shared/firmware";
import { CircleCheckIcon, CpuIcon, MonitorDownIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { useEmulatorState } from "~/rpc/hooks";
import { Panel } from "./Panel";

const STEPS = [
  "Download the official Freematics Emulator GUI below — it bundles the firmware and the vendor's updater.",
  "Keep the emulator on USB with 12 V power connected.",
  "In the GUI, click “Update Firmware” and pick this emulator's serial port.",
  "When it finishes, power-cycle the emulator before reconnecting here.",
];

function UpdateInstructions() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="sm" variant="outline">
            <MonitorDownIcon />
            Update firmware…
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-80" width="auto">
        <PopoverTitle className="font-medium text-sm">
          Update to V{LATEST_OFFICIAL_FIRMWARE.version}
        </PopoverTitle>
        <p className="mt-1 text-muted-foreground text-xs">
          Flashing is done by Freematics' own updater — this app never writes to the device, so
          there's no risk of a bad flash from here.
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

export function FirmwarePanel() {
  const { state } = useEmulatorState();
  if (state === null) return null;
  const { connection } = state;

  const device = connection._tag === "connected" ? connection.device : null;
  const simulated = connection._tag === "connected" && connection.target._tag === "simulated";
  const info = parseFirmwareInfo(device?.banner ?? null, device?.details ?? null);
  const updatable = !simulated && firmwareUpdateAvailable(info);

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.Title>Firmware</Panel.Title>
        {connection._tag === "connected" && !simulated ? (
          updatable ? (
            <Badge variant="info">Update available</Badge>
          ) : info.version !== null ? (
            <Badge variant="success">
              <CircleCheckIcon />
              Up to date
            </Badge>
          ) : null
        ) : null}
      </Panel.Header>
      <Panel.Body className="flex flex-col gap-3">
        {connection._tag !== "connected" ? (
          <p className="text-muted-foreground text-sm">Connect to read the firmware version.</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <CpuIcon className="size-8 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-medium text-sm">
                  {info.version !== null
                    ? `Version ${info.version}`
                    : (device?.banner ?? "Unknown")}
                  {simulated ? " · simulated" : ""}
                </p>
                <p className="text-muted-foreground text-xs">
                  {[info.buildLabel && `Built ${info.buildLabel}`, info.serial]
                    .filter(Boolean)
                    .join(" · ") || "No build details reported."}
                </p>
              </div>
            </div>

            {updatable ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-info/8 px-3 py-2 dark:bg-info/16">
                <p className="text-xs">
                  Official firmware{" "}
                  <span className="font-medium">
                    V{LATEST_OFFICIAL_FIRMWARE.version} ({LATEST_OFFICIAL_FIRMWARE.buildLabel})
                  </span>{" "}
                  adds pending/permanent codes and CALID.
                </p>
                <UpdateInstructions />
              </div>
            ) : simulated ? (
              <p className="text-muted-foreground text-xs">
                The simulated device models a V1.2 unit; connect real hardware to check for updates.
              </p>
            ) : null}
          </>
        )}
      </Panel.Body>
    </Panel.Root>
  );
}
