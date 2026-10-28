import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { SendHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { sendRawAtom, trafficAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { cn } from "~/lib/utils";
import { Panel } from "./Panel";

const CHANNELS = [
  { value: "all", label: "All" },
  { value: "emulator", label: "Emulator" },
  { value: "reader", label: "Adapter" },
] as const;
type ChannelFilter = (typeof CHANNELS)[number]["value"];

const QUICK_COMMANDS = ["ATGET VIN", "ATGET 010C", "ATGET 0101", "ATGET 0100"];

const formatTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false }) +
  `.${String(at % 1000).padStart(3, "0")}`;

export function ConsolePanel({ className }: { className?: string }) {
  const { state } = useEmulatorState();
  const trafficResult = useAtomValue(trafficAtom);
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const allTraffic = AsyncResult.isSuccess(trafficResult) ? trafficResult.value : [];
  const traffic =
    channel === "all" ? allTraffic : allTraffic.filter((entry) => entry.channel === channel);
  const sendRaw = useCommand(sendRawAtom);
  const [command, setCommand] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const connected = state?.connection._tag === "connected";
  const lastSequence = traffic.at(-1)?.sequence;

  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- keeps the log scrolled to the newest line as traffic arrives
  useEffect(() => {
    const log = logRef.current;
    if (log !== null && lastSequence !== undefined) log.scrollTop = log.scrollHeight;
  }, [lastSequence]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (await sendRaw({ command: trimmed })) setCommand("");
  };

  return (
    <Panel.Root className={className}>
      <Panel.Header className="flex-wrap">
        <Panel.Title>Console</Panel.Title>
        <Panel.Description>
          Every line exchanged with the emulator (EMU) and the OBD-II adapter (OBD).
        </Panel.Description>
        <Panel.Actions className="flex-wrap">
          <ToggleGroup
            value={[channel]}
            onValueChange={(next) => {
              const picked = CHANNELS.find((c) => c.value === next[0]);
              if (picked !== undefined) setChannel(picked.value);
            }}
            aria-label="Traffic filter"
          >
            {CHANNELS.map((c) => (
              <ToggleGroupItem key={c.value} value={c.value} size="sm">
                {c.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {QUICK_COMMANDS.map((quick) => (
            <Button
              key={quick}
              variant="outline"
              size="xs"
              disabled={!connected}
              onClick={() => void send(quick)}
              className="font-mono"
            >
              {quick}
            </Button>
          ))}
        </Panel.Actions>
      </Panel.Header>
      <div
        ref={logRef}
        className="h-64 overflow-y-auto bg-code px-4 py-2 font-mono text-xs"
        role="log"
        aria-label="Serial traffic"
      >
        {traffic.length === 0 ? (
          <p className="py-2 text-muted-foreground">
            No traffic yet. Connect to see the AT exchange.
          </p>
        ) : null}
        {traffic.map((entry) => (
          <div key={entry.sequence} className="flex gap-3 leading-5">
            <span className="shrink-0 text-muted-foreground">{formatTime(entry.at)}</span>
            <span
              className={cn(
                "w-7 shrink-0 text-2xs leading-5",
                entry.channel === "reader" ? "text-warning-foreground" : "text-muted-foreground",
              )}
            >
              {entry.channel === "reader" ? "OBD" : "EMU"}
            </span>
            <span
              className={cn(
                "shrink-0 font-semibold",
                entry.direction === "tx" ? "text-info-foreground" : "text-success-foreground",
              )}
            >
              {entry.direction === "tx" ? "→" : "←"}
            </span>
            <span
              className={cn(
                "break-all",
                entry.direction === "rx" && entry.text.includes("ERROR") && "text-error-foreground",
              )}
            >
              {entry.text}
            </span>
          </div>
        ))}
      </div>
      <form
        className="flex gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(command);
        }}
      >
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={connected ? "ATGET 010D" : "Connect to send commands"}
          disabled={!connected}
          className="font-mono"
          aria-label="AT command"
        />
        <Button type="submit" disabled={!connected || !/^AT/i.test(command.trim())}>
          <SendHorizontalIcon />
          Send
        </Button>
      </form>
    </Panel.Root>
  );
}
