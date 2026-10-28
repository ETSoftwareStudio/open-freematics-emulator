import type { ReaderConnection, ReaderTarget, SerialPortInfo } from "@fme/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { BluetoothIcon, CpuIcon, PlugZapIcon, UnplugIcon, WifiIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  portsAtom,
  readerConnectAtom,
  readerDisconnectAtom,
  readerReadDtcsAtom,
  readerReadVinAtom,
} from "~/rpc/atoms";
import { useCommand, useEmulatorState, useReaderState } from "~/rpc/hooks";
import { Panel } from "./Panel";

const PROTOCOL_NAMES: Record<string, string> = {
  "1": "SAE J1850 PWM",
  "2": "SAE J1850 VPW",
  "3": "ISO 9141-2",
  "4": "ISO 14230-4 KWP (5 baud)",
  "5": "ISO 14230-4 KWP (fast)",
  "6": "CAN 11-bit 500 kbps",
  "7": "CAN 29-bit 500 kbps",
  "8": "CAN 11-bit 250 kbps",
  "9": "CAN 29-bit 250 kbps",
  A: "SAE J1939",
};

const SIMULATED = "simulated";
const WIFI = "wifi";

const protocolName = (dpn: string | null) =>
  dpn === null ? "searching…" : (PROTOCOL_NAMES[dpn.replace(/^A/i, "")] ?? dpn);

const portLabel = (port: SerialPortInfo) => port.path.replace("/dev/", "");

function ReaderStatus({
  connection,
  responding,
}: {
  connection: ReaderConnection;
  responding: boolean;
}) {
  switch (connection._tag) {
    case "connected":
      return responding ? (
        <Badge variant="success">Reading</Badge>
      ) : (
        <Badge variant="warning">No vehicle data</Badge>
      );
    case "connecting":
      return <Badge variant="info">Connecting…</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    default:
      return <Badge variant="secondary">Disconnected</Badge>;
  }
}

export function ScanToolPanel() {
  const reader = useReaderState();
  const { state: emulator } = useEmulatorState();
  const portsResult = useAtomValue(portsAtom);
  const ports = AsyncResult.isSuccess(portsResult) ? portsResult.value : [];
  const connect = useCommand(readerConnectAtom);
  const disconnect = useCommand(readerDisconnectAtom);
  const readDtcs = useCommand(readerReadDtcsAtom);
  const readVin = useCommand(readerReadVinAtom);
  const [choice, setChoice] = useState<string>(SIMULATED);
  const [host, setHost] = useState("192.168.0.10");
  const [port, setPort] = useState("35000");
  if (reader === null) return null;

  const connection = reader.connection;
  const busy = connection._tag === "connected" || connection._tag === "connecting";
  // The emulator's own control port can't also be the adapter.
  const emulatorPath =
    emulator?.connection._tag === "connected" && emulator.connection.target._tag === "serial"
      ? emulator.connection.target.path
      : null;
  const adapterPorts = ports.filter((p) => p.path !== emulatorPath);
  const target: ReaderTarget =
    choice === SIMULATED
      ? { _tag: "simulated" }
      : choice === WIFI
        ? { _tag: "tcp", host: host.trim(), port: Number(port) }
        : { _tag: "serial", path: choice };
  const choiceLabel =
    choice === SIMULATED
      ? "Simulated adapter"
      : choice === WIFI
        ? "Wi-Fi adapter"
        : choice.replace("/dev/", "");
  const emulatorDtcs = emulator?.dtcs["03"] ?? [];
  const dtcsMatch =
    reader.dtcs !== null &&
    reader.dtcs.length === emulatorDtcs.length &&
    reader.dtcs.every((code) => emulatorDtcs.includes(code as (typeof emulatorDtcs)[number]));

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.Title>Scan tool</Panel.Title>
        <Panel.Description>An OBD-II adapter reading the emulator</Panel.Description>
        <Panel.Actions>
          <ReaderStatus connection={connection} responding={reader.vehicleResponding} />
        </Panel.Actions>
      </Panel.Header>
      <Panel.Body className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Select
            value={choice}
            onValueChange={(value) => {
              if (typeof value === "string") setChoice(value);
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label="OBD-II adapter">
              <SelectValue>{choiceLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {adapterPorts.map((p) => (
                <SelectItem key={p.path} value={p.path}>
                  <span className="flex items-center gap-2">
                    <BluetoothIcon />
                    {portLabel(p)}
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={WIFI}>
                <span className="flex items-center gap-2">
                  <WifiIcon />
                  Wi-Fi adapter
                </span>
              </SelectItem>
              <SelectItem value={SIMULATED}>
                <span className="flex items-center gap-2">
                  <CpuIcon />
                  Simulated adapter
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
          {busy ? (
            <Button variant="outline" onClick={() => void disconnect(undefined)}>
              <UnplugIcon />
              Disconnect
            </Button>
          ) : (
            <Button onClick={() => void connect({ target })}>
              <PlugZapIcon />
              Connect
            </Button>
          )}
        </div>
        {choice === WIFI && !busy ? (
          <div className="flex gap-2">
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              aria-label="Adapter host"
              className="font-mono"
            />
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              aria-label="Adapter port"
              inputMode="numeric"
              className="w-28 font-mono"
            />
          </div>
        ) : null}

        {connection._tag === "failed" ? (
          <p className="text-error-foreground text-xs">{connection.reason}</p>
        ) : null}
        {connection._tag === "connected" ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Adapter</dt>
            <dd>{connection.adapter}</dd>
            <dt className="text-muted-foreground">Protocol</dt>
            <dd>{protocolName(connection.protocol)}</dd>
            <dt className="text-muted-foreground">VIN</dt>
            <dd className="flex items-center gap-2 font-mono">
              {reader.vin ?? "—"}
              {reader.vin !== null && emulator?.vin !== null ? (
                reader.vin === emulator?.vin ? (
                  <Badge variant="success" size="sm">
                    matches
                  </Badge>
                ) : (
                  <Badge variant="error" size="sm">
                    differs
                  </Badge>
                )
              ) : null}
            </dd>
            <dt className="text-muted-foreground">Stored codes</dt>
            <dd className="flex items-center gap-2 font-mono">
              {reader.dtcs === null
                ? "—"
                : reader.dtcs.length === 0
                  ? "none"
                  : reader.dtcs.join(", ")}
              {reader.dtcs !== null ? (
                dtcsMatch ? (
                  <Badge variant="success" size="sm">
                    matches
                  </Badge>
                ) : (
                  <Badge variant="error" size="sm">
                    differs
                  </Badge>
                )
              ) : null}
            </dd>
          </dl>
        ) : null}
        {connection._tag === "connected" ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void readDtcs(undefined)}>
              Read codes
            </Button>
            <Button variant="outline" size="sm" onClick={() => void readVin(undefined)}>
              Read VIN
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Plug a Bluetooth, Wi-Fi or USB ELM327 adapter into the emulator's OBD port. Live values
            it reads appear next to each PID.
          </p>
        )}
      </Panel.Body>
    </Panel.Root>
  );
}
