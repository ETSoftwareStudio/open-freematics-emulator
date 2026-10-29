import type { PidId } from "@fme/contracts";
import { PIDS } from "@fme/shared/pids";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

const PID_PATTERN = /^01[0-9A-F]{2}$/;

/** Picks the PIDs the scan tool polls: catalog PIDs by name, or any Mode 01 PID by code. */
export function AddPidPopover({
  watching,
  onWatchingChange,
}: {
  watching: ReadonlyArray<PidId>;
  onWatchingChange: (pids: ReadonlyArray<PidId>) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const code = query.trim().toUpperCase();
  const entries = [
    ...PIDS.map(({ id, name }) => ({ id, name })),
    ...watching
      .filter((id) => !PIDS.some((pid) => pid.id === id))
      .map((id) => ({ id, name: "Not in the catalog" })),
  ];
  const matching = entries.filter(
    (pid) =>
      needle === "" ||
      pid.id.toLowerCase().includes(needle) ||
      pid.name.toLowerCase().includes(needle),
  );
  const custom =
    PID_PATTERN.test(code) &&
    !PIDS.some((pid) => pid.id === code) &&
    !watching.includes(code as PidId)
      ? (code as PidId)
      : null;
  const toggle = (pid: PidId, on: boolean) =>
    onWatchingChange(on ? [...watching, pid] : watching.filter((id) => id !== pid));

  return (
    <Popover onOpenChange={(open) => (open ? undefined : setQuery(""))}>
      <PopoverTrigger render={<Button variant="outline" size="xs" />}>
        <PlusIcon />
        Add PID…
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-76" width="auto">
        <Input
          type="search"
          size="sm"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or Mode 01 code, e.g. 0151"
          aria-label="Find a PID"
          autoFocus
        />
        <ul className="-mx-1 mt-1.5 max-h-72 overflow-y-auto text-xs" aria-label="PIDs">
          {custom !== null ? (
            <li>
              <Button
                variant="ghost"
                size="xs"
                className="w-full justify-start"
                onClick={() => {
                  toggle(custom, true);
                  setQuery("");
                }}
              >
                <PlusIcon />
                Watch <code className="font-mono">{custom}</code> (not in the catalog)
              </Button>
            </li>
          ) : null}
          {matching.map((pid) => (
            <li key={pid.id}>
              <label className="flex h-6.5 cursor-default items-center gap-2 rounded-sm px-1 hover:bg-accent">
                <Checkbox
                  checked={watching.includes(pid.id)}
                  onCheckedChange={(checked) => toggle(pid.id, checked)}
                />
                <code className="w-9 shrink-0 font-mono text-2xs text-muted-foreground">
                  {pid.id}
                </code>
                <span className="truncate">{pid.name}</span>
              </label>
            </li>
          ))}
          {matching.length === 0 && custom === null ? (
            <li className="px-1 py-1 text-muted-foreground">No PID matches.</li>
          ) : null}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
