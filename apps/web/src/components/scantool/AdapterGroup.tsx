import type { ReaderConnection, ReaderState, ReaderTarget, SerialPortInfo } from "@fme/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import {
  BluetoothIcon,
  CableIcon,
  CpuIcon,
  PlugZapIcon,
  RotateCcwIcon,
  UnplugIcon,
  UsbIcon,
  WifiIcon,
} from "lucide-react";
import { useState } from "react";
import { InspectorGroup } from "~/components/shell/Inspector";
import { PropertyRow } from "~/components/shell/PropertyRow";
import { SegmentedControl } from "~/components/shell/SegmentedControl";
import { StatusDot, type StatusTone } from "~/components/shell/StatusDot";
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
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { ButtonRow, Facts } from "./parts";

type Link = "bluetooth" | "usb" | "wifi";

const LINKS = [
  { value: "bluetooth", label: "Bluetooth", icon: <BluetoothIcon /> },
  { value: "usb", label: "USB", icon: <UsbIcon /> },
  { value: "wifi", label: "Wi-Fi", icon: <WifiIcon /> },
] as const;

const SIMULATED = "simulated";

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

const portName = (path: string) => path.replace("/dev/", "");

/** Bluetooth SPP ports have no USB IDs; macOS's incoming port is never an adapter. */
const linkPorts = (ports: ReadonlyArray<SerialPortInfo>, link: Link) =>
  ports.filter((port) =>
    link === "usb"
      ? port.vendorId !== undefined
      : port.vendorId === undefined && !/Bluetooth-Incoming-Port/i.test(port.path),
  );

const describeTarget = (target: ReaderTarget) =>
  target._tag === "serial"
    ? portName(target.path)
    : target._tag === "tcp"
      ? `${target.host}:${target.port}`
      : "Simulated adapter";

const status = (
  connection: ReaderConnection,
  responding: boolean,
): readonly [StatusTone, string] => {
  switch (connection._tag) {
    case "connected":
      return responding ? ["ok", "Reading"] : ["busy", "No vehicle data"];
    case "connecting":
      return ["busy", "Connecting…"];
    case "failed":
      return ["error", "Failed"];
    case "disconnected":
      return ["off", "Not connected"];
  }
};

export function AdapterGroup({ reader }: { reader: ReaderState }) {
  const { state: emulator } = useEmulatorState();
  const portsResult = useAtomValue(portsAtom);
  const refreshPorts = useAtomRefresh(portsAtom);
  const connect = useCommand(readerConnectAtom);
  const disconnect = useCommand(readerDisconnectAtom);
  const readDtcs = useCommand(readerReadDtcsAtom);
  const readVin = useCommand(readerReadVinAtom);
  const [link, setLink] = useState<Link>("bluetooth");
  const [device, setDevice] = useState(SIMULATED);
  const [host, setHost] = useState("192.168.0.10");
  const [port, setPort] = useState("35000");

  const connection = reader.connection;
  const busy = connection._tag === "connected" || connection._tag === "connecting";
  // The emulator's own control port can't also be the adapter.
  const emulatorPath =
    emulator?.connection._tag === "connected" && emulator.connection.target._tag === "serial"
      ? emulator.connection.target.path
      : null;
  const ports = linkPorts(
    (AsyncResult.isSuccess(portsResult) ? portsResult.value : []).filter(
      (p) => p.path !== emulatorPath,
    ),
    link,
  );
  const selected = ports.some((p) => p.path === device) ? device : SIMULATED;
  const target: ReaderTarget =
    link === "wifi"
      ? { _tag: "tcp", host: host.trim(), port: Number(port) }
      : selected === SIMULATED
        ? { _tag: "simulated" }
        : { _tag: "serial", path: selected };
  const wifiValid = host.trim().length > 0 && Number.isInteger(Number(port)) && Number(port) > 0;

  const open = async (next: ReaderTarget) => {
    // A scan tool reads the codes and VIN as soon as it links up.
    if (await connect({ target: next })) {
      await readDtcs(undefined);
      await readVin(undefined);
    }
  };

  const [tone, label] = status(connection, reader.vehicleResponding);
  const shownTarget = connection._tag === "disconnected" ? target : connection.target;

  return (
    <InspectorGroup id="scan-adapter" title="Adapter" keywords="bluetooth usb wi-fi elm327">
      <SegmentedControl
        items={LINKS.map(({ value, label, icon }) => ({ value, label, icon, disabled: busy }))}
        value={link}
        onValueChange={setLink}
        fill
        aria-label="Adapter link"
        className="mt-0.5 mb-2"
      />
      {link === "wifi" ? (
        <>
          <PropertyRow label="Host" htmlFor="scan-wifi-host">
            <Input
              id="scan-wifi-host"
              size="sm"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              disabled={busy}
              className="w-42 font-mono"
            />
          </PropertyRow>
          <PropertyRow label="Port" htmlFor="scan-wifi-port">
            <Input
              id="scan-wifi-port"
              size="sm"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              inputMode="numeric"
              disabled={busy}
              className="w-42 font-mono"
            />
          </PropertyRow>
        </>
      ) : (
        <PropertyRow label="Device">
          <Select
            value={selected}
            onValueChange={(value) => {
              if (typeof value === "string") setDevice(value);
            }}
            onOpenChange={(isOpen) => {
              if (isOpen) refreshPorts();
            }}
            disabled={busy}
          >
            <SelectTrigger size="xs" className="w-42 min-w-0" aria-label="OBD-II adapter">
              <SelectValue>
                <span className="truncate">
                  {selected === SIMULATED ? "Simulated adapter" : portName(selected)}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ports.map((p) => (
                <SelectItem key={p.path} value={p.path}>
                  <span className="flex items-center gap-2">
                    {link === "usb" ? <CableIcon /> : <BluetoothIcon />}
                    {portName(p.path)}
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={SIMULATED}>
                <span className="flex items-center gap-2">
                  <CpuIcon />
                  Simulated adapter
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
        </PropertyRow>
      )}

      <Facts className="mt-1.5">
        <dt>{shownTarget._tag === "tcp" ? "Address" : "Port"}</dt>
        <dd>
          <code className="truncate">{describeTarget(shownTarget)}</code>
        </dd>
        <dt>Status</dt>
        <dd>
          <StatusDot tone={tone} />
          {label}
        </dd>
        {connection._tag === "failed" ? (
          <dd className="col-span-2 whitespace-normal! text-error-foreground">
            {connection.reason}
          </dd>
        ) : null}
        {connection._tag === "connected" ? (
          <>
            <dt>Adapter</dt>
            <dd className="truncate">{connection.adapter}</dd>
            <dt>Protocol</dt>
            <dd>
              {connection.protocol === null ? (
                <span className="text-muted-foreground">Searching…</span>
              ) : (
                <>
                  <code>{connection.protocol}</code>
                  <span className="truncate">
                    {PROTOCOL_NAMES[connection.protocol.replace(/^A/i, "")] ?? ""}
                  </span>
                </>
              )}
            </dd>
            <dt>Vehicle</dt>
            <dd>{reader.vehicleResponding ? "Responding" : "Not responding"}</dd>
            <dt>Supply</dt>
            <dd className="tabular-nums">
              {reader.voltage === null ? "—" : `${reader.voltage.toFixed(1)} V`}
              <span className="text-muted-foreground">ATRV</span>
            </dd>
          </>
        ) : null}
      </Facts>

      <ButtonRow>
        {busy ? (
          <>
            <Button variant="outline" size="xs" onClick={() => void disconnect(undefined)}>
              <UnplugIcon />
              Disconnect
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={connection._tag !== "connected"}
              title="Reset the adapter (ATZ) and search for the protocol again"
              onClick={() => {
                if (connection._tag === "connected") void open(connection.target);
              }}
            >
              <RotateCcwIcon />
              Reset Adapter
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            disabled={link === "wifi" && !wifiValid}
            onClick={() => void open(target)}
          >
            <PlugZapIcon />
            Connect
          </Button>
        )}
      </ButtonRow>
    </InspectorGroup>
  );
}
