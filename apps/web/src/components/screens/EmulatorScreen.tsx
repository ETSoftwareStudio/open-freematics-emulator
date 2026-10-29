import { ClusterPanel } from "~/components/cluster/ClusterPanel";
import { ConsolePanel } from "~/components/emulator/ConsolePanel";
import { Drawer } from "~/components/shell/Drawer";
import { cn } from "~/lib/utils";
import { EmulatorInspector } from "./EmulatorInspector";
import { ScenarioStrip } from "./ScenarioStrip";

/** The cluster and presets in the main column, the console below, the inspector on the right. */
export function EmulatorScreen({
  consoleOpen,
  onConsoleOpenChange,
  inspectorOpen,
  inspectorOverlay,
}: {
  consoleOpen: boolean;
  onConsoleOpenChange: (open: boolean) => void;
  inspectorOpen: boolean;
  /** Narrow windows float the inspector over the cluster instead of beside it. */
  inspectorOverlay: boolean;
}) {
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div data-slot="cluster" className="min-h-0 flex-1 overflow-auto bg-gauge-face">
          <ClusterPanel className="min-h-full rounded-none border-0" />
        </div>
        <ScenarioStrip />
        {consoleOpen ? (
          <Drawer storageKey="console" aria-label="Console">
            <ConsolePanel onHide={() => onConsoleOpenChange(false)} />
          </Drawer>
        ) : null}
      </div>
      {inspectorOpen ? (
        <EmulatorInspector
          className={cn(
            "w-82.5 shrink-0",
            inspectorOverlay && "absolute inset-y-0 end-0 z-20 shadow-2xl",
          )}
        />
      ) : null}
    </div>
  );
}
