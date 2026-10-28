import {
  READINESS_MONITOR_IDS,
  READINESS_MONITORS,
  encodeMonitorStatus,
} from "@fme/shared/readiness";
import { formatHexBytes } from "@fme/shared/atCommands";
import { Checkbox } from "~/components/ui/checkbox";
import { Switch } from "~/components/ui/switch";
import { setReadinessAtom } from "~/rpc/atoms";
import { useCommand, useEmulatorState } from "~/rpc/hooks";
import { Panel } from "./Panel";

export function ReadinessPanel() {
  const { state } = useEmulatorState();
  const setReadiness = useCommand(setReadinessAtom);
  if (state === null) return null;
  const status = encodeMonitorStatus(state.readiness, state.dtcs["03"].length);

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.Title>Readiness monitors</Panel.Title>
        <Panel.Actions>
          <span className="font-mono text-2xs text-muted-foreground">
            0101 · {formatHexBytes(status)}
          </span>
        </Panel.Actions>
      </Panel.Header>
      <Panel.Body className="py-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground text-xs">
              <th className="py-1.5 font-normal">Monitor</th>
              <th className="py-1.5 text-center font-normal">Supported</th>
              <th className="py-1.5 text-center font-normal">Complete</th>
            </tr>
          </thead>
          <tbody>
            {READINESS_MONITOR_IDS.map((id) => {
              const monitor = state.readiness[id];
              return (
                <tr key={id} className="border-t">
                  <td className="py-1.5">{READINESS_MONITORS[id].label}</td>
                  <td className="py-1.5 text-center">
                    <Switch
                      checked={monitor.supported}
                      aria-label={`${READINESS_MONITORS[id].label} supported`}
                      onCheckedChange={(supported) =>
                        void setReadiness({ monitor: id, supported, complete: monitor.complete })
                      }
                    />
                  </td>
                  <td className="py-1.5 text-center">
                    <Checkbox
                      checked={monitor.complete}
                      disabled={!monitor.supported}
                      aria-label={`${READINESS_MONITORS[id].label} complete`}
                      onCheckedChange={(complete) =>
                        void setReadiness({ monitor: id, supported: monitor.supported, complete })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel.Body>
    </Panel.Root>
  );
}
