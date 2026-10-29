import type { ReaderState } from "@fme/contracts";
import { describeDtc } from "@fme/shared/dtcs";
import { useState } from "react";
import { InspectorGroup } from "~/components/shell/Inspector";
import { PropertyRow } from "~/components/shell/PropertyRow";
import { StatusDot } from "~/components/shell/StatusDot";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { readerClearDtcsAtom, readerReadDtcsAtom, readerReadVinAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { cn } from "~/lib/utils";
import { decodeMonitorStatus, milOn } from "./readback";
import { ButtonRow, Facts, Verdict, formatClock } from "./parts";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ClearCodesButton({ disabled }: { disabled: boolean }) {
  const clearDtcs = useCommand(readerClearDtcsAtom);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="xs" disabled={disabled} />}>
        Clear Codes…
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-64" width="auto">
        <PopoverTitle className="text-xs">Clear codes from the scan tool?</PopoverTitle>
        <p className="mt-1.5 text-muted-foreground text-xs">
          Sends Mode 04 through the adapter, as a scan tool would. The emulator's own list won't
          update: the firmware can't report its codes back.
        </p>
        <div className="mt-3 flex justify-end gap-1.5">
          <Button variant="outline" size="xs" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="xs"
            onClick={() => {
              setOpen(false);
              void clearDtcs(undefined);
            }}
          >
            Clear Codes
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function TroubleCodesGroup({ reader }: { reader: ReaderState }) {
  const { state: emulator } = useEmulatorState();
  const readDtcs = useCommand(readerReadDtcsAtom);
  const connected = reader.connection._tag === "connected";
  const stored: ReadonlyArray<string> = emulator?.dtcs["03"] ?? [];
  const read = reader.dtcs;
  const missing = read === null ? [] : stored.filter((code) => !read.includes(code));
  const matches = read !== null && missing.length === 0 && read.every((c) => stored.includes(c));
  const lamp = reader.monitorStatus === null ? null : milOn(reader.monitorStatus);

  return (
    <InspectorGroup
      id="scan-codes"
      title="Trouble codes"
      keywords="dtc mode 03 04 check engine mil"
      summary={
        read === null ? undefined : (
          <Verdict ok={matches}>
            {read.filter((code) => stored.includes(code)).length} of {stored.length}
          </Verdict>
        )
      }
    >
      <PropertyRow label="Check engine lamp">
        {lamp === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            {lamp ? <StatusDot tone="busy" /> : null}
            {lamp ? "On" : "Off"}
            <Verdict ok={lamp === stored.length > 0} />
          </>
        )}
      </PropertyRow>
      {read !== null && read.length + missing.length > 0 ? (
        <ul className="my-1 rounded-[5px] bg-pane-sunken py-0.75 shadow-[inset_0_0_0_1px_var(--color-border)]">
          {[...read, ...missing].map((code) => {
            const set = stored.includes(code);
            const wasRead = read.includes(code);
            return (
              <li
                key={code}
                className="grid h-6 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2 border-b px-2 last:border-b-0"
              >
                <code className="font-mono font-semibold text-[11.5px]">{code}</code>
                <span className="truncate text-2xs text-muted-foreground">
                  {describeDtc(code).description}
                </span>
                <span className="text-2xs">
                  <Verdict ok={set && wasRead}>
                    {!wasRead ? "Not read" : set ? "Set" : "Not set"}
                  </Verdict>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="mt-1.5 text-muted-foreground text-xs">
        {read === null || reader.dtcsAt === null
          ? "Not read yet."
          : `Mode 03 read ${formatClock(reader.dtcsAt)} · ${
              matches
                ? stored.length === 0
                  ? "no stored codes, as set"
                  : `matches the ${plural(stored.length, "stored code")}`
                : `differs from the ${plural(stored.length, "stored code")}`
            }`}
      </p>
      <ButtonRow>
        <Button
          variant="outline"
          size="xs"
          disabled={!connected}
          onClick={() => void readDtcs(undefined)}
        >
          Read Codes
        </Button>
        <ClearCodesButton disabled={!connected} />
      </ButtonRow>
    </InspectorGroup>
  );
}

export function ReadinessGroup({ reader }: { reader: ReaderState }) {
  const { state: emulator } = useEmulatorState();
  if (reader.monitorStatus === null || emulator === null) {
    return (
      <InspectorGroup id="scan-readiness" title="Readiness" keywords="monitors 0101">
        <p className="text-muted-foreground text-xs">Read with the trouble codes (PID 0101).</p>
      </InspectorGroup>
    );
  }
  const monitors = decodeMonitorStatus(reader.monitorStatus);
  const agrees = (id: (typeof monitors)[number]["id"]) => {
    const set = emulator.readiness[id];
    const read = monitors.find((m) => m.id === id)!;
    return read.supported === set.supported && read.complete === (set.supported && set.complete);
  };
  const supported = monitors.filter((m) => m.supported);
  const complete = supported.filter((m) => m.complete);
  const incomplete = supported.filter((m) => !m.complete);
  const expected = Object.values(emulator.readiness).filter((m) => m.supported);
  const allAgree = monitors.every((m) => agrees(m.id));

  return (
    <InspectorGroup
      id="scan-readiness"
      title="Readiness"
      keywords="monitors 0101"
      summary={<Verdict ok={allAgree}>{allAgree ? "Matches" : "Differs"}</Verdict>}
    >
      <PropertyRow label="Monitors complete">
        <span className="tabular-nums">
          {complete.length} of {supported.length}
        </span>
        <Verdict
          ok={
            supported.length === expected.length &&
            complete.length === expected.filter((m) => m.complete).length
          }
        />
      </PropertyRow>
      {incomplete.length > 0 ? (
        <PropertyRow label={incomplete.map((m) => m.label).join(", ")}>
          <span className="text-warning-foreground">Incomplete</span>
          <Verdict ok={incomplete.every((m) => agrees(m.id))} />
        </PropertyRow>
      ) : null}
      {monitors
        .filter((m) => !agrees(m.id))
        .map((m) => (
          <PropertyRow key={m.id} label={m.label}>
            <span className={cn("text-error-foreground")}>
              {!m.supported ? "Not supported" : m.complete ? "Complete" : "Incomplete"}
            </span>
            <Verdict ok={false} />
          </PropertyRow>
        ))}
    </InspectorGroup>
  );
}

export function VehicleInfoGroup({ reader }: { reader: ReaderState }) {
  const { state: emulator } = useEmulatorState();
  const readVin = useCommand(readerReadVinAtom);
  const connected = reader.connection._tag === "connected";
  const expected = emulator?.vinEnabled === false ? null : (emulator?.vin ?? null);
  return (
    <InspectorGroup id="scan-vehicle" title="Vehicle info" keywords="vin mode 09">
      <Facts>
        <dt>VIN</dt>
        <dd>
          <code className="truncate">{reader.vin ?? "—"}</code>
        </dd>
        {reader.vin !== null ? (
          <>
            <dt />
            <dd>
              <Verdict ok={reader.vin === expected}>
                {reader.vin === expected ? "Matches the emulator" : "Differs from the emulator"}
              </Verdict>
            </dd>
          </>
        ) : null}
      </Facts>
      <ButtonRow>
        <Button
          variant="outline"
          size="xs"
          disabled={!connected}
          onClick={() => void readVin(undefined)}
        >
          Read VIN
        </Button>
      </ButtonRow>
    </InspectorGroup>
  );
}
