import {
  ReaderCommandError,
  ReaderConnectError,
  ReaderNotConnectedError,
  type PidId,
  type ReaderState,
  type ReaderTarget,
} from "@fme/contracts";
import { isCanProtocol, parseDtcReply, parsePidReply, parseVinReply } from "@fme/shared/elm327";
import { findPid } from "@fme/shared/pids";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SerialPorts from "../device/SerialPorts.ts";
import * as SimulatedDevice from "../device/SimulatedDevice.ts";
import * as TcpSockets from "../device/TcpSockets.ts";
import * as TrafficLog from "../traffic/TrafficLog.ts";
import * as ElmClient from "./ElmClient.ts";

const DEFAULT_WATCH: ReadonlyArray<PidId> = (["010C", "010D", "0105"] as const).map(
  (pid) => pid as PidId,
);
const POLL_PAUSE = "150 millis";
const IDLE_PAUSE = "1 second";

type OperationError = ReaderNotConnectedError | ReaderCommandError;

/**
 * Reads the emulator back through an ELM327-compatible OBD-II adapter plugged into its OBD
 * port, the way a scan tool or telematics device would see it.
 */
export class ObdReader extends Context.Service<
  ObdReader,
  {
    /** Current state first, then every change. */
    readonly state: Stream.Stream<ReaderState>;
    readonly connect: (target: ReaderTarget) => Effect.Effect<void, ReaderConnectError>;
    readonly disconnect: Effect.Effect<void>;
    /** Replaces the PIDs polled while connected. */
    readonly watch: (pids: ReadonlyArray<PidId>) => Effect.Effect<void>;
    readonly readDtcs: Effect.Effect<void, OperationError>;
    readonly readVin: Effect.Effect<void, OperationError>;
  }
>()("@fme/server/obd/ObdReader") {}

interface ActiveConnection {
  readonly id: number;
  readonly client: ElmClient.ElmClient;
  readonly scope: Scope.Closeable;
}

const initialState: ReaderState = {
  connection: { _tag: "disconnected" },
  watching: DEFAULT_WATCH,
  readings: {},
  vehicleResponding: false,
  dtcs: null,
  vin: null,
};

const make = Effect.gen(function* () {
  const serialPorts = yield* SerialPorts.SerialPorts;
  const tcpSockets = yield* TcpSockets.TcpSockets;
  const simulated = yield* SimulatedDevice.SimulatedDevice;
  const traffic = yield* TrafficLog.TrafficLog;
  const sessionScope = yield* Effect.scope;

  const state = yield* SubscriptionRef.make(initialState);
  const active = yield* Ref.make(Option.none<ActiveConnection>());
  const connectionIds = yield* Ref.make(0);
  const lock = yield* Semaphore.make(1);
  const update = (f: (current: ReaderState) => ReaderState) => SubscriptionRef.update(state, f);

  const closeActive = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(active, Option.none());
    if (Option.isSome(current)) yield* Scope.close(current.value.scope, Exit.void);
  });

  const onLinkLost = Effect.fn("ObdReader.onLinkLost")(
    function* (id: number) {
      const current = yield* Ref.get(active);
      if (Option.isNone(current) || current.value.id !== id) return;
      yield* closeActive;
      yield* update((s) =>
        s.connection._tag === "connected"
          ? {
              ...s,
              vehicleResponding: false,
              connection: {
                _tag: "failed",
                target: s.connection.target,
                reason: "The OBD-II adapter disconnected.",
              },
            }
          : s,
      );
    },
    // Forked into the service: closing the connection scope interrupts the reader running this.
    Effect.forkIn(sessionScope),
    Effect.asVoid,
  );

  const openLink = (target: ReaderTarget, scope: Scope.Scope) =>
    (target._tag === "simulated"
      ? simulated.openAdapter
      : target._tag === "serial"
        ? serialPorts.open(target.path)
        : tcpSockets.open(target.host, target.port)
    ).pipe(
      Scope.provide(scope),
      Effect.mapError(() => new ReaderConnectError({ target, reason: "open-failed" })),
    );

  const describeProtocol = (client: ElmClient.ElmClient) =>
    client.request("ATDPN", { quiet: true }).pipe(
      Effect.map((lines) => lines[0] ?? null),
      Effect.orElseSucceed(() => null),
    );

  // One poll per watched PID; per-PID work shares the loop's span instead of opening its own.
  const pollOnce = Effect.fnUntraced(function* (client: ElmClient.ElmClient) {
    const { watching, connection } = yield* SubscriptionRef.get(state);
    for (const pid of watching) {
      const reply = yield* client.query(pid, { quiet: true }).pipe(Effect.option);
      const at = yield* Clock.currentTimeMillis;
      const raw = Option.isSome(reply) ? parsePidReply(reply.value, pid) : undefined;
      const definition = findPid(pid);
      const current = yield* SubscriptionRef.get(state);
      const responding = Option.isSome(reply);
      const unchanged =
        current.vehicleResponding === responding &&
        (raw === undefined || current.readings[pid]?.raw.join() === raw.join());
      // Publishing only changes keeps a steady poll from flooding every client with state.
      if (unchanged) continue;
      yield* update((s) =>
        raw === undefined
          ? { ...s, vehicleResponding: responding }
          : {
              ...s,
              vehicleResponding: true,
              readings: {
                ...s.readings,
                [pid]: { value: definition?.decode(raw) ?? raw[0] ?? 0, raw, at },
              },
            },
      );
    }
    if (connection._tag === "connected" && connection.protocol === null) {
      const protocol = yield* describeProtocol(client);
      if (protocol !== null && protocol !== "A0" && protocol !== "0") {
        yield* update((s) =>
          s.connection._tag === "connected"
            ? { ...s, connection: { ...s.connection, protocol } }
            : s,
        );
      }
    }
    yield* Effect.sleep(watching.length > 0 ? POLL_PAUSE : IDLE_PAUSE);
  });

  const connect = Effect.fn("ObdReader.connect")(function* (target: ReaderTarget) {
    yield* Effect.annotateCurrentSpan("target", target._tag);
    yield* closeActive;
    yield* update((s) => ({
      ...initialState,
      watching: s.watching,
      connection: { _tag: "connecting", target },
    }));
    const id = yield* Ref.updateAndGet(connectionIds, (n) => n + 1);
    const scope = yield* Scope.make();

    const attempt = Effect.gen(function* () {
      const link = yield* openLink(target, scope);
      const client = yield* ElmClient.make(link, {
        onTraffic: (direction, text) => traffic.record("reader", direction, text),
        onLinkLost: () => onLinkLost(id),
      }).pipe(Scope.provide(scope));

      const identity = yield* client.request("ATZ").pipe(
        Effect.map((lines) => lines.find((line) => /ELM|OBD/i.test(line))),
        Effect.orElseSucceed(() => undefined),
      );
      if (identity === undefined) {
        return yield* new ReaderConnectError({ target, reason: "no-adapter" });
      }
      // Echo, line feeds and headers off; automatic protocol search.
      for (const command of ["ATE0", "ATL0", "ATS1", "ATH0", "ATSP0"]) {
        yield* client.request(command).pipe(Effect.ignore);
      }
      const searched = yield* client
        .query("0100", { timeout: ElmClient.SEARCH_TIMEOUT })
        .pipe(Effect.option);
      const protocol = Option.isSome(searched) ? yield* describeProtocol(client) : null;

      yield* Ref.set(active, Option.some({ id, client, scope }));
      yield* update((s) => ({
        ...s,
        vehicleResponding: Option.isSome(searched),
        connection: { _tag: "connected", target, adapter: identity, protocol },
      }));
      yield* Effect.forever(pollOnce(client)).pipe(Effect.forkIn(scope));
    });

    yield* attempt.pipe(
      Effect.tapError((error) =>
        Effect.andThen(
          Scope.close(scope, Exit.void),
          update((s) => ({ ...s, connection: { _tag: "failed", target, reason: error.message } })),
        ),
      ),
    );
  }, lock.withPermit);

  const disconnect = Effect.gen(function* () {
    yield* closeActive;
    yield* update((s) => ({
      ...s,
      vehicleResponding: false,
      connection: { _tag: "disconnected" },
    }));
  }).pipe(lock.withPermit, Effect.withSpan("ObdReader.disconnect"));

  const watch = Effect.fn("ObdReader.watch")(function* (pids: ReadonlyArray<PidId>) {
    yield* update((s) => ({ ...s, watching: pids }));
  });

  const currentClient = Effect.gen(function* () {
    const connection = yield* Ref.get(active);
    if (Option.isNone(connection)) return yield* new ReaderNotConnectedError();
    return connection.value.client;
  });

  const readDtcs = Effect.gen(function* () {
    const client = yield* currentClient;
    const lines = yield* client.query("03", { timeout: ElmClient.SEARCH_TIMEOUT });
    const { connection } = yield* SubscriptionRef.get(state);
    const protocol = connection._tag === "connected" ? connection.protocol : null;
    const dtcs = parseDtcReply(lines, 0x03, protocol === null || isCanProtocol(protocol));
    yield* update((s) => ({ ...s, dtcs }));
  }).pipe(Effect.withSpan("ObdReader.readDtcs"));

  const readVin = Effect.gen(function* () {
    const client = yield* currentClient;
    const lines = yield* client.query("0902", { timeout: ElmClient.SEARCH_TIMEOUT });
    yield* update((s) => ({ ...s, vin: parseVinReply(lines) ?? null }));
  }).pipe(Effect.withSpan("ObdReader.readVin"));

  return ObdReader.of({
    state: SubscriptionRef.changes(state),
    connect,
    disconnect,
    watch,
    readDtcs,
    readVin,
  });
});

export const layer = Layer.effect(ObdReader, make);
