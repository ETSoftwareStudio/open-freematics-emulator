import type { SerialPortInfo } from "@fme/contracts";
import { BluetoothIcon, CableIcon, UsbIcon } from "lucide-react";

/** The device name a user recognizes: no `/dev/` and no macOS `cu.`/`tty.` prefix. */
export const portName = (path: string) => path.replace(/^\/dev\/((cu|tty)\.)?/, "");

export const portTitle = (port: SerialPortInfo) => {
  if (port.likelyEmulator) return "Freematics MK2";
  if (port.transport === "usb") return port.manufacturer ?? "USB serial";
  return portName(port.path);
};

const TRANSPORTS = {
  usb: { Icon: UsbIcon, label: "USB" },
  bluetooth: { Icon: BluetoothIcon, label: "Bluetooth" },
  other: { Icon: CableIcon, label: "Serial" },
};

export function PortIcon({ transport }: { transport: SerialPortInfo["transport"] | undefined }) {
  const { Icon, label } = TRANSPORTS[transport ?? "other"];
  return <Icon role="img" aria-label={label} />;
}

/** Icon and title, then the port name when it says something the title doesn't. */
export function PortLabel({ port }: { port: SerialPortInfo }) {
  const title = portTitle(port);
  const name = portName(port.path);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PortIcon transport={port.transport} />
      <span className="truncate">{title}</span>
      {name === title ? null : (
        <code className="truncate font-mono text-2xs text-muted-foreground">{name}</code>
      )}
    </span>
  );
}
