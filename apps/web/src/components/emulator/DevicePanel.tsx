import type { ObdProtocol, Vin } from "@fme/contracts";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { setIgnitionAtom, setProtocolAtom, setVinAtom, setVinEnabledAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { Panel } from "./Panel";

const PROTOCOLS: ReadonlyArray<{ value: ObdProtocol; label: string }> = [
  { value: "CAN_11B_500K", label: "CAN 11-bit 500 kbps" },
  { value: "CAN_11B_250K", label: "CAN 11-bit 250 kbps" },
  { value: "CAN_29B_500K", label: "CAN 29-bit 500 kbps" },
  { value: "CAN_29B_250K", label: "CAN 29-bit 250 kbps" },
  { value: "ISO9141_2", label: "ISO 9141-2" },
  { value: "KWP2000_FAST", label: "KWP2000 fast" },
  { value: "KWP2000_5BPS", label: "KWP2000 5 baud" },
  { value: "J1850_PWM", label: "J1850 PWM" },
  { value: "J1850_VPW", label: "J1850 VPW" },
  { value: "J1939", label: "J1939" },
];

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export function DevicePanel() {
  const { state } = useEmulatorState();
  const setIgnition = useCommand(setIgnitionAtom);
  const setProtocol = useCommand(setProtocolAtom);
  const setVin = useCommand(setVinAtom);
  const setVinEnabled = useCommand(setVinEnabledAtom);
  const [vinDraft, setVinDraft] = useState<string | null>(null);

  if (state === null) return null;
  const vinValue = vinDraft ?? state.vin ?? "";
  const vinValid = VIN_PATTERN.test(vinValue);
  const protocolLabel = PROTOCOLS.find((p) => p.value === state.protocol)?.label ?? state.protocol;

  const submitVin = async () => {
    if (!vinValid) return;
    if (await setVin({ vin: vinValue as Vin })) setVinDraft(null);
  };

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.Title>Vehicle</Panel.Title>
        <Panel.Description>
          {state.connection._tag === "connected"
            ? "Changes apply to the emulator immediately."
            : "Not connected. Changes are applied when you connect."}
        </Panel.Description>
      </Panel.Header>
      <Panel.Body className="grid gap-4 sm:grid-cols-[auto_1fr_1.4fr]">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ignition">Ignition</Label>
          <div className="flex h-8 items-center gap-2">
            <Switch
              id="ignition"
              checked={state.ignition}
              onCheckedChange={(on) => void setIgnition({ on })}
            />
            <span className="text-sm">{state.ignition ? "On" : "Off"}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Protocol</Label>
          <Select
            value={state.protocol}
            onValueChange={(value) => {
              const protocol = PROTOCOLS.find((p) => p.value === value)?.value;
              if (protocol !== undefined) void setProtocol({ protocol });
            }}
          >
            <SelectTrigger aria-label="Protocol">
              <SelectValue>{protocolLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {PROTOCOLS.map((protocol) => (
                <SelectItem key={protocol.value} value={protocol.value}>
                  {protocol.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="vin">VIN</Label>
            <label className="flex items-center gap-2 text-muted-foreground text-xs">
              Respond to Mode 09
              <Switch
                checked={state.vinEnabled}
                onCheckedChange={(enabled) => void setVinEnabled({ enabled })}
                aria-label="Respond to VIN requests"
              />
            </label>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitVin();
            }}
          >
            <Input
              id="vin"
              value={vinValue}
              onChange={(event) => setVinDraft(event.target.value.toUpperCase())}
              placeholder="17 characters"
              maxLength={17}
              className="font-mono"
              aria-invalid={vinValue.length > 0 && !vinValid}
            />
            <Button type="submit" variant="outline" disabled={!vinValid || vinDraft === null}>
              <KeyRoundIcon />
              Set
            </Button>
          </form>
        </div>
      </Panel.Body>
    </Panel.Root>
  );
}
