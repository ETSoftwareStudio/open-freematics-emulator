import { LATEST_OFFICIAL_FIRMWARE } from "@fme/shared/firmware";
import { useFirmware } from "~/components/emulator/Firmware";
import { InspectorGroup } from "~/components/shell/Inspector";
import { PropertyRow } from "~/components/shell/PropertyRow";

/** What the connected emulator reports about its firmware; the update notice is an infobar. */
export function FirmwareGroup() {
  const firmware = useFirmware();
  const { info } = firmware;
  const version = info.version !== null ? `V${info.version}` : null;
  const status = firmware.simulated
    ? { text: "Simulated", className: "text-muted-foreground" }
    : firmware.updatable
      ? {
          text: `V${LATEST_OFFICIAL_FIRMWARE.version} available`,
          className: "text-warning-foreground",
        }
      : version !== null
        ? { text: "Up to date", className: "text-success-foreground" }
        : { text: "Unknown", className: "text-muted-foreground" };

  return (
    <InspectorGroup
      id="firmware"
      title="Firmware"
      keywords="version status update built serial"
      defaultOpen={false}
      summary={firmware.connected ? (version ?? undefined) : undefined}
    >
      {firmware.connected ? (
        <>
          <PropertyRow label="Version">{version ?? firmware.banner ?? "Unknown"}</PropertyRow>
          <PropertyRow label="Status">
            <span className={status.className}>{status.text}</span>
          </PropertyRow>
          {info.buildLabel !== null ? (
            <PropertyRow label="Built">{info.buildLabel}</PropertyRow>
          ) : null}
          {info.serial !== null ? (
            <PropertyRow label="Serial">
              <code className="font-mono">{info.serial}</code>
            </PropertyRow>
          ) : null}
        </>
      ) : (
        <p className="py-1.5 text-subtle-foreground">Connect to read the firmware version.</p>
      )}
    </InspectorGroup>
  );
}
