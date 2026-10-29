import type { ReadinessMonitorId } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import {
  READINESS_MONITOR_IDS,
  READINESS_MONITORS,
  encodeMonitorStatus,
} from "@fme/shared/readiness";
import { InspectorGroup, useInspectorFilter } from "~/components/shell/Inspector";
import { PropertyRow } from "~/components/shell/PropertyRow";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { setReadinessAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import {
  filterGroupRows,
  monitorFromStatus,
  monitorStatus,
  readinessProgress,
  type MonitorStatus,
} from "./model";

const STATUSES: ReadonlyArray<{ value: MonitorStatus; label: string; className: string }> = [
  { value: "complete", label: "Complete", className: "text-success-foreground" },
  { value: "incomplete", label: "Incomplete", className: "text-warning-foreground" },
  { value: "unsupported", label: "Not supported", className: "text-subtle-foreground" },
];

export function ReadinessGroup() {
  const { state } = useEmulatorState();
  const filter = useInspectorFilter();
  const setReadiness = useCommand(setReadinessAtom);
  if (state === null) return null;

  const { rows, keywords } = filterGroupRows(
    filter,
    "Readiness monitors",
    READINESS_MONITOR_IDS,
    (id) => READINESS_MONITORS[id].label,
  );
  const progress = readinessProgress(state.readiness);
  const bytes = encodeMonitorStatus(state.readiness, state.dtcs["03"].length);
  const set = (monitor: ReadinessMonitorId, value: unknown) => {
    const status = STATUSES.find((s) => s.value === value)?.value;
    if (status !== undefined) void setReadiness({ monitor, ...monitorFromStatus(status) });
  };

  return (
    <InspectorGroup
      id="readiness"
      title="Readiness"
      keywords={keywords}
      defaultOpen={false}
      summary={`${progress.complete} of ${progress.supported} complete`}
    >
      {rows.map((id) => {
        const label = READINESS_MONITORS[id].label;
        const status = STATUSES.find((s) => s.value === monitorStatus(state.readiness[id]));
        return (
          <PropertyRow key={id} label={label}>
            <div className="w-36">
              <Select value={status?.value} onValueChange={(value) => set(id, value)}>
                <SelectTrigger size="compact" aria-label={label}>
                  <SelectValue className={status?.className}>{status?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      <span className={s.className}>{s.label}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </PropertyRow>
        );
      })}
      {rows.length === READINESS_MONITOR_IDS.length ? (
        <PropertyRow label="Reported as" code="0101">
          <code className="font-mono text-2xs text-subtle-foreground">{formatHexBytes(bytes)}</code>
        </PropertyRow>
      ) : null}
    </InspectorGroup>
  );
}
