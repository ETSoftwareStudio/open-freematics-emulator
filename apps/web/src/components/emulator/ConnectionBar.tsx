import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ConnectTarget, Connection, SerialPortInfo } from "@fme/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import {
  CableIcon,
  CpuIcon,
  PlugZapIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { connectAtom, disconnectAtom, portsAtom } from "~/rpc/atoms";
import { AboutPopover } from "./AboutPopover";
import { useCommand, useEmulatorState } from "~/rpc/hooks";

const SIMULATED = "simulated";

const targetKey = (target: ConnectTarget) => (target._tag === "serial" ? target.path : SIMULATED);

const toTarget = (key: string): ConnectTarget =>
  key === SIMULATED ? { _tag: "simulated" } : { _tag: "serial", path: key };

const portLabel = (port: SerialPortInfo) =>
  `${port.path.replace("/dev/", "")}${port.manufacturer ? ` · ${port.manufacturer}` : ""}`;

function StatusBadge({
  connection,
  serverReachable,
}: {
  connection: Connection | undefined;
  serverReachable: boolean;
}) {
  if (!serverReachable) return <Badge variant="warning">Server offline</Badge>;
  switch (connection?._tag) {
    case "connected":
      return <Badge variant="success">Connected</Badge>;
    case "connecting":
      return <Badge variant="info">Connecting…</Badge>;
    case "failed":
      return <Badge variant="error">Connection failed</Badge>;
    default:
      return <Badge variant="secondary">Disconnected</Badge>;
  }
}

export function ConnectionBar() {
  const { state, serverReachable } = useEmulatorState();
  const portsResult = useAtomValue(portsAtom);
  const refreshPorts = useAtomRefresh(portsAtom);
  const connect = useCommand(connectAtom);
  const disconnect = useCommand(disconnectAtom);
  const ports = AsyncResult.isSuccess(portsResult) ? portsResult.value : [];
  const connection = state?.connection;
  const active = connection !== undefined && connection._tag !== "disconnected" ? connection : null;

  const [chosen, setChosen] = useState<string | null>(null);
  // Prefer the user's pick, then the live connection, then the first port that looks like an MK2.
  const selected =
    chosen ??
    (active ? targetKey(active.target) : null) ??
    ports.find((port) => port.likelyEmulator)?.path ??
    SIMULATED;
  const isConnected = connection?._tag === "connected";
  const isConnecting = connection?._tag === "connecting";
  const selectedLabel =
    selected === SIMULATED
      ? "Simulated device"
      : (ports.find((port) => port.path === selected) ?? { path: selected }).path.replace(
          "/dev/",
          "",
        );
  const connectSelected = () => void connect({ target: toTarget(selected) });

  return (
    <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
        <AboutPopover />

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <StatusBadge connection={connection} serverReachable={serverReachable} />
          {connection?._tag === "connected" && connection.device !== null ? (
            <span
              className="hidden text-muted-foreground text-xs md:inline"
              title={connection.device.details ?? undefined}
            >
              {connection.device.banner}
            </span>
          ) : null}
          <Select
            value={selected}
            onValueChange={(value) => {
              if (typeof value === "string") setChosen(value);
            }}
            disabled={isConnected || isConnecting}
          >
            <SelectTrigger className="w-64" aria-label="Device">
              <SelectValue>
                <span className="flex items-center gap-2 truncate">
                  {selected === SIMULATED ? <CpuIcon /> : <CableIcon />}
                  {selectedLabel}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ports.map((port) => (
                <SelectItem key={port.path} value={port.path}>
                  <span className="flex items-center gap-2">
                    <CableIcon />
                    {portLabel(port)}
                    {port.likelyEmulator ? (
                      <Badge variant="info" size="sm">
                        MK2
                      </Badge>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={SIMULATED}>
                <span className="flex items-center gap-2">
                  <CpuIcon />
                  Simulated device
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh ports"
            onClick={refreshPorts}
            disabled={isConnected || isConnecting}
          >
            <RefreshCwIcon />
          </Button>
          {isConnected || isConnecting ? (
            <Button variant="outline" onClick={() => void disconnect(undefined)}>
              <UnplugIcon />
              Disconnect
            </Button>
          ) : (
            <Button onClick={connectSelected} disabled={!serverReachable}>
              <PlugZapIcon />
              Connect
            </Button>
          )}
        </div>
      </div>
      {serverReachable && connection?._tag === "disconnected" ? (
        <div className="border-t bg-warning-surface" role="status">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-warning-foreground text-xs">
            <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">Not connected to {selectedLabel}.</span> Changes you
              make are kept here and sent to the device when you connect.
            </p>
            <Button size="sm" variant="outline" onClick={connectSelected}>
              <PlugZapIcon />
              Connect
            </Button>
          </div>
        </div>
      ) : null}
      {connection?._tag === "failed" ? (
        <div className="border-t bg-error-surface">
          <p className="mx-auto max-w-7xl px-4 py-2 text-error-foreground text-xs">
            {connection.reason}
          </p>
        </div>
      ) : null}
    </header>
  );
}
