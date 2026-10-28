import { MAX_DTCS_PER_MODE, type DtcCode, type DtcMode } from "@fme/contracts";
import { DTC_CATALOG, PIDS_RESET_BY_CLEAR, describeDtc, type DtcEntry } from "@fme/shared/dtcs";
import { findPid, type PidDefinition } from "@fme/shared/pids";
import { PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "~/components/ui/number-field";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { clearDtcsAtom, setDtcsAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { Panel } from "./Panel";
import { usePidControl } from "./pidControl";

const MODES: ReadonlyArray<{ mode: DtcMode; label: string; hint: string }> = [
  {
    mode: "03",
    label: "Stored",
    hint: "Mode 03. Lights the MIL and sets the code count in PID 0101.",
  },
  {
    mode: "07",
    label: "Pending",
    hint: "Mode 07. Faults seen on the current drive cycle, before they light the MIL.",
  },
  {
    mode: "0A",
    label: "Permanent",
    hint: "Mode 0A. Codes a scan tool can't clear until the ECU sees the fault fixed.",
  },
];

const DTC_PATTERN = /^[PCBU][0-3][0-9A-F]{3}$/;

const COUNTERS = PIDS_RESET_BY_CLEAR.map(findPid).filter(
  (definition): definition is PidDefinition => definition !== undefined,
);

const matchesQuery = (entry: DtcEntry, query: string) => {
  const needle = query.trim().toLowerCase();
  return (
    entry.code.toLowerCase().startsWith(needle) || entry.description.toLowerCase().includes(needle)
  );
};

function CounterField({ definition, value }: { definition: PidDefinition; value: number }) {
  const { shown, commit } = usePidControl(definition, value);
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{definition.name}</span>
      <span className="flex items-center gap-1.5">
        <NumberField
          value={shown}
          min={definition.min}
          max={definition.max}
          step={definition.step}
          size="sm"
          className="w-24"
          onValueCommitted={(next) => {
            if (next !== null) void commit(next);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldInput className="text-right font-mono" aria-label={definition.name} />
          </NumberFieldGroup>
        </NumberField>
        <span className="w-6 text-muted-foreground">{definition.unit}</span>
      </span>
    </label>
  );
}

export function DtcPanel() {
  const { state } = useEmulatorState();
  const setDtcs = useCommand(setDtcsAtom);
  const clearDtcs = useCommand(clearDtcsAtom);
  const [pickedMode, setMode] = useState<DtcMode>("03");
  const [draft, setDraft] = useState("");
  if (state === null) return null;

  // Unknown until connected; offline edits are applied on connect where the firmware allows.
  const capabilities = state.connection._tag === "connected" ? state.connection.capabilities : null;
  const supports = (mode: DtcMode) => capabilities === null || capabilities.dtcModes.includes(mode);
  const mode = supports(pickedMode) ? pickedMode : "03";
  const modeInfo = MODES.find((m) => m.mode === mode);

  const codes = state.dtcs[mode];
  const stored = state.dtcs["03"].length;
  const candidate = draft.trim().toUpperCase();
  const canAdd =
    DTC_PATTERN.test(candidate) &&
    !codes.includes(candidate as DtcCode) &&
    codes.length < MAX_DTCS_PER_MODE;
  const allCount = state.dtcs["03"].length + state.dtcs["07"].length + state.dtcs["0A"].length;
  const unsupportedModes = MODES.filter((m) => !supports(m.mode)).map((m) => m.label.toLowerCase());

  const add = async () => {
    if (!canAdd) return;
    if (await setDtcs({ mode, codes: [...codes, candidate as DtcCode] })) setDraft("");
  };

  return (
    <Panel.Root id="trouble-codes" className="scroll-mt-4">
      <Panel.Header>
        <Panel.Title>Trouble codes</Panel.Title>
        <Panel.Actions>
          {stored > 0 ? (
            <Badge variant="warning">
              <TriangleAlertIcon />
              MIL on
            </Badge>
          ) : (
            <Badge variant="secondary">MIL off</Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={allCount === 0}
            title="Like a scan tool's Mode 04: clears every code and resets the counters below."
            onClick={() => void clearDtcs({})}
          >
            Clear all
          </Button>
        </Panel.Actions>
      </Panel.Header>
      <Panel.Body className="flex flex-col gap-3">
        <ToggleGroup
          value={[mode]}
          onValueChange={(next) => {
            const picked = MODES.find((m) => m.mode === next[0]);
            if (picked !== undefined) setMode(picked.mode);
          }}
          aria-label="DTC mode"
        >
          {MODES.map((m) => (
            <ToggleGroupItem
              key={m.mode}
              value={m.mode}
              size="sm"
              disabled={!supports(m.mode)}
              title={supports(m.mode) ? undefined : "This firmware doesn't accept these codes."}
            >
              {m.label}
              {state.dtcs[m.mode].length > 0 ? ` (${state.dtcs[m.mode].length})` : ""}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-muted-foreground text-xs">{modeInfo?.hint}</p>

        <ul className="flex flex-col gap-1.5" aria-label="Active codes">
          {codes.length === 0 ? (
            <li className="text-muted-foreground text-sm">No codes set.</li>
          ) : null}
          {codes.map((code) => {
            const { description, known } = describeDtc(code);
            return (
              <li
                key={code}
                className="flex items-center gap-2.5 rounded-lg border bg-background px-2.5 py-1.5"
              >
                <span className="font-medium font-mono text-sm">{code}</span>
                <span
                  className={`min-w-0 flex-1 truncate text-xs ${known ? "" : "text-muted-foreground"}`}
                  title={description}
                >
                  {description}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${code}`}
                  onClick={() => void setDtcs({ mode, codes: codes.filter((c) => c !== code) })}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Autocomplete
            items={DTC_CATALOG}
            value={draft}
            onValueChange={setDraft}
            itemToStringValue={(entry) => entry.code}
            filter={(entry, query) => matchesQuery(entry, query)}
          >
            <AutocompleteInput
              placeholder="P0300 or “misfire”"
              className="font-mono"
              aria-label="New trouble code"
              aria-invalid={candidate.length === 5 && !DTC_PATTERN.test(candidate)}
            />
            <AutocompletePopup className="w-96">
              <AutocompleteEmpty>
                Not in the list. Any valid code (P, C, B or U and 4 digits) still works.
              </AutocompleteEmpty>
              <AutocompleteList>
                {(entry: DtcEntry) => (
                  <AutocompleteItem key={entry.code} value={entry}>
                    <span className="font-mono">{entry.code}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {entry.description}
                    </span>
                  </AutocompleteItem>
                )}
              </AutocompleteList>
            </AutocompletePopup>
          </Autocomplete>
          <Button type="submit" variant="outline" disabled={!canAdd}>
            <PlusIcon />
            Add
          </Button>
        </form>
        <p className="text-muted-foreground text-xs">
          Up to {MAX_DTCS_PER_MODE} codes per mode.
          {unsupportedModes.length > 0
            ? ` This firmware doesn't support ${unsupportedModes.join(" or ")} codes; the official V1.3 firmware may.`
            : null}
        </p>

        <section className="flex flex-col gap-2 border-t pt-3" aria-label="Diagnostic counters">
          <h3 className="font-medium text-xs">Counters</h3>
          {COUNTERS.map((definition) => (
            <CounterField
              key={definition.id}
              definition={definition}
              value={state.pids[definition.id] ?? definition.defaultValue}
            />
          ))}
        </section>
      </Panel.Body>
    </Panel.Root>
  );
}
