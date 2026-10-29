import type { PidId, PollInterval, ReaderState } from "@fme/contracts";
import { formatHexBytes } from "@fme/shared/atCommands";
import { ArrowDownIcon, ArrowUpIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useRef, useState } from "react";
import type * as React from "react";
import { Pane, PaneActions, PaneBody, PaneMeta, PaneToolbar } from "~/components/shell/Pane";
import { ToolbarSeparator } from "~/components/shell/Toolbar";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { readerReadOnceAtom, readerSetPollingAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { cn } from "~/lib/utils";
import { AddPidPopover } from "./AddPidPopover";
import { ResultLabel, useNow, useStaleMarks } from "./parts";
import {
  buildRows,
  formatAge,
  formatValue,
  sortRows,
  type ReadbackRow,
  type Sort,
  type SortKey,
} from "./readback";

const INTERVALS: ReadonlyArray<{ value: PollInterval; label: string }> = [
  { value: 250, label: "250 ms" },
  { value: 500, label: "500 ms" },
  { value: 1000, label: "1 s" },
  { value: 2000, label: "2 s" },
];

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; className: string }> = [
  { key: "pid", label: "PID", className: "w-[62px]" },
  { key: "name", label: "Name", className: "" },
  { key: "set", label: "Emulator set", className: "w-[110px] text-end" },
  { key: "read", label: "Scan tool reads", className: "w-[120px] text-end" },
  { key: "result", label: "Result", className: "w-[150px]" },
  { key: "age", label: "Age", className: "w-[64px] text-end" },
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Value({ value, row, read }: { value: number; row: ReadbackRow; read?: boolean }) {
  return (
    <>
      {formatValue(value, row.definition, read)}
      {row.unit !== "" ? (
        <small className="ms-0.75 text-2xs text-muted-foreground">{row.unit}</small>
      ) : null}
    </>
  );
}

function ReadCell({ row }: { row: ReadbackRow }) {
  if (row.result === "no-answer") return <span className="text-muted-foreground">NO DATA</span>;
  if (row.reading === undefined) return <span className="text-muted-foreground">—</span>;
  if (row.definition === undefined) {
    return <code className="font-mono text-2xs">{formatHexBytes(row.reading.raw)}</code>;
  }
  return <Value value={row.reading.value} row={row} read />;
}

function SortHeader({
  column,
  sort,
  onSortChange,
}: {
  column: (typeof COLUMNS)[number];
  sort: Sort | null;
  onSortChange: (sort: Sort | null) => void;
}) {
  const active = sort?.key === column.key ? sort.direction : null;
  const Arrow = active === "desc" ? ArrowDownIcon : ArrowUpIcon;
  return (
    <th
      scope="col"
      aria-sort={active === null ? "none" : active === "asc" ? "ascending" : "descending"}
      className={cn(
        "sticky top-0 z-1 h-6 border-separator text-start border-b bg-pane px-2.5 font-medium text-2xs text-muted-foreground",
        column.className,
      )}
    >
      <button
        type="button"
        className={cn(
          "inline-flex cursor-default items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          active !== null && "text-foreground",
        )}
        onClick={() =>
          onSortChange(
            active === null
              ? { key: column.key, direction: "asc" }
              : active === "asc"
                ? { key: column.key, direction: "desc" }
                : null,
          )
        }
      >
        {column.label}
        {active !== null ? <Arrow className="size-2.5" aria-hidden /> : null}
      </button>
    </th>
  );
}

export function ReadbackPane({
  reader,
  watching,
  onWatchingChange,
  selected,
  onSelectedChange,
}: {
  reader: ReaderState | null;
  watching: ReadonlyArray<PidId>;
  onWatchingChange: (pids: ReadonlyArray<PidId>) => void;
  selected: PidId | null;
  onSelectedChange: (pid: PidId | null) => void;
}) {
  const { state: emulator } = useEmulatorState();
  const setPolling = useCommand(readerSetPollingAtom);
  const readOnce = useCommand(readerReadOnceAtom);
  const [sort, setSort] = useState<Sort | null>(null);
  const [mismatchesOnly, setMismatchesOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const now = useNow(250);
  const staleThrough = useStaleMarks(emulator?.pids, reader?.readings);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const connected = reader?.connection._tag === "connected";
  const polling = reader?.polling ?? { paused: false, interval: 500 };
  const rows = buildRows(watching, emulator, reader, staleThrough);
  const mismatches = rows.filter((row) => row.result === "mismatch").length;
  const needle = filter.trim().toLowerCase();
  const shown = sortRows(
    rows.filter(
      (row) =>
        (!mismatchesOnly || row.result === "mismatch") &&
        (needle === "" ||
          row.pid.toLowerCase().includes(needle) ||
          row.name.toLowerCase().includes(needle)),
    ),
    sort,
    now,
  );
  const intervalLabel = INTERVALS.find((i) => i.value === polling.interval)?.label ?? "";

  const summary = [
    plural(watching.length, "PID"),
    !connected
      ? "adapter not connected"
      : polling.paused
        ? "polling paused"
        : `${reader.pollRate} requests/s`,
    ...(connected ? [`${mismatches} ${mismatches === 1 ? "mismatch" : "mismatches"}`] : []),
  ].join(" · ");

  const moveSelection = (event: React.KeyboardEvent, index: number) => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : null;
    if (next === null || next < 0 || next >= shown.length) return;
    event.preventDefault();
    onSelectedChange(shown[next]!.pid);
    bodyRef.current?.querySelectorAll("tr")[next]?.focus();
  };

  return (
    <Pane aria-label="Live readback" className="flex-1">
      <PaneToolbar className="gap-1.5 ps-2">
        <Button
          variant="outline"
          size="xs"
          aria-pressed={polling.paused}
          disabled={reader === null}
          onClick={() => void setPolling({ ...polling, paused: !polling.paused })}
        >
          {polling.paused ? <PlayIcon /> : <PauseIcon />}
          {polling.paused ? "Resume Polling" : "Pause Polling"}
        </Button>
        <Select
          value={polling.interval}
          onValueChange={(value) => {
            const picked = INTERVALS.find((i) => i.value === value);
            if (picked !== undefined) void setPolling({ ...polling, interval: picked.value });
          }}
          disabled={reader === null}
        >
          <SelectTrigger size="xs" className="w-auto min-w-0" aria-label="Poll interval">
            <SelectValue>Every {intervalLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {INTERVALS.map((interval) => (
              <SelectItem key={interval.value} value={interval.value}>
                Every {interval.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          variant="outline"
          size="xs"
          disabled={!connected}
          title="Read every watched PID once and log each exchange in the traffic pane"
          onClick={() => void readOnce(undefined)}
        >
          Read Once
        </Button>
        <ToolbarSeparator />
        <PaneMeta className="tabular-nums">{summary}</PaneMeta>
        <PaneActions className="gap-1.5">
          <label className="flex cursor-default items-center gap-1.5 whitespace-nowrap pe-1 text-foreground text-xs">
            <Checkbox checked={mismatchesOnly} onCheckedChange={setMismatchesOnly} />
            Mismatches only
          </label>
          <Input
            type="search"
            size="sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter"
            aria-label="Filter PIDs"
            className="w-37.5 max-desktop:w-28"
          />
          <AddPidPopover watching={watching} onWatchingChange={onWatchingChange} />
        </PaneActions>
      </PaneToolbar>
      <PaneBody>
        <table className="w-full table-fixed border-collapse text-start text-xs tabular-nums">
          <thead>
            <tr className="text-start">
              {COLUMNS.map((column) => (
                <SortHeader key={column.key} column={column} sort={sort} onSortChange={setSort} />
              ))}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {shown.map((row, index) => {
              const isSelected = row.pid === selected;
              const mismatch = row.result === "mismatch";
              return (
                <tr
                  key={row.pid}
                  aria-selected={isSelected}
                  tabIndex={isSelected || (selected === null && index === 0) ? 0 : -1}
                  onClick={() => onSelectedChange(isSelected ? null : row.pid)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectedChange(isSelected ? null : row.pid);
                    } else moveSelection(event, index);
                  }}
                  className={cn(
                    "h-6.25 cursor-default border-separator/60 border-b outline-none even:bg-foreground/[0.025] focus-visible:shadow-[inset_0_0_0_2px_var(--color-ring)] *:whitespace-nowrap *:px-2.5",
                    mismatch && "bg-error-surface even:bg-error-surface",
                    isSelected && "bg-row-selected even:bg-row-selected",
                  )}
                >
                  <td>
                    <code className="font-mono text-2xs text-muted-foreground">{row.pid}</code>
                  </td>
                  <td
                    className={cn(
                      "truncate",
                      isSelected ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {row.name}
                  </td>
                  <td className="text-end">
                    {row.set === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Value value={row.set} row={row} />
                    )}
                  </td>
                  <td className={cn("text-end", mismatch && "text-error-foreground")}>
                    <ReadCell row={row} />
                  </td>
                  <td>
                    <ResultLabel result={row.result} />
                  </td>
                  <td className="text-end text-2xs text-muted-foreground">
                    {row.reading === undefined || row.result === "offline"
                      ? "—"
                      : formatAge(now - row.reading.at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-muted-foreground text-xs">
            {watching.length === 0
              ? "No PIDs are watched. Add PID… picks what the scan tool polls."
              : mismatchesOnly && needle === ""
                ? "No mismatches: the scan tool reads what the emulator serves."
                : "No watched PID matches the filter."}
          </p>
        ) : null}
      </PaneBody>
    </Pane>
  );
}
