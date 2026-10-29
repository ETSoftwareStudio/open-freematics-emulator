import { DiagnosticsGroup } from "~/components/inspector/DiagnosticsGroup";
import { FirmwareGroup } from "~/components/inspector/FirmwareGroup";
import { PidGroups } from "~/components/inspector/PidGroups";
import { ReadinessGroup } from "~/components/inspector/ReadinessGroup";
import { VehicleGroup } from "~/components/inspector/VehicleGroup";
import { Inspector } from "~/components/shell/Inspector";

/** The emulator screen's right-hand inspector: every setting the emulator answers with, by group. */
export function EmulatorInspector({ className }: { className?: string }) {
  return (
    <Inspector
      aria-label="Inspector"
      filterPlaceholder="Filter PIDs and settings"
      className={className}
    >
      <VehicleGroup />
      <DiagnosticsGroup />
      <ReadinessGroup />
      <PidGroups />
      <FirmwareGroup />
    </Inspector>
  );
}
