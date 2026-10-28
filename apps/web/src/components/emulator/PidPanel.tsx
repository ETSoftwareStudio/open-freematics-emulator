import type { PidReading } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import { PID_GROUPS, PIDS, type PidDefinition, type PidGroup } from "@fme/shared/pids";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "~/components/ui/number-field";
import { Slider } from "~/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { readerWatchAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState, useReaderState } from "~/rpc/hooks";
import { CLUSTER_PIDS } from "~/components/cluster/ClusterPanel";
import { Panel } from "./Panel";
import { formatPidValue, readingMatches, usePidControl } from "./pidControl";

/** What the scan tool read for this PID, and whether it matches what the emulator was told. */
function Readback({
  definition,
  value,
  reading,
}: {
  definition: PidDefinition;
  value: number;
  reading: PidReading;
}) {
  const matches = readingMatches(definition, value, reading);
  return (
    <span
      className={`flex items-center gap-1 text-2xs ${matches ? "text-success-foreground" : "text-warning-foreground"}`}
      title={`Scan tool read ${formatHexBytes(reading.raw)}`}
    >
      {matches ? <CheckIcon className="size-3" /> : <TriangleAlertIcon className="size-3" />}
      read {formatPidValue(definition, reading.value)} {definition.unit}
    </span>
  );
}

function PidRow({
  definition,
  value,
  reading,
}: {
  definition: PidDefinition;
  value: number;
  reading: PidReading | undefined;
}) {
  const { shown, dragging, change, commit } = usePidControl(definition, value);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-x-4 gap-y-1.5 py-2.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_7.5rem_5.5rem]">
      <div className="min-w-0">
        <p className="truncate text-sm">{definition.name}</p>
        <div className="flex flex-wrap items-center gap-x-3">
          <p className="font-mono text-2xs text-muted-foreground">
            {definition.id} · {formatHexBytes(definition.encode(shown))}
          </p>
          {reading !== undefined && !dragging ? (
            <Readback definition={definition} value={value} reading={reading} />
          ) : null}
        </div>
      </div>
      <Slider
        className="order-last col-span-2 sm:order-none sm:col-span-1"
        aria-label={definition.name}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={shown}
        onValueChange={change}
        onValueCommitted={(next) => void commit(next)}
      />
      <NumberField
        value={shown}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        size="sm"
        onValueCommitted={(next) => {
          if (next !== null) void commit(next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldInput
            className="text-right font-mono"
            aria-label={`${definition.name} value`}
          />
        </NumberFieldGroup>
      </NumberField>
      <span className="hidden text-muted-foreground text-xs sm:inline">{definition.unit}</span>
    </div>
  );
}

export function PidPanel() {
  const { state } = useEmulatorState();
  const reader = useReaderState();
  const watch = useCommand(readerWatchAtom);
  const [group, setGroup] = useState<PidGroup>("Engine");
  const readerConnected = reader?.connection._tag === "connected";

  // The cluster's PIDs first, then the visible group's: everything on screen gets read back.
  const visiblePids = [
    ...new Set([...CLUSTER_PIDS, ...PIDS.filter((p) => p.group === group).map((p) => p.id)]),
  ];
  const watchingVisible = reader !== null && reader.watching.join() === visiblePids.join();

  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- tells the server which PIDs the scan tool should poll for what is on screen
  useEffect(() => {
    if (readerConnected && !watchingVisible) void watch({ pids: visiblePids });
  }, [readerConnected, watchingVisible, visiblePids, watch]);

  if (state === null) return null;

  return (
    <Panel.Root>
      <Panel.Header className="flex-wrap">
        <Panel.Title>Live data (Mode 01)</Panel.Title>
        <Panel.Actions className="max-w-full overflow-x-auto">
          <ToggleGroup
            value={[group]}
            onValueChange={(next) => {
              const picked = PID_GROUPS.find((candidate) => candidate === next[0]);
              if (picked !== undefined) setGroup(picked);
            }}
            aria-label="PID group"
          >
            {PID_GROUPS.map((name) => (
              <ToggleGroupItem key={name} value={name} size="sm">
                {name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Panel.Actions>
      </Panel.Header>
      <Panel.Body className="divide-y py-1">
        {PIDS.filter((definition) => definition.group === group).map((definition) => (
          <PidRow
            key={definition.id}
            definition={definition}
            value={state.pids[definition.id] ?? definition.defaultValue}
            reading={readerConnected ? reader?.readings[definition.id] : undefined}
          />
        ))}
      </Panel.Body>
    </Panel.Root>
  );
}
