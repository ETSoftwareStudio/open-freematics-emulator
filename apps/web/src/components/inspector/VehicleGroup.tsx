import type { CalibrationId, Vin } from "@fme/contracts";
import { useId, useState } from "react";
import { InspectorGroup, useInspectorFilter } from "~/components/shell/Inspector";
import { PropertyRow } from "~/components/shell/PropertyRow";
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
import { Switch } from "~/components/ui/switch";
import { PROTOCOLS, protocolLabel } from "~/lib/protocols";
import {
  setCalibrationIdAtom,
  setIgnitionAtom,
  setProtocolAtom,
  setVinAtom,
  setVinEnabledAtom,
} from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { useFirmware } from "~/components/emulator/Firmware";
import { FirmwareLockNote, UnsentNote } from "./FirmwareNotes";
import { filterGroupRows, firmwareLock, firmwareSupport } from "./model";

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const CALIBRATION_ID_PATTERN = /^[\x20-\x7E]{1,16}$/;

const ROWS = [
  { id: "ignition", words: "Ignition key on off" },
  { id: "protocol", words: `Protocol bus ${PROTOCOLS.map((p) => p.label).join(" ")}` },
  { id: "vin", words: "VIN vehicle identification number report mode 09" },
  { id: "calibration", words: "Calibration ID CALID mode 09" },
] as const;

/** A text setting typed in full and sent with Set or Enter; Escape drops the edit. */
function TextSetting({
  id,
  value,
  pattern,
  maxLength,
  placeholder,
  uppercase = false,
  onSet,
}: {
  id: string;
  value: string | null;
  pattern: RegExp;
  maxLength: number;
  placeholder: string;
  uppercase?: boolean;
  onSet: (value: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? "";
  const valid = pattern.test(shown);
  const submit = async () => {
    if (draft !== null && valid && (await onSet(shown))) setDraft(null);
  };
  return (
    <form
      className="flex w-48 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        id={id}
        size="compact"
        font="mono"
        value={shown}
        onChange={(event) =>
          setDraft(uppercase ? event.target.value.toUpperCase() : event.target.value)
        }
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
        }}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={false}
        aria-invalid={shown.length > 0 && !valid}
        className="*:placeholder:font-sans"
      />
      <Button type="submit" size="compact" variant="outline" disabled={draft === null || !valid}>
        Set
      </Button>
    </form>
  );
}

export function VehicleGroup() {
  const { state } = useEmulatorState();
  const filter = useInspectorFilter();
  const setIgnition = useCommand(setIgnitionAtom);
  const setProtocol = useCommand(setProtocolAtom);
  const setVin = useCommand(setVinAtom);
  const setVinEnabled = useCommand(setVinEnabledAtom);
  const setCalibrationId = useCommand(setCalibrationIdAtom);
  const ids = { ignition: useId(), vin: useId(), calibration: useId() };
  const firmware = useFirmware();
  if (state === null) return null;

  const { rows, keywords } = filterGroupRows(filter, "Vehicle", ROWS, (row) => row.words);
  const shows = (id: (typeof ROWS)[number]["id"]) => rows.some((row) => row.id === id);
  const connected = state.connection._tag === "connected";
  const calibrationLock = firmwareLock(
    firmwareSupport(state.capabilities, "calibrationId"),
    firmware.info.version,
  );
  const calibrationUnsent = connected
    ? state.connection.unsent.find((edit) => edit._tag === "calibrationId")
    : undefined;

  return (
    <InspectorGroup
      id="vehicle"
      title="Vehicle"
      keywords={keywords}
      summary={
        connected ? undefined : (
          <span title="Not connected. Changes are kept and sent to the emulator on connect.">
            Sent on connect
          </span>
        )
      }
    >
      {shows("ignition") ? (
        <PropertyRow label="Ignition" htmlFor={ids.ignition}>
          <span className="text-2xs text-subtle-foreground">{state.ignition ? "On" : "Off"}</span>
          <Switch
            id={ids.ignition}
            size="sm"
            checked={state.ignition}
            onCheckedChange={(on) => void setIgnition({ on })}
          />
        </PropertyRow>
      ) : null}

      {shows("protocol") ? (
        <PropertyRow label="Protocol">
          <div className="w-48">
            <Select
              value={state.protocol}
              onValueChange={(value) => {
                const protocol = PROTOCOLS.find((p) => p.value === value)?.value;
                if (protocol !== undefined) void setProtocol({ protocol });
              }}
            >
              <SelectTrigger size="compact" aria-label="Protocol">
                <SelectValue>{protocolLabel(state.protocol)}</SelectValue>
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
        </PropertyRow>
      ) : null}

      {shows("vin") ? (
        <>
          <PropertyRow label="VIN" htmlFor={ids.vin}>
            <TextSetting
              id={ids.vin}
              value={state.vin}
              pattern={VIN_PATTERN}
              maxLength={17}
              placeholder="17 characters"
              uppercase
              onSet={(vin) => setVin({ vin: vin as Vin })}
            />
          </PropertyRow>
          <PropertyRow label="">
            <label
              className="flex w-48 items-center gap-2"
              title="Answer a scan tool's VIN request (Mode 09 PID 02)"
            >
              <Checkbox
                checked={state.vinEnabled}
                onCheckedChange={(enabled) => void setVinEnabled({ enabled })}
              />
              Report VIN
            </label>
          </PropertyRow>
        </>
      ) : null}

      {shows("calibration") ? (
        <PropertyRow label="Calibration ID" htmlFor={ids.calibration}>
          {calibrationLock !== null ? (
            <FirmwareLockNote lock={calibrationLock} className="w-48" />
          ) : (
            <TextSetting
              id={ids.calibration}
              value={state.calibrationId}
              pattern={CALIBRATION_ID_PATTERN}
              maxLength={16}
              placeholder="Up to 16 characters"
              onSet={(calibrationId) =>
                setCalibrationId({ calibrationId: calibrationId as CalibrationId })
              }
            />
          )}
        </PropertyRow>
      ) : null}
      {shows("calibration") && calibrationUnsent !== undefined ? (
        <UnsentNote edit={calibrationUnsent} />
      ) : null}
    </InspectorGroup>
  );
}
