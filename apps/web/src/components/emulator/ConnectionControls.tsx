import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ConnectTarget, Connection, SerialPortInfo } from "@fme/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { CableIcon, CpuIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { StatusDot, type StatusTone } from "~/components/shell/StatusDot";
import { connectAtom, disconnectAtom, portsAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";

const SIMULATED = "simulated";

/** The device the user picked; null follows the live connection or the likeliest port. */
const chosenTargetAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

const targetKey = (target: ConnectTarget) => (target._tag === "serial" ? target.path : SIMULATED);

const toTarget = (key: string): ConnectTarget =>
  key === SIMULATED ? { _tag: "simulated" } : { _tag: "serial", path: key };

const portLabel = (port: SerialPortInfo) =>
  `${port.path.replace("/dev/", "")}${port.manufacturer ? ` · ${port.manufacturer}` : ""}`;

/** The emulator target the toolbar, infobars and status bar all talk about. */
export function useEmulatorTarget() {
  const { state, serverReachable } = useEmulatorState();
  const portsResult = useAtomValue(portsAtom);
  const [chosen, setChosen] = useAtom(chosenTargetAtom);
  const connect = useCommand(connectAtom);
  const ports = AsyncResult.isSuccess(portsResult) ? portsResult.value : [];
  const connection = state?.connection;
  const active = connection !== undefined && connection._tag !== "disconnected" ? connection : null;
  const selected =
    chosen ??
    (active ? targetKey(active.target) : null) ??
    ports.find((port) => port.likelyEmulator)?.path ??
    SIMULATED;
  const simulated = selected === SIMULATED;
  return {
    connection,
    serverReachable,
    ports,
    selected,
    simulated,
    choose: setChosen,
    /** The port name without `/dev/`, or `Simulated device`. */
    label: simulated ? "Simulated device" : selected.replace("/dev/", ""),
    busy: connection?._tag === "connected" || connection?._tag === "connecting",
    connectSelected: () => void connect({ target: toTarget(selected) }),
  };
}

export const connectionTone = (
  connection: Connection | undefined,
  serverReachable: boolean,
): StatusTone => {
  if (!serverReachable) return "off";
  switch (connection?._tag) {
    case "connected":
      return "ok";
    case "connecting":
      return "busy";
    case "failed":
      return "error";
    default:
      return "off";
  }
};

const connectionText = (connection: Connection | undefined, serverReachable: boolean) => {
  if (!serverReachable) return "Server offline";
  switch (connection?._tag) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "failed":
      return "Connection failed";
    default:
      return "Not connected";
  }
};

export function DevicePicker() {
  const target = useEmulatorTarget();
  const refreshPorts = useAtomRefresh(portsAtom);
  return (
    <Select
      value={target.selected}
      onValueChange={(value) => {
        if (typeof value === "string") target.choose(value);
      }}
      onOpenChange={(open) => {
        if (open) refreshPorts();
      }}
      disabled={target.busy}
    >
      <SelectTrigger size="compact" className="w-auto min-w-0 max-w-72" aria-label="Emulator port">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot tone={connectionTone(target.connection, target.serverReachable)} />
            {target.simulated ? (
              <span className="truncate font-medium">Simulated</span>
            ) : (
              <>
                <span className="font-medium">MK2</span>
                <code className="truncate font-mono text-2xs text-muted-foreground">
                  {target.label}
                </code>
              </>
            )}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {target.ports.map((port) => (
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
  );
}

export function ConnectionStatus({ className }: { className?: string }) {
  const { connection, serverReachable } = useEmulatorTarget();
  const device = connection?._tag === "connected" ? connection.device : null;
  return (
    <span
      className={className}
      title={device === null ? undefined : [device.banner, device.details].join("\n")}
    >
      {connectionText(connection, serverReachable)}
    </span>
  );
}

export function ConnectButton() {
  const target = useEmulatorTarget();
  const disconnect = useCommand(disconnectAtom);
  return target.busy ? (
    <Button variant="outline" size="compact" onClick={() => void disconnect(undefined)}>
      Disconnect
    </Button>
  ) : (
    <Button size="compact" onClick={target.connectSelected} disabled={!target.serverReachable}>
      Connect
    </Button>
  );
}
