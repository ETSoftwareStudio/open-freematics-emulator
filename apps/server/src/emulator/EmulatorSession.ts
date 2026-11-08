import {
  EmulatorCommandError,
  EmulatorConnectError,
  EmulatorNotConnectedError,
  type ConnectTarget,
  type DeviceInfo,
  type DtcCode,
  type DtcMode,
  type EmulatorState,
  type ObdProtocol,
  type PidId,
  type Preset,
  type ReadinessMonitorId,
  type SerialPortInfo,
  type SerialPortListError,
  type UnsentEdit,
} from "@fme/contracts";
import { AT } from "@fme/shared/atCommands";
import { makeDefaultState } from "@fme/shared/defaultState";
import { PIDS_RESET_BY_CLEAR } from "@fme/shared/dtcs";
import { clampPidValue, findPid } from "@fme/shared/pids";
import { encodeMonitorStatus } from "@fme/shared/readiness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import * as AtClient from "./AtClient.ts";

const DTC_MODES: ReadonlyArray<DtcMode> = ["03", "07", "0A"];
const PROBE_DTC = "P0000" as DtcCode;

type OperationError = EmulatorNotConnectedError | EmulatorCommandError;

export class EmulatorSession extends Context.Service<
  EmulatorSession,
  {
    /** Current state first, then every change. */
    readonly state: Stream.Stream<EmulatorState>;
    readonly listPorts: Effect.Effect<ReadonlyArray<SerialPortInfo>, SerialPortListError>;
    readonly connect: (target: ConnectTarget) => Effect.Effect<void, EmulatorConnectError>;
    readonly disconnect: Effect.Effect<void>;
    /**
     * Setters apply to the device when connected. While disconnected they only change the
     * state, which is pushed to the device on the next connect.
     */
    readonly setIgnition: (on: boolean) => Effect.Effect<void, OperationError>;
    readonly setProtocol: (protocol: ObdProtocol) => Effect.Effect<void, OperationError>;
    readonly setVinEnabled: (enabled: boolean) => Effect.Effect<void, OperationError>;
    readonly setVin: (vin: string) => Effect.Effect<void, OperationError>;
    readonly setCalibrationId: (calibrationId: string) => Effect.Effect<void, OperationError>;
    readonly setPid: (pid: PidId, value: number) => Effect.Effect<void, OperationError>;
    /**
     * Sets the preset's PIDs in its order and records it as the last preset. If a command
     * fails, the PIDs the device acknowledged stay set and the last preset is unchanged.
     */
    readonly applyPreset: (preset: Preset) => Effect.Effect<void, OperationError>;
    readonly setDtcs: (
      mode: DtcMode,
      codes: ReadonlyArray<DtcCode>,
    ) => Effect.Effect<void, OperationError>;
    readonly clearDtcs: Effect.Effect<void, OperationError>;
    readonly setReadiness: (
      monitor: ReadinessMonitorId,
      monitorState: { readonly supported: boolean; readonly complete: boolean },
    ) => Effect.Effect<void, OperationError>;
    readonly sendRaw: (command: string) => Effect.Effect<ReadonlyArray<string>, OperationError>;
  }
>()("@fme/server/emulator/EmulatorSession") {}

interface ActiveConnection {
  readonly id: number;
  readonly client: AtClient.AtClient;
  readonly scope: Scope.Closeable;
}

const pidCommand = (pid: PidId, value: number) => {
  const definition = findPid(pid);
  // Raw bytes: the firmware's decimal conversion truncates, rejects negatives, and
  // mis-converts 015E.
  return definition === undefined
    ? AT.setPidDecimal(pid, value)
    : AT.setPidRaw(pid, definition.encode(value));
};

const monitorStatusCommand = (state: EmulatorState) =>
  AT.setPidRaw("0101" as PidId, encodeMonitorStatus(state.readiness, state.dtcs["03"].length));

const parseDeviceInfo = (lines: ReadonlyArray<string>): DeviceInfo | null => {
  const banner = lines.find((line) => /EMULATOR/i.test(line));
  if (banner === undefined) return null;
  return { banner, details: lines.find((line) => line.includes(",")) ?? null };
};

const make = Effect.gen(function* () {
  const serialPorts = yield* SerialPorts.SerialPorts;
  const simulated = yield* SimulatedDevice.SimulatedDevice;
  const traffic = yield* TrafficLog.TrafficLog;
  const sessionScope = yield* Effect.scope;

  const state = yield* SubscriptionRef.make(makeDefaultState());
  const active = yield* Ref.make(Option.none<ActiveConnection>());
  const connectionIds = yield* Ref.make(0);
  // Connect, disconnect and setters run one at a time so a connect never races a setter.
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermit;

  const recordTraffic = (direction: "tx" | "rx", text: string) =>
    traffic.record("emulator", direction, text);

  const update = (f: (current: EmulatorState) => EmulatorState) => SubscriptionRef.update(state, f);

  const closeActive = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(active, Option.none());
    if (Option.isSome(current)) yield* Scope.close(current.value.scope, Exit.void);
  });

  const onLinkLost = Effect.fn("EmulatorSession.onLinkLost")(
    function* (id: number) {
      const current = yield* Ref.get(active);
      if (Option.isNone(current) || current.value.id !== id) return;
      yield* closeActive;
      yield* update((s) =>
        s.connection._tag === "connected"
          ? {
              ...s,
              connection: {
                _tag: "failed",
                target: s.connection.target,
                reason: "The device disconnected.",
              },
            }
          : s,
      );
    },
    // Forked into the session: closing the connection scope interrupts the reader running this.
    Effect.forkIn(sessionScope),
    Effect.asVoid,
  );

  const openLink = (target: ConnectTarget, scope: Scope.Scope) =>
    (target._tag === "simulated" ? simulated.open : serialPorts.open(target.path)).pipe(
      Scope.provide(scope),
      Effect.mapError(() => new EmulatorConnectError({ target, reason: "open-failed" })),
    );

  /**
   * Finds which DTC modes the firmware takes by setting a throwaway code in each. Runs right
   * after ATZ, and the codes it leaves are cleared before the real state is pushed.
   */
  const probeDtcModes = Effect.fn("EmulatorSession.probeDtcModes")(function* (
    client: AtClient.AtClient,
  ) {
    const accepted: Array<DtcMode> = ["03"];
    for (const mode of DTC_MODES.filter((m) => m !== "03")) {
      const ok = yield* client.command(AT.setDtcs(mode, [PROBE_DTC])).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason === "rejected",
          () => Effect.succeed(false),
        ),
      );
      if (ok) accepted.push(mode);
    }
    if (accepted.length > 1) yield* client.command(AT.clearDtcs);
    return accepted;
  });

  const pushState = Effect.fn("EmulatorSession.pushState")(function* (
    client: AtClient.AtClient,
    desired: EmulatorState,
    dtcModes: ReadonlyArray<DtcMode>,
  ) {
    yield* client.command(AT.setProtocol(desired.protocol));
    yield* client.command(AT.ignition(desired.ignition));
    yield* client.command(AT.vinResponse(desired.vinEnabled));
    if (desired.vin !== null) yield* client.command(AT.setVin(desired.vin));
    if (desired.calibrationId !== null) {
      yield* client.command(AT.setCalibrationId(desired.calibrationId)).pipe(Effect.ignore);
    }
    // Edits staged offline that this firmware can't take are dropped and reported.
    const unsent: Array<UnsentEdit> = [];
    const acceptedDtcs = { ...desired.dtcs };
    for (const mode of DTC_MODES) {
      const codes = desired.dtcs[mode];
      if (codes.length === 0) continue;
      if (!dtcModes.includes(mode)) {
        acceptedDtcs[mode] = [];
        unsent.push({ _tag: "dtcs", mode, codes });
        continue;
      }
      yield* client.command(AT.setDtcs(mode, codes));
    }
    for (const [pid, value] of Object.entries(desired.pids)) {
      yield* client.command(pidCommand(pid as PidId, value));
    }
    const pushed = { ...desired, dtcs: acceptedDtcs };
    yield* client.command(monitorStatusCommand(pushed));
    const vin = yield* client.query(AT.getVin).pipe(Effect.option);
    const calibrationId = Option.getOrNull(
      yield* client.query(AT.getCalibrationId).pipe(Effect.option),
    );
    // As the official GUI does: CALID is supported when the firmware answers ATGET CALID.
    const capabilities = { dtcModes, calibrationId: calibrationId !== null };
    if (desired.calibrationId !== null && !capabilities.calibrationId) {
      unsent.push({ _tag: "calibrationId", calibrationId: desired.calibrationId });
    }
    return {
      // Without a readback, the VIN is the one the device acknowledged above, if any.
      state: {
        ...pushed,
        vin: Option.getOrElse(vin, () => desired.vin),
        calibrationId,
        capabilities,
      },
      unsent,
    };
  });

  const connect = Effect.fn("EmulatorSession.connect")(
    function* (target: ConnectTarget) {
      yield* Effect.annotateCurrentSpan("target", target._tag);
      yield* closeActive;
      yield* update((s) => ({ ...s, connection: { _tag: "connecting", target } }));

      const id = yield* Ref.updateAndGet(connectionIds, (n) => n + 1);
      const scope = yield* Scope.make();
      const attempt = Effect.gen(function* () {
        const link = yield* openLink(target, scope);
        const client = yield* AtClient.make(link, {
          onTraffic: recordTraffic,
          onLinkLost: () => onLinkLost(id),
        }).pipe(Scope.provide(scope));

        // ATZ gives us the firmware banner and a clean slate; older firmware may stay silent.
        const resetLines = yield* client.reset.pipe(Effect.orElseSucceed(() => []));
        yield* client.command(AT.echo(false)).pipe(Effect.ignore);
        yield* client.command(AT.debugOutput(false)).pipe(
          Effect.retry({ times: 2, schedule: Schedule.spaced("200 millis") }),
          Effect.mapError(() => new EmulatorConnectError({ target, reason: "no-handshake" })),
        );
        const desired = yield* SubscriptionRef.get(state);
        const pushed = yield* probeDtcModes(client).pipe(
          Effect.flatMap((dtcModes) => pushState(client, desired, dtcModes)),
          Effect.mapError(() => new EmulatorConnectError({ target, reason: "setup-failed" })),
        );
        yield* Ref.set(active, Option.some({ id, client, scope }));
        yield* update((s) => ({
          ...pushed.state,
          pids: { ...s.pids, ...pushed.state.pids },
          connection: {
            _tag: "connected",
            target,
            device: parseDeviceInfo(resetLines),
            unsent: pushed.unsent,
          },
        }));
      });

      yield* attempt.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void),
        ),
        Effect.tapError((error) =>
          update((s) => ({
            ...s,
            connection: { _tag: "failed", target, reason: error.message },
          })),
        ),
      );
    },
    // A caller that gives up halfway leaves the old connection closed and no new one.
    Effect.onInterrupt(() =>
      Effect.andThen(
        closeActive,
        update((s) => ({ ...s, connection: { _tag: "disconnected" } })),
      ),
    ),
    locked,
  );

  const disconnect = Effect.gen(function* () {
    yield* closeActive;
    yield* update((s) => ({ ...s, connection: { _tag: "disconnected" } }));
  }).pipe(Effect.withSpan("EmulatorSession.disconnect"));

  /** Sends commands when connected, then applies `next` to the state. */
  const apply = Effect.fn("EmulatorSession.apply")(function* (
    commands: (current: EmulatorState) => ReadonlyArray<string>,
    next: (current: EmulatorState) => EmulatorState,
  ) {
    const current = yield* SubscriptionRef.get(state);
    const connection = yield* Ref.get(active);
    if (Option.isSome(connection)) {
      for (const command of commands(current)) {
        yield* connection.value.client.command(command);
      }
    }
    yield* update(next);
  });

  const withDtcs = (current: EmulatorState, dtcs: EmulatorState["dtcs"]) => ({ ...current, dtcs });

  const setDtcs = Effect.fn("EmulatorSession.setDtcs")(function* (
    mode: DtcMode,
    codes: ReadonlyArray<DtcCode>,
  ) {
    yield* apply(
      (current) => {
        const next = withDtcs(current, { ...current.dtcs, [mode]: codes });
        if (codes.length > 0) return [AT.setDtcs(mode, codes), monitorStatusCommand(next)];
        // The firmware can only clear every mode at once, so restore the others after.
        return [
          AT.clearDtcs,
          ...DTC_MODES.filter((m) => m !== mode && current.dtcs[m].length > 0).map((m) =>
            AT.setDtcs(m, current.dtcs[m]),
          ),
          monitorStatusCommand(next),
        ];
      },
      (current) => withDtcs(current, { ...current.dtcs, [mode]: codes }),
    );
  }, locked);

  // Like a scan tool's Mode 04: codes go, and so do the MIL-on and since-cleared counters.
  const cleared = (current: EmulatorState): EmulatorState => ({
    ...withDtcs(current, { "03": [], "07": [], "0A": [] }),
    pids: { ...current.pids, ...Object.fromEntries(PIDS_RESET_BY_CLEAR.map((pid) => [pid, 0])) },
  });
  const clearDtcs = apply(
    (current) => [
      AT.clearDtcs,
      ...PIDS_RESET_BY_CLEAR.map((pid) => pidCommand(pid, 0)),
      monitorStatusCommand(cleared(current)),
    ],
    cleared,
  ).pipe(Effect.withSpan("EmulatorSession.clearDtcs"));

  const clampFor = (pid: PidId, value: number) => {
    const definition = findPid(pid);
    return definition === undefined ? value : clampPidValue(definition, value);
  };

  // Other PID edits keep `lastPreset`: the UI shows them as edits to it.
  const setPid = Effect.fn("EmulatorSession.setPid")(function* (pid: PidId, value: number) {
    yield* Effect.annotateCurrentSpan("pid", pid);
    const clamped = clampFor(pid, value);
    yield* apply(
      () => [pidCommand(pid, clamped)],
      (current) => ({ ...current, pids: { ...current.pids, [pid]: clamped } }),
    );
  }, locked);

  const applyPreset = Effect.fn("EmulatorSession.applyPreset")(function* (preset: Preset) {
    yield* Effect.annotateCurrentSpan("preset", preset.id);
    const values = Object.entries(preset.pids).map(
      ([pid, value]) => [pid as PidId, clampFor(pid as PidId, value)] as const,
    );
    const withPids = (current: EmulatorState, set: ReadonlyArray<readonly [PidId, number]>) => ({
      ...current,
      pids: { ...current.pids, ...Object.fromEntries(set) },
    });
    const connection = yield* Ref.get(active);
    if (Option.isSome(connection)) {
      const { client } = connection.value;
      const acknowledged: Array<readonly [PidId, number]> = [];
      yield* Effect.gen(function* () {
        for (const entry of values) {
          yield* client.command(pidCommand(...entry));
          acknowledged.push(entry);
        }
      }).pipe(Effect.onError(() => update((current) => withPids(current, acknowledged))));
    }
    yield* update((current) => ({
      ...withPids(current, values),
      lastPreset: { id: preset.id, name: preset.name },
    }));
  }, locked);

  const setReadiness = Effect.fn("EmulatorSession.setReadiness")(function* (
    monitor: ReadinessMonitorId,
    monitorState: { readonly supported: boolean; readonly complete: boolean },
  ) {
    const next = (current: EmulatorState) => ({
      ...current,
      readiness: { ...current.readiness, [monitor]: monitorState },
    });
    yield* apply((current) => [monitorStatusCommand(next(current))], next);
  }, locked);

  const sendRaw = Effect.fn("EmulatorSession.sendRaw")(function* (command: string) {
    const connection = yield* Ref.get(active);
    if (Option.isNone(connection)) return yield* new EmulatorNotConnectedError();
    return yield* connection.value.client.raw(command);
  }, locked);

  const setter = <A>(
    name: string,
    commands: (value: A) => ReadonlyArray<string>,
    next: (state: EmulatorState, value: A) => EmulatorState,
  ) =>
    Effect.fn(name)(function* (value: A) {
      yield* apply(
        () => commands(value),
        (s) => next(s, value),
      );
    }, locked);

  return EmulatorSession.of({
    state: SubscriptionRef.changes(state),
    listPorts: serialPorts.list,
    connect,
    disconnect: locked(disconnect),
    setIgnition: setter(
      "EmulatorSession.setIgnition",
      (on: boolean) => [AT.ignition(on)],
      (s, ignition) => ({ ...s, ignition }),
    ),
    setProtocol: setter(
      "EmulatorSession.setProtocol",
      (protocol: ObdProtocol) => [AT.setProtocol(protocol)],
      (s, protocol) => ({ ...s, protocol }),
    ),
    setVinEnabled: setter(
      "EmulatorSession.setVinEnabled",
      (enabled: boolean) => [AT.vinResponse(enabled)],
      (s, vinEnabled) => ({ ...s, vinEnabled }),
    ),
    setVin: setter(
      "EmulatorSession.setVin",
      (vin: string) => [AT.setVin(vin)],
      (s, vin) => ({ ...s, vin }),
    ),
    setCalibrationId: setter(
      "EmulatorSession.setCalibrationId",
      (calibrationId: string) => [AT.setCalibrationId(calibrationId)],
      (s, calibrationId) => ({ ...s, calibrationId }),
    ),
    setPid,
    applyPreset,
    setDtcs,
    clearDtcs: locked(clearDtcs),
    setReadiness,
    sendRaw,
  });
});

export const layer = Layer.effect(EmulatorSession, make);
