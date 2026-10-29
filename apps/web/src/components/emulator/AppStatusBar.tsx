import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { StatusBar, StatusBarItem, StatusBarSpacer } from "~/components/shell/StatusBar";
import { StatusDot } from "~/components/shell/StatusDot";
import { protocolLabel } from "~/lib/protocols";
import { lastAck } from "~/lib/traffic";
import { trafficAtom } from "~/rpc/atoms";
import { useEmulatorState, useReaderState } from "~/rpc/hooks";
import { connectionTone, useEmulatorTarget } from "./ConnectionControls";
import { useFirmware } from "./Firmware";

function AdapterItem() {
  const reader = useReaderState();
  const connection = reader?.connection;
  if (connection === undefined || connection._tag === "disconnected") {
    return <StatusBarItem>Adapter not connected</StatusBarItem>;
  }
  const target = connection.target;
  const where =
    target._tag === "serial"
      ? target.path.replace("/dev/", "")
      : target._tag === "tcp"
        ? `${target.host}:${target.port}`
        : "Simulated";
  return (
    <StatusBarItem>
      Adapter <code>{where}</code>
      {connection._tag === "connected" ? ` · ${connection.adapter}` : ""}
      {connection._tag === "connecting" ? " · connecting…" : ""}
      {connection._tag === "failed" ? " · failed" : ""}
    </StatusBarItem>
  );
}

export function AppStatusBar({ showAdapter }: { showAdapter: boolean }) {
  const { state } = useEmulatorState();
  const target = useEmulatorTarget();
  const firmware = useFirmware();
  const trafficResult = useAtomValue(trafficAtom);
  const ack = lastAck(AsyncResult.isSuccess(trafficResult) ? trafficResult.value : []);
  const serial = !target.simulated;

  return (
    <StatusBar>
      <StatusBarItem>
        <StatusDot tone={connectionTone(target.connection, target.serverReachable)} />
        <code>{target.label}</code>
      </StatusBarItem>
      {serial ? <StatusBarItem>38400 baud · 8N1</StatusBarItem> : null}
      {state !== null ? <StatusBarItem>{protocolLabel(state.protocol)}</StatusBarItem> : null}
      {firmware.info.version !== null ? (
        <StatusBarItem>Firmware V{firmware.info.version}</StatusBarItem>
      ) : null}
      {showAdapter ? <AdapterItem /> : null}
      <StatusBarSpacer />
      {ack !== null ? (
        <StatusBarItem className="max-desktop:hidden">
          Last ack <code className="truncate">{ack.command}</code>
          <span className="text-success-foreground">OK</span>
          {ack.latencyMs} ms
        </StatusBarItem>
      ) : null}
    </StatusBar>
  );
}
