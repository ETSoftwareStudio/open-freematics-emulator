/**
 * Drives every control over the WebSocket RPC against a real MK2, reads each value back with
 * `ATGET`, and restores the state. `--reader <path|host:port>` also checks an attached adapter.
 * Usage: node apps/server/scripts/hardware-check.ts [--url ws://…/ws] [--port …] [--reader …]
 */
// @effect-diagnostics preferSchemaOverJson:off - prints arbitrary payloads for a human.
import * as NodeUtil from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  WS_METHODS,
  WsRpcGroup,
  type DtcCode,
  type EmulatorState,
  type PidId,
  type ReaderState,
  type ReaderTarget,
  type Vin,
} from "@fme/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const { values } = NodeUtil.parseArgs({
  options: {
    url: { type: "string", default: "ws://127.0.0.1:3738/ws" },
    port: { type: "string" },
    reader: { type: "string" },
  },
});

const ProtocolLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(values.url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup, { flatten: true });
  const state = client(WS_METHODS.subscribeState, undefined);
  const currentState = state.pipe(Stream.runHead, Effect.flatMap(Effect.fromOption));
  const readBack = (command: string) =>
    client(WS_METHODS.sendRaw, { command }).pipe(Effect.map(({ lines }) => lines.join(" | ")));

  const ports = yield* client(WS_METHODS.listPorts, undefined);
  const path = values.port ?? ports.find((port) => port.likelyEmulator)?.path;
  if (path === undefined)
    return yield* Effect.fail(`No emulator port found in ${JSON.stringify(ports)}`);
  yield* Console.log(`Connecting to ${path}`);
  yield* client(WS_METHODS.connect, { target: { _tag: "serial", path } });
  const connected: EmulatorState = yield* currentState;
  yield* Console.log(`Connected: ${JSON.stringify(connected.connection)}`);
  const originalVin = connected.vin;

  const results: Array<{ check: string; ok: boolean; detail: string }> = [];
  const check = Effect.fn("check")(function* <A, E>(
    name: string,
    run: Effect.Effect<A, E>,
    query: string,
    expected: string,
  ) {
    const outcome = yield* run.pipe(Effect.result);
    const actual = yield* readBack(query);
    const ok = outcome._tag === "Success" && actual === expected;
    results.push({
      check: name,
      ok,
      detail: ok ? actual : `expected "${expected}", got "${actual}" (${outcome._tag})`,
    });
  });
  const setPid = (pid: string, value: number) =>
    client(WS_METHODS.setPid, { pid: pid as PidId, value });

  // Expected bytes are SAE J1979 values worked out by hand, not from the app's encoders.
  yield* check("RPM 2500", setPid("010C", 2500), "ATGET 010C", "010C=27 10");
  yield* check("Speed 88 km/h", setPid("010D", 88), "ATGET 010D", "010D=58");
  yield* check("Coolant 90 °C", setPid("0105", 90), "ATGET 0105", "0105=82");
  yield* check("Coolant -10 °C", setPid("0105", -10), "ATGET 0105", "0105=1E");
  yield* check("Timing -20°", setPid("010E", -20), "ATGET 010E", "010E=58");
  yield* check("Throttle 100%", setPid("0111", 100), "ATGET 0111", "0111=FF");
  yield* check("Load 50%", setPid("0104", 50), "ATGET 0104", "0104=80");
  yield* check("Fuel rate 20 L/h", setPid("015E", 20), "ATGET 015E", "015E=01 90");
  yield* check("Voltage 13.8 V", setPid("0142", 13.8), "ATGET 0142", "0142=35 E8");
  yield* check("Torque -50%", setPid("0161", -50), "ATGET 0161", "0161=4B");
  yield* check(
    "Mode 03 DTCs light the MIL",
    client(WS_METHODS.setDtcs, { mode: "03", codes: ["P0105", "P0300"] as Array<DtcCode> }),
    "ATGET 0101",
    "0101=82 07 FF 00",
  );
  yield* check(
    "Misfire monitor incomplete",
    client(WS_METHODS.setReadiness, { monitor: "misfire", supported: true, complete: false }),
    "ATGET 0101",
    "0101=82 17 FF 00",
  );
  yield* check(
    "EGR monitor unsupported",
    client(WS_METHODS.setReadiness, { monitor: "egrSystem", supported: false, complete: true }),
    "ATGET 0101",
    "0101=82 17 7F 00",
  );
  yield* check("Clear DTCs", client(WS_METHODS.clearDtcs, {}), "ATGET 0101", "0101=00 17 7F 00");
  yield* check(
    "VIN",
    client(WS_METHODS.setVin, { vin: "WVWZZZ1JZXW000001" as Vin }),
    "ATGET VIN",
    "WVWZZZ1JZXW000001",
  );
  yield* check("Ignition off", client(WS_METHODS.setIgnition, { on: false }), "ATACC0", "OK");
  yield* check("Ignition on", client(WS_METHODS.setIgnition, { on: true }), "ATACC1", "OK");
  yield* check(
    "Protocol CAN 29-bit",
    client(WS_METHODS.setProtocol, { protocol: "CAN_29B_500K" }),
    "ATBUS CAN_29B_500K",
    "OK",
  );
  const pending =
    connected.connection._tag === "connected" ? connected.connection.capabilities : null;
  const mode07 = yield* client(WS_METHODS.setDtcs, {
    mode: "07",
    codes: ["P0300"] as Array<DtcCode>,
  }).pipe(Effect.result);
  const expectsMode07 = pending?.dtcModes.includes("07") ?? false;
  results.push({
    check: `Mode 07 ${expectsMode07 ? "accepted" : "rejected"} as the probe found`,
    ok: (mode07._tag === "Success") === expectsMode07,
    detail: mode07._tag === "Success" ? "accepted" : mode07.failure._tag,
  });
  if (mode07._tag === "Success") yield* client(WS_METHODS.setDtcs, { mode: "07", codes: [] });

  const after: EmulatorState = yield* currentState;
  results.push({
    check: "Server state mirrors the device",
    ok: after.pids["010C" as PidId] === 2500 && after.readiness.misfire.complete === false,
    detail: `010C=${after.pids["010C" as PidId]}`,
  });

  // Restore what the check changed.
  yield* client(WS_METHODS.setProtocol, { protocol: "CAN_11B_500K" });
  yield* client(WS_METHODS.setReadiness, { monitor: "misfire", supported: true, complete: true });
  yield* client(WS_METHODS.setReadiness, { monitor: "egrSystem", supported: true, complete: true });
  if (originalVin !== null) yield* client(WS_METHODS.setVin, { vin: originalVin as Vin });

  if (values.reader !== undefined) {
    const [, host, port] = /^([\w.-]+):(\d+)$/.exec(values.reader) ?? [];
    const target: ReaderTarget =
      host !== undefined && port !== undefined
        ? { _tag: "tcp", host, port: Number(port) }
        : { _tag: "serial", path: values.reader };
    const readerState = client(WS_METHODS.readerSubscribeState, undefined);
    const readerWhere = (predicate: (state: ReaderState) => boolean) =>
      readerState.pipe(
        Stream.filter(predicate),
        Stream.runHead,
        Effect.timeoutOption("20 seconds"),
        Effect.map(Option.flatten),
      );
    yield* Console.log(`Connecting the OBD-II adapter at ${values.reader}`);
    const connectedReader = yield* client(WS_METHODS.readerConnect, { target }).pipe(Effect.result);
    const readerUp = yield* readerWhere((s) => s.connection._tag === "connected");
    results.push({
      check: "Adapter connects and identifies itself",
      ok: connectedReader._tag === "Success" && Option.isSome(readerUp),
      detail: Option.match(readerUp, {
        onNone: () =>
          connectedReader._tag === "Failure" ? connectedReader.failure.message : "timed out",
        onSome: (s) =>
          s.connection._tag === "connected"
            ? `${s.connection.adapter} ${s.connection.protocol ?? ""}`
            : "",
      }),
    });
    if (Option.isSome(readerUp)) {
      yield* client(WS_METHODS.readerWatch, { pids: ["010C", "010D", "0105"] as Array<PidId> });
      yield* setPid("010C", 1800);
      yield* setPid("010D", 42);
      yield* setPid("0105", 77);
      const live = yield* readerWhere(
        (s) =>
          s.readings["010C" as PidId]?.value === 1800 &&
          s.readings["010D" as PidId]?.value === 42 &&
          s.readings["0105" as PidId]?.value === 77,
      );
      results.push({
        check: "Adapter reads RPM, speed and coolant",
        ok: Option.isSome(live),
        detail: Option.isSome(live) ? "1800 rpm, 42 km/h, 77 °C" : "values never matched",
      });
      yield* client(WS_METHODS.setDtcs, { mode: "03", codes: ["P0420"] as Array<DtcCode> });
      const dtcs = yield* client(WS_METHODS.readerReadDtcs, undefined).pipe(
        Effect.andThen(readerWhere((s) => s.dtcs !== null)),
        Effect.result,
      );
      const readDtcs = dtcs._tag === "Success" ? Option.getOrNull(dtcs.success)?.dtcs : null;
      results.push({
        check: "Adapter reads stored codes",
        ok: readDtcs?.join() === "P0420",
        detail: readDtcs?.join() ?? (dtcs._tag === "Failure" ? dtcs.failure.message : "none"),
      });
      const vin = yield* client(WS_METHODS.readerReadVin, undefined).pipe(
        Effect.andThen(readerWhere((s) => s.vin !== null)),
        Effect.result,
      );
      const readVin = vin._tag === "Success" ? Option.getOrNull(vin.success)?.vin : null;
      results.push({
        check: "Adapter reads the VIN",
        ok: readVin === originalVin,
        detail: readVin ?? (vin._tag === "Failure" ? vin.failure.message : "none"),
      });
      yield* client(WS_METHODS.clearDtcs, {});
    }
    yield* client(WS_METHODS.readerDisconnect, undefined);
  }

  for (const [pid, value] of Object.entries(connected.pids)) yield* setPid(pid, value);
  yield* client(WS_METHODS.disconnect, undefined);

  for (const result of results) {
    yield* Console.log(
      `${result.ok ? "PASS" : "FAIL"}  ${result.check.padEnd(42)} ${result.detail}`,
    );
  }
  const failed = results.filter((result) => !result.ok).length;
  yield* Console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed > 0) return yield* Effect.fail(`${failed} checks failed`);
}).pipe(Effect.scoped, Effect.provide(ProtocolLayer));

NodeRuntime.runMain(program);
