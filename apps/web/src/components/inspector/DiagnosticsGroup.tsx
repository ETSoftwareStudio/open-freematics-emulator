import { MAX_DTCS_PER_MODE, type DtcCode, type DtcMode } from "@fme/contracts";
import { DTC_CATALOG, PIDS_RESET_BY_CLEAR, describeDtc, type DtcEntry } from "@fme/shared/dtcs";
import { findPid, type PidDefinition } from "@fme/shared/pids";
import { LockIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { InspectorGroup, useInspectorFilter } from "~/components/shell/Inspector";
import { PropertyRow } from "~/components/shell/PropertyRow";
import { SegmentedControl } from "~/components/shell/SegmentedControl";
import { StatusDot } from "~/components/shell/StatusDot";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Button } from "~/components/ui/button";
import { clearDtcsAtom, setDtcsAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { useFirmware } from "~/components/emulator/Firmware";
import { FirmwareLockNote, UnsentNote } from "./FirmwareNotes";
import { filterGroupRows, firmwareLock, firmwareSupport, matchesDtcQuery, pidWords } from "./model";
import { CounterRow } from "./PidRow";

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

type Row = { kind: "lamp" } | { kind: "codes" } | { kind: "counter"; definition: PidDefinition };

const ROWS: ReadonlyArray<Row> = [
  { kind: "lamp" },
  { kind: "codes" },
  ...COUNTERS.map((definition) => ({ kind: "counter" as const, definition })),
];

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function DiagnosticsGroup() {
  const { state } = useEmulatorState();
  const filter = useInspectorFilter();
  const setDtcs = useCommand(setDtcsAtom);
  const clearDtcs = useCommand(clearDtcsAtom);
  const [pickedMode, setMode] = useState<DtcMode>("03");
  const [draft, setDraft] = useState("");
  const firmware = useFirmware();
  if (state === null) return null;

  const supportOf = (mode: DtcMode) => firmwareSupport(state.capabilities, mode);
  const supports = (mode: DtcMode) => supportOf(mode) === "supported";
  const mode = supports(pickedMode) ? pickedMode : "03";
  const codes = state.dtcs[mode];
  const stored = state.dtcs["03"].length;
  const total = stored + state.dtcs["07"].length + state.dtcs["0A"].length;
  const candidate = draft.trim().toUpperCase();
  const full = codes.length >= MAX_DTCS_PER_MODE;
  const canAdd = DTC_PATTERN.test(candidate) && !codes.includes(candidate as DtcCode) && !full;
  // Pending and permanent are known or unknown together, so one note covers both.
  const lock =
    MODES.map((m) => firmwareLock(supportOf(m.mode), firmware.info.version)).find(
      (l) => l !== null,
    ) ?? null;
  const unsent =
    state.connection._tag === "connected"
      ? state.connection.unsent.filter((edit) => edit._tag === "dtcs")
      : [];

  const allCodes = [...state.dtcs["03"], ...state.dtcs["07"], ...state.dtcs["0A"]];
  const wordsOf = (row: Row) => {
    switch (row.kind) {
      case "lamp":
        return "Check engine lamp MIL";
      case "codes":
        return `Stored pending permanent codes add clear ${allCodes
          .map((code) => `${code} ${describeDtc(code).description}`)
          .join(" ")}`;
      case "counter":
        return pidWords(row.definition);
    }
  };
  const { rows, keywords } = filterGroupRows(
    filter,
    "Diagnostics trouble codes DTC",
    ROWS,
    wordsOf,
  );
  const shows = (kind: Row["kind"]) => rows.some((row) => row.kind === kind);
  const counters = rows.flatMap((row) => (row.kind === "counter" ? [row.definition] : []));

  const add = async () => {
    if (!canAdd) return;
    if (await setDtcs({ mode, codes: [...codes, candidate as DtcCode] })) setDraft("");
  };

  return (
    <InspectorGroup
      id="diagnostics"
      title="Diagnostics"
      keywords={keywords}
      summary={
        <>
          {stored > 0 ? <StatusDot tone="busy" /> : null}
          {total > 0 ? plural(total, "code") : "No codes"}
        </>
      }
    >
      {shows("lamp") ? (
        <PropertyRow label="Check engine lamp">
          <span
            className="flex items-center gap-1.5"
            title="Lit while stored (Mode 03) codes are set"
          >
            <StatusDot tone={stored > 0 ? "busy" : "off"} />
            {stored > 0 ? "On" : "Off"}
            <span className="text-2xs text-subtle-foreground">from codes</span>
          </span>
        </PropertyRow>
      ) : null}

      {shows("codes") ? (
        <div className="flex flex-col gap-1.5 pt-1">
          <SegmentedControl
            fill
            aria-label="Code type"
            value={mode}
            onValueChange={setMode}
            items={MODES.map((m) => {
              const count = state.dtcs[m.mode].length;
              return {
                value: m.mode,
                label: count > 0 ? `${m.label} ${count}` : m.label,
                icon: supports(m.mode) ? undefined : <LockIcon />,
                disabled: !supports(m.mode),
                title: m.hint,
              };
            })}
          />
          {lock === null ? null : <FirmwareLockNote lock={lock} />}
          {unsent.map((edit) => (
            <UnsentNote key={edit.mode} edit={edit} />
          ))}

          <ul
            className="flex flex-col divide-y rounded-md border bg-pane-sunken"
            aria-label={`${MODES.find((m) => m.mode === mode)?.label} codes`}
          >
            {codes.length === 0 ? (
              <li className="flex h-6.5 items-center px-2 text-subtle-foreground">No codes set</li>
            ) : null}
            {codes.map((code) => {
              const { description, known } = describeDtc(code);
              return (
                <li
                  key={code}
                  className="grid h-6.5 grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-2 ps-2 pe-1"
                >
                  <code className="font-mono font-semibold text-foreground">{code}</code>
                  <span
                    className={`truncate text-2xs ${known ? "text-muted-foreground" : "text-subtle-foreground"}`}
                    title={description}
                  >
                    {description}
                  </span>
                  <Button
                    variant="ghost-muted"
                    size="icon-micro"
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
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <div className="min-w-0 flex-1">
              <Autocomplete
                items={DTC_CATALOG}
                value={draft}
                onValueChange={setDraft}
                itemToStringValue={(entry) => entry.code}
                filter={matchesDtcQuery}
              >
                <AutocompleteInput
                  size="compact"
                  placeholder="Add a code, e.g. P0171"
                  className="font-mono *:placeholder:font-sans"
                  aria-label="New trouble code"
                  aria-invalid={candidate.length === 5 && !DTC_PATTERN.test(candidate)}
                  disabled={full}
                />
                <AutocompletePopup className="w-80">
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
            </div>
            <Button type="submit" size="compact" variant="outline" disabled={!canAdd}>
              Add
            </Button>
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={total === 0}
              title="Like a scan tool's Mode 04: clears every code and resets the counters."
              onClick={() => void clearDtcs({})}
            >
              Clear All
            </Button>
          </form>

          {full ? (
            <p className="text-subtle-foreground">Up to {MAX_DTCS_PER_MODE} codes per type.</p>
          ) : null}
        </div>
      ) : null}

      {counters.length > 0 ? (
        <section aria-label="Since codes cleared" className="mt-2 border-t pt-1">
          {counters.map((definition) => (
            <CounterRow
              key={definition.id}
              definition={definition}
              value={state.pids[definition.id] ?? definition.defaultValue}
            />
          ))}
        </section>
      ) : null}
    </InspectorGroup>
  );
}
