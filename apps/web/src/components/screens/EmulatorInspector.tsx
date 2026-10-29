import { Inspector, InspectorGroup } from "~/components/shell/Inspector";
import { DevicePanel } from "~/components/emulator/DevicePanel";
import { DtcPanel } from "~/components/emulator/DtcPanel";
import { FirmwareDetails } from "~/components/emulator/Firmware";
import { Panel } from "~/components/emulator/Panel";
import { PidPanel } from "~/components/emulator/PidPanel";
import { ReadinessPanel } from "~/components/emulator/ReadinessPanel";

/** The emulator screen's right-hand inspector: everything the emulator reports, by group. */
export function EmulatorInspector({ className }: { className?: string }) {
  return (
    <Inspector
      aria-label="Inspector"
      filterPlaceholder="Filter PIDs and settings"
      className={className}
    >
      <Panel.Embedded value>
        <InspectorGroup id="vehicle" title="Vehicle" keywords="ignition protocol vin">
          <DevicePanel />
        </InspectorGroup>
        <InspectorGroup
          id="diagnostics"
          title="Diagnostics"
          keywords="trouble codes dtc check engine mil"
        >
          <DtcPanel />
        </InspectorGroup>
        <InspectorGroup id="readiness" title="Readiness" keywords="monitors">
          <ReadinessPanel />
        </InspectorGroup>
        <InspectorGroup id="live-data" title="Live data" keywords="pid mode 01 sensors">
          <PidPanel />
        </InspectorGroup>
        <InspectorGroup
          id="firmware"
          title="Firmware"
          keywords="version update"
          defaultOpen={false}
        >
          <FirmwareDetails />
        </InspectorGroup>
      </Panel.Embedded>
    </Inspector>
  );
}
