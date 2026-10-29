import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { PaneActions, PaneHeader, PaneMeta, PaneTitle } from "~/components/shell/Pane";
import { SegmentedControl } from "~/components/shell/SegmentedControl";
import { ToolbarSeparator } from "~/components/shell/Toolbar";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { sendRawAtom, trafficAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { cn } from "~/lib/utils";

const CHANNELS = [
  { value: "all", label: "All" },
  { value: "emulator", label: "Emulator" },
  { value: "reader", label: "Scan tool" },
] as const;
type ChannelFilter = (typeof CHANNELS)[number]["value"];

const QUICK_COMMANDS = ["ATGET VIN", "ATGET 010C", "ATGET 0101", "ATGET 0100"];

const formatTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false }) +
  `.${String(at % 1000).padStart(3, "0")}`;

/** The serial traffic log with a prompt for raw AT commands, for a bottom drawer. */
export function ConsolePanel({
  title = "Console",
  description = "AT commands to the MK2 and what the scan tool reads",
  onHide,
}: {
  title?: string;
  description?: string;
  onHide?: () => void;
}) {
  const { state } = useEmulatorState();
  const trafficResult = useAtomValue(trafficAtom);
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [follow, setFollow] = useState(true);
  const [clearedThrough, setClearedThrough] = useState(0);
  const allTraffic = AsyncResult.isSuccess(trafficResult) ? trafficResult.value : [];
  // A restarted server numbers entries from 1 again, so a stale mark would hide everything.
  const newest = allTraffic.at(-1)?.sequence ?? 0;
  const since = newest >= clearedThrough ? clearedThrough : 0;
  const traffic = allTraffic.filter(
    (entry) => entry.sequence > since && (channel === "all" || entry.channel === channel),
  );
  const sendRaw = useCommand(sendRawAtom);
  const [command, setCommand] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const quickListId = useId();
  const connected = state?.connection._tag === "connected";
  const lastSequence = traffic.at(-1)?.sequence;

  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- keeps the log scrolled to the newest line as traffic arrives
  useEffect(() => {
    const log = logRef.current;
    if (follow && log !== null && lastSequence !== undefined) log.scrollTop = log.scrollHeight;
  }, [follow, lastSequence]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (await sendRaw({ command: trimmed })) setCommand("");
  };

  return (
    <>
      <PaneHeader>
        <PaneTitle>{title}</PaneTitle>
        <SegmentedControl
          items={CHANNELS}
          value={channel}
          onValueChange={setChannel}
          aria-label="Traffic filter"
          className="ms-1"
        />
        <PaneMeta className="max-desktop:hidden">{description}</PaneMeta>
        <PaneActions>
          <label className="flex cursor-default items-center gap-1.5 pe-1 text-foreground">
            <Checkbox checked={follow} onCheckedChange={setFollow} />
            Follow
          </label>
          <ToolbarSeparator />
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Clear the log"
            title="Clear"
            onClick={() => setClearedThrough(newest)}
          >
            <Trash2Icon />
          </Button>
          {onHide !== undefined ? (
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={`Hide the ${title.toLowerCase()}`}
              title="Hide"
              onClick={onHide}
            >
              <ChevronDownIcon />
            </Button>
          ) : null}
        </PaneActions>
      </PaneHeader>
      <div
        ref={logRef}
        className="min-h-0 flex-1 select-text overflow-y-auto py-1 font-mono text-[11.5px]"
        role="log"
        aria-label="Serial traffic"
      >
        {traffic.length === 0 ? (
          <p className="px-3 py-1 font-sans text-muted-foreground text-xs">
            {connected ? "No traffic yet." : "No traffic yet. Connect to see the AT exchange."}
          </p>
        ) : null}
        {traffic.map((entry) => (
          <div key={entry.sequence} className="flex gap-3 px-3 leading-[19px]">
            <span className="shrink-0 text-muted-foreground">{formatTime(entry.at)}</span>
            <span
              className={cn(
                "w-14 shrink-0 font-sans font-semibold text-2xs leading-[19px]",
                entry.channel === "reader" ? "text-warning-foreground" : "text-muted-foreground",
              )}
            >
              {entry.channel === "reader" ? "Scan tool" : "Emulator"}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {entry.direction === "tx" ? ">" : "<"}
            </span>
            <span
              className={cn(
                "break-all",
                entry.direction === "tx" ? "text-foreground" : "text-muted-foreground",
                entry.direction === "rx" && entry.text.includes("ERROR") && "text-error-foreground",
              )}
            >
              {entry.text}
            </span>
          </div>
        ))}
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          void send(command);
        }}
      >
        <Input
          size="sm"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={
            connected ? "Type an AT command, e.g. ATGET VIN" : "Connect to send commands"
          }
          disabled={!connected}
          className="font-mono"
          aria-label="AT command"
          list={quickListId}
        />
        <datalist id={quickListId}>
          {QUICK_COMMANDS.map((quick) => (
            <option key={quick} value={quick} />
          ))}
        </datalist>
        <Button
          type="submit"
          size="xs"
          variant="outline"
          disabled={!connected || !/^AT/i.test(command.trim())}
        >
          Send
        </Button>
      </form>
    </>
  );
}
