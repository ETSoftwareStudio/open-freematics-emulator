import { LATEST_OFFICIAL_FIRMWARE } from "@fme/shared/firmware";
import { useFirmware } from "~/components/emulator/Firmware";
import { UpdateFirmwareButton } from "~/components/firmware/UpdateFirmwareDialog";
import { InspectorGroup } from "~/components/shell/Inspector";
import { PropertyRow } from "~/components/shell/PropertyRow";

/** What the connected emulator reports about its firmware; the update notice is an infobar. */
export function FirmwareGroup() {
  const firmware = useFirmware();
  const { info } = firmware;
  const version = info.version !== null ? `V${info.version}` : null;
  const latest = `V${LATEST_OFFICIAL_FIRMWARE.version}`;
  const status = firmware.simulated
    ? { text: "Simulated", className: "text-muted-foreground" }
    : {
        available: { text: `${latest} available`, className: "text-warning-foreground" },
        current: { text: "Up to date", className: "text-success-foreground" },
        "too-old": {
          text: `${latest} not advised`,
          className: "text-muted-foreground",
          title: "Freematics advises against updating units made before 2018.",
        },
        "unknown-age": {
          text: `${latest} exists`,
          className: "text-muted-foreground",
          title:
            "Not suggested: this unit's age can't be read, and Freematics advises against updating units made before 2018.",
        },
        unknown: { text: "Unknown", className: "text-muted-foreground" },
      }[firmware.update];

  return (
    <InspectorGroup
      id="firmware"
      title="Firmware"
      keywords="version status update built made serial"
      defaultOpen={false}
      summary={firmware.connected ? (version ?? undefined) : undefined}
    >
      {firmware.connected ? (
        <>
          <PropertyRow label="Version">{version ?? firmware.banner ?? "Unknown"}</PropertyRow>
          <PropertyRow label="Status">
            <span className={status.className} title={"title" in status ? status.title : undefined}>
              {status.text}
            </span>
          </PropertyRow>
          {info.buildLabel !== null ? (
            <PropertyRow label="Built">{info.buildLabel}</PropertyRow>
          ) : null}
          {firmware.made !== null ? <PropertyRow label="Made">{firmware.made}</PropertyRow> : null}
          {info.serial !== null ? (
            <PropertyRow label="Serial">
              <code className="font-mono">{info.serial}</code>
            </PropertyRow>
          ) : null}
        </>
      ) : (
        <p className="py-1.5 text-subtle-foreground">Connect to read the firmware version.</p>
      )}
      <PropertyRow label="Update">
        <UpdateFirmwareButton />
      </PropertyRow>
    </InspectorGroup>
  );
}
