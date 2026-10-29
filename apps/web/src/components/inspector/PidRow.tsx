import type { PidDefinition } from "@fme/shared/pids";
import { useId } from "react";
import { usePidControl } from "~/components/emulator/pidControl";
import { PropertyRow } from "~/components/shell/PropertyRow";
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldStepper,
} from "~/components/ui/number-field";
import { Slider } from "~/components/ui/slider";

/** A PID's exact value with its unit, committed on Enter, blur or a step. */
function PidField({
  id,
  definition,
  value,
  onCommit,
}: {
  id: string;
  definition: PidDefinition;
  value: number;
  onCommit: (value: number) => void;
}) {
  return (
    <NumberField
      id={id}
      value={value}
      min={definition.min}
      max={definition.max}
      step={definition.step}
      size="sm"
      className="w-23 shrink-0"
      onValueCommitted={(next) => {
        if (next !== null) onCommit(next);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldInput
          className="pe-1 text-right font-mono text-xs"
          aria-label={`${definition.name} value`}
        />
        {definition.unit !== "" ? (
          <span className="flex items-center whitespace-nowrap pe-1.5 text-2xs text-subtle-foreground">
            {definition.unit}
          </span>
        ) : null}
        <NumberFieldStepper />
      </NumberFieldGroup>
    </NumberField>
  );
}

/** The PID's name, truncated with the full name on hover, as a property row label. */
const nameLabel = (definition: PidDefinition) => (
  <span title={definition.name}>{definition.name}</span>
);

/** A Mode 01 PID: a small slider for quick moves and a field for the exact value. */
export function PidRow({ definition, value }: { definition: PidDefinition; value: number }) {
  const { shown, change, commit } = usePidControl(definition, value);
  const id = useId();
  return (
    <PropertyRow label={nameLabel(definition)} code={definition.id} htmlFor={id}>
      <div className="w-12">
        <Slider
          size="sm"
          variant="neutral"
          aria-label={definition.name}
          min={definition.min}
          max={definition.max}
          step={definition.step}
          value={shown}
          onValueChange={change}
          onValueCommitted={(next) => void commit(next)}
        />
      </div>
      <PidField
        id={id}
        definition={definition}
        value={shown}
        onCommit={(next) => void commit(next)}
      />
    </PropertyRow>
  );
}

/** A counter PID: only the exact value, since a slider over 0–65535 says nothing. */
export function CounterRow({ definition, value }: { definition: PidDefinition; value: number }) {
  const { shown, commit } = usePidControl(definition, value);
  const id = useId();
  return (
    <PropertyRow label={nameLabel(definition)} htmlFor={id}>
      <PidField
        id={id}
        definition={definition}
        value={shown}
        onCommit={(next) => void commit(next)}
      />
    </PropertyRow>
  );
}
