import type { EmulatorState } from "@fme/contracts";
import type { PidGroup } from "@fme/shared/pids";
import { InspectorGroup, useInspectorFilter } from "~/components/shell/Inspector";
import { useEmulatorState } from "~/rpc/hooks";
import { INSPECTOR_PID_GROUPS, filterGroupRows, pidWords, pidsInGroup } from "./model";
import { PidRow } from "./PidRow";

const OPEN_BY_DEFAULT: ReadonlySet<PidGroup> = new Set(["Temperatures", "Air & fuel"]);

function PidGroupSection({ group, values }: { group: PidGroup; values: EmulatorState["pids"] }) {
  const filter = useInspectorFilter();
  const all = pidsInGroup(group);
  const { rows, keywords } = filterGroupRows(filter, group, all, pidWords);
  return (
    <InspectorGroup
      id={`pids-${group.toLowerCase().replace(/[^a-z]+/g, "-")}`}
      title={group}
      keywords={keywords}
      defaultOpen={OPEN_BY_DEFAULT.has(group)}
      summary={
        rows.length < all.length ? `${rows.length} of ${all.length} PIDs` : `${all.length} PIDs`
      }
    >
      {rows.map((definition) => (
        <PidRow
          key={definition.id}
          definition={definition}
          value={values[definition.id] ?? definition.defaultValue}
        />
      ))}
    </InspectorGroup>
  );
}

/** One inspector group per PID category. */
export function PidGroups() {
  const { state } = useEmulatorState();
  if (state === null) return null;
  return INSPECTOR_PID_GROUPS.map((group) => (
    <PidGroupSection key={group} group={group} values={state.pids} />
  ));
}
