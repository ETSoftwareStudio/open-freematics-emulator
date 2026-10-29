import type { PidId } from "@fme/contracts";
import { useEffect, useState } from "react";
import { ConsolePanel } from "~/components/emulator/ConsolePanel";
import { AdapterGroup } from "~/components/scantool/AdapterGroup";
import {
  ReadinessGroup,
  TroubleCodesGroup,
  VehicleInfoGroup,
} from "~/components/scantool/DiagnosticGroups";
import { ReadbackPane } from "~/components/scantool/ReadbackPane";
import { trafficMentionsPid } from "~/components/scantool/readback";
import { Drawer } from "~/components/shell/Drawer";
import { Inspector } from "~/components/shell/Inspector";
import { cn } from "~/lib/utils";
import { usePersistentState } from "~/lib/usePersistentState";
import { readerWatchAtom } from "~/rpc/atoms";
import { useCommand, useReaderState } from "~/rpc/hooks";

const DEFAULT_WATCH = [
  "010C",
  "010D",
  "0105",
  "012F",
  "0111",
  "0104",
  "0142",
  "0146",
  "010F",
  "0110",
  "010B",
  "015C",
  "010A",
  "0133",
].join(",");

const parseWatch = (stored: string) =>
  stored.split(",").filter((pid): pid is PidId => /^01[0-9A-F]{2}$/.test(pid));

/** The scan tool's left sidebar: the adapter and the codes, readiness and VIN it read. */
export function ScanToolSidebar({ className }: { className?: string }) {
  const reader = useReaderState();
  return (
    <Inspector side="start" aria-label="Adapter" className={className}>
      {reader !== null ? (
        <>
          <AdapterGroup reader={reader} />
          <TroubleCodesGroup reader={reader} />
          <ReadinessGroup reader={reader} />
          <VehicleInfoGroup reader={reader} />
        </>
      ) : null}
    </Inspector>
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
  const reader = useReaderState();
  const watch = useCommand(readerWatchAtom);
  const [stored, setStored] = usePersistentState("fme:scan:watching", DEFAULT_WATCH);
  const [selected, setSelected] = useState<PidId | null>(null);
  const watching = parseWatch(stored);
  const readerReady = reader !== null;
  const watchingShown = reader !== null && reader.watching.join() === watching.join();

  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- tells the server which PIDs to poll; the Emulator screen may have changed them
  useEffect(() => {
    if (readerReady && !watchingShown) void watch({ pids: watching });
  }, [readerReady, watchingShown, watching, watch]);

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
        <ReadbackPane
          reader={reader}
          watching={watching}
          onWatchingChange={(pids) => {
            setStored(pids.join(","));
            if (selected !== null && !pids.includes(selected)) setSelected(null);
          }}
          selected={selected}
          onSelectedChange={setSelected}
        />
        {trafficOpen ? (
          <Drawer storageKey="traffic" defaultHeight={240} aria-label="Traffic log">
            <ConsolePanel
              title="Traffic"
              description={
                selected === null
                  ? "Polls stay out of the log; Read Once logs every request"
                  : `Lines for ${selected} are highlighted`
              }
              highlight={(entry) => selected !== null && trafficMentionsPid(entry, selected)}
              onHide={() => onTrafficOpenChange(false)}
            />
          </Drawer>
        ) : null}
      </div>
    </div>
  );
}
