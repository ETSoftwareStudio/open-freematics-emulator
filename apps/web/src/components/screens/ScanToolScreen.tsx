import { ConsolePanel } from "~/components/emulator/ConsolePanel";
import { Panel } from "~/components/emulator/Panel";
import { PidPanel } from "~/components/emulator/PidPanel";
import { ScanToolPanel } from "~/components/emulator/ScanToolPanel";
import { Drawer } from "~/components/shell/Drawer";
import { Inspector, InspectorGroup } from "~/components/shell/Inspector";
import { cn } from "~/lib/utils";

/** Slot for the scan tool's left sidebar: the adapter and what it read. */
export function ScanToolSidebar({ className }: { className?: string }) {
  return (
    <Inspector side="start" aria-label="Adapter" className={className}>
      <Panel.Embedded value>
        <InspectorGroup id="scan-adapter" title="Adapter">
          <ScanToolPanel />
        </InspectorGroup>
      </Panel.Embedded>
    </Inspector>
  );
}

/** Slot for the scan tool's main area: what the emulator sets next to what the adapter reads. */
export function ScanToolMain() {
  return (
    <div data-slot="scan-main" className="min-h-0 flex-1 overflow-auto bg-pane p-3">
      <PidPanel />
    </div>
  );
}

export function ScanToolScreen({
  sidebarOpen,
  sidebarOverlay,
  trafficOpen,
  onTrafficOpenChange,
}: {
  sidebarOpen: boolean;
  sidebarOverlay: boolean;
  trafficOpen: boolean;
  onTrafficOpenChange: (open: boolean) => void;
}) {
  return (
    <div className="relative flex min-h-0 flex-1">
      {sidebarOpen ? (
        <ScanToolSidebar
          className={cn(
            "w-75 shrink-0",
            sidebarOverlay && "absolute inset-y-0 start-0 z-20 shadow-2xl",
          )}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScanToolMain />
        {trafficOpen ? (
          <Drawer storageKey="traffic" defaultHeight={244} aria-label="Traffic log">
            <ConsolePanel
              title="Traffic"
              description="What the scan tool asked and what the emulator answered"
              onHide={() => onTrafficOpenChange(false)}
            />
          </Drawer>
        ) : null}
      </div>
    </div>
  );
}
