import { MAX_DTCS_PER_MODE, type DtcCode, type DtcMode } from "@fme/contracts";
import { PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { clearDtcsAtom, setDtcsAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { Panel } from "./Panel";

const MODES: ReadonlyArray<{ mode: DtcMode; label: string; hint: string }> = [
  {
    mode: "03",
    label: "Stored",
    hint: "Mode 03. Lights the MIL and sets the code count in PID 0101.",
  },
  { mode: "07", label: "Pending", hint: "Mode 07. Only J1850 firmware supports it." },
  { mode: "0A", label: "Permanent", hint: "Mode 0A. Only J1850 firmware supports it." },
];

const DTC_PATTERN = /^[PCBU][0-3][0-9A-F]{3}$/;

export function DtcPanel() {
  const { state } = useEmulatorState();
  const setDtcs = useCommand(setDtcsAtom);
  const clearDtcs = useCommand(clearDtcsAtom);
  const [mode, setMode] = useState<DtcMode>("03");
  const [draft, setDraft] = useState("");
  if (state === null) return null;

  const codes = state.dtcs[mode];
  const stored = state.dtcs["03"].length;
  const candidate = draft.trim().toUpperCase();
  const canAdd =
    DTC_PATTERN.test(candidate) &&
    !codes.includes(candidate as DtcCode) &&
    codes.length < MAX_DTCS_PER_MODE;
  const allCount = state.dtcs["03"].length + state.dtcs["07"].length + state.dtcs["0A"].length;

  const add = async () => {
    if (!canAdd) return;
    if (await setDtcs({ mode, codes: [...codes, candidate as DtcCode] })) setDraft("");
  };

  return (
    <Panel.Root>
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
            <ToggleGroupItem key={m.mode} value={m.mode} size="sm">
              {m.label}
              {state.dtcs[m.mode].length > 0 ? ` (${state.dtcs[m.mode].length})` : ""}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-muted-foreground text-xs">{MODES.find((m) => m.mode === mode)?.hint}</p>

        <ul className="flex min-h-8 flex-wrap gap-1.5" aria-label="Active codes">
          {codes.length === 0 ? (
            <li className="text-muted-foreground text-sm">No codes set.</li>
          ) : null}
          {codes.map((code) => (
            <li key={code}>
              <Badge variant="outline" size="lg" className="font-mono">
                {code}
                <button
                  type="button"
                  className="-me-1 rounded-sm opacity-60 hover:opacity-100"
                  aria-label={`Remove ${code}`}
                  onClick={() => void setDtcs({ mode, codes: codes.filter((c) => c !== code) })}
                >
                  <XIcon className="size-3.5" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="P0300"
            maxLength={5}
            className="font-mono uppercase"
            aria-label="New trouble code"
            aria-invalid={candidate.length === 5 && !DTC_PATTERN.test(candidate)}
          />
          <Button type="submit" variant="outline" disabled={!canAdd}>
            <PlusIcon />
            Add
          </Button>
        </form>
        <p className="text-muted-foreground text-xs">Up to {MAX_DTCS_PER_MODE} codes per mode.</p>
      </Panel.Body>
    </Panel.Root>
  );
}
