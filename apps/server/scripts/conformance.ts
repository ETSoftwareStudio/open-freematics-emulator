/**
 * Drives a server through the real Effect RPC client, as the web app does, on the simulated
 * device, and records a normalized transcript of every result. With no `--url` it starts the
 * TypeScript and the Rust servers on free ports with fresh data dirs, drives both, and diffs.
 * Usage: node apps/server/scripts/conformance.ts [--url http://127.0.0.1:3738 --data-dir …]
 */
// @effect-diagnostics nodeBuiltinImport:off - starts both servers and probes them over raw HTTP.
// @effect-diagnostics preferSchemaOverJson:off - records arbitrary payloads for a diff.
// @effect-diagnostics globalTimers:off - plain Node orchestration bounds each wait with a timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  type DtcCode,
  type FirmwareUpdateInput,
  type FirmwareUpdateState,
  type PidId,
  type PresetId,
  type ReaderState,
  type Vin,
  type CalibrationId,
  WS_METHODS,
  WsRpcGroup,
} from "@fme/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { APPLICATION_BASE, FLASH_BASE } from "../src/firmware/flashPlan.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const WAIT = "15 seconds";

interface Entry {
  readonly step: string;
  readonly result: unknown;
}

// The FIPS-197 example key; the simulated bootloader takes whichever key the update uses.
const TEST_KEY = "000102030405060708090a0b0c0d0e0f";

const hexRecord = (type: number, offset: number, data: ReadonlyArray<number> = []) => {
  const fields = [data.length, offset >> 8, offset & 0xff, type, ...data];
  const sum = fields.reduce((acc, byte) => acc + byte, 0);
  return `:${Buffer.from([...fields, -sum & 0xff]).toString("hex")}`;
};

const hexFile = (address: number, data: Uint8Array) => {
  const lines: Array<string> = [];
  for (let i = 0; i < data.length; i += 16) {
    const at = address + i;
    if (i === 0 || (at & 0xffff) === 0)
      lines.push(hexRecord(0x04, 0, [at >>> 24, (at >>> 16) & 0xff]));
    lines.push(hexRecord(0x00, at & 0xffff, [...data.subarray(i, i + 16)]));
  }
  return [...lines, hexRecord(0x01, 0)].join("\n");
};

const APPLICATION = Uint8Array.from({ length: 2500 }, (_, i) => (i * 7) & 0xff);
const IMAGE = hexFile(APPLICATION_BASE, APPLICATION);

/**
 * Only values that differ from run to run are replaced: wall-clock timestamps (`at`, `dtcsAt`),
 * the measured poll rate, random user preset ids (numbered by first appearance), and the
 * server's own temp data dir.
 */
const makeNormalizer = (dataDir: string) => {
  const presetIds = new Map<string, string>();
  const normalize = (value: unknown, key?: string): unknown => {
    if ((key === "at" || key === "dtcsAt") && typeof value === "number") return "<time>";
    if (key === "pollRate" && typeof value === "number") return value > 0 ? "<rate>" : 0;
    if (typeof value === "string") {
      if (/^user:[0-9a-f-]{36}$/.test(value)) {
        if (!presetIds.has(value)) presetIds.set(value, `user:<id-${presetIds.size + 1}>`);
        return presetIds.get(value);
      }
      return value.split(dataDir).join("<data-dir>");
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [field, normalize(item, field)]),
      );
    }
    return value;
  };
  return normalize;
};

const plainError = (error: unknown): unknown => {
  if (error === null || typeof error !== "object") return error;
  const tagged = error as { readonly _tag?: unknown; readonly message?: unknown };
  return { _tag: tagged._tag, ...error, message: tagged.message };
};

const summarize = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: exit.value ?? null };
  if (Cause.hasInterrupts(exit.cause)) return { interrupted: true };
  const error = Cause.findError(exit.cause);
  if (Result.isSuccess(error)) return { error: plainError(error.success) };
  const defect = Cause.squash(exit.cause);
  return {
    defect: defect instanceof Error ? { name: defect.name, message: defect.message } : defect,
  };
};

const httpRequest = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    const request = NodeHttp.request(url, { method, headers }, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          type: response.headers["content-type"],
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });

/** A WebSocket handshake from another site's page; the guard must refuse it before upgrading. */
const foreignUpgrade = (url: string) =>
  new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": NodeCrypto.randomBytes(16).toString("base64"),
        Origin: "https://evil.example",
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on("error", reject);
    request.end();
  });

const httpChecks = async (baseUrl: string) => {
  const entries: Array<Entry> = [];
  const probe = async (step: string, path: string, headers?: Record<string, string>) => {
    const { status, type, body } = await httpRequest(`${baseUrl}${path}`, headers);
    entries.push({
      step,
      result: { status, type: type ?? null, body: status === 200 ? body : "" },
    });
  };
  await probe("http health", "/api/health");
  await probe("http index", "/");
  await probe("http nested file", "/assets/app.js");
  await probe("http directory without index", "/assets");
  await probe("http missing file", "/missing.js");
  await probe("http path outside the web root", "/%2e%2e/package.json");
  await probe("http health from another site", "/api/health", { Origin: "https://evil.example" });
  await probe("http health from its own page", "/api/health", { Origin: baseUrl });
  await probe("http health on a rebound host", "/api/health", { Host: "evil.example" });
  const post = await httpRequest(`${baseUrl}/api/health`, {}, "POST");
  entries.push({ step: "http POST health", result: post.status });
  entries.push({
    step: "ws upgrade from another site",
    result: await foreignUpgrade(`${baseUrl}/ws`),
  });
  return entries;
};

type Message = Record<string, unknown>;

interface RawSocket {
  readonly send: (message: unknown) => void;
  readonly sendText: (text: string | Uint8Array) => void;
  readonly next: () => Promise<Message>;
  /** Every message before the `Pong` that answers a fresh `Ping`, which the server sends last. */
  readonly drain: () => Promise<Array<Message>>;
  /** Messages until each predicate has matched one of them, in arrival order. */
  readonly until: (
    expected: ReadonlyArray<(message: Message) => boolean>,
  ) => Promise<Array<Message>>;
  /** The close code once the server drops the connection, or "open" if it stays up. */
  readonly closed: () => Promise<number | "open">;
  readonly close: () => void;
}

const openRawSocket = async (wsUrl: string): Promise<RawSocket> => {
  const socket = new WebSocket(wsUrl);
  const inbox: Array<Message> = [];
  const waiters: Array<() => void> = [];
  let closeCode: number | undefined;
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  socket.addEventListener("message", (event) => {
    inbox.push(JSON.parse(String(event.data)));
    wake();
  });
  socket.addEventListener("close", (event) => {
    closeCode = event.code;
    wake();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")));
  });
  const arrival = () => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      new Promise<void>((resolve) => waiters.push(resolve)),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no message from the server")), 15_000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const next = async (): Promise<Message> => {
    const message = inbox.shift();
    if (message !== undefined) return message;
    if (closeCode !== undefined) return { closed: closeCode };
    await arrival();
    return next();
  };
  return {
    send,
    sendText: (text) => socket.send(text),
    next,
    drain: async () => {
      send({ _tag: "Ping" });
      const messages: Array<Message> = [];
      for (let message = await next(); message._tag !== "Pong"; message = await next()) {
        messages.push(message);
        if ("closed" in message) break;
      }
      return messages;
    },
    until: async (expected) => {
      const pending = [...expected];
      const messages: Array<Message> = [];
      while (pending.length > 0) {
        const message = await next();
        messages.push(message);
        if ("closed" in message) break;
        const matched = pending.findIndex((matches) => matches(message));
        if (matched !== -1) pending.splice(matched, 1);
      }
      return messages;
    },
    closed: async () => {
      send({ _tag: "Ping" });
      for (let message = await next(); !("closed" in message); message = await next()) {
        if (message._tag === "Pong") return "open";
      }
      return closeCode ?? "open";
    },
    close: () => socket.close(),
  };
};

const exitOf = (requestId: number) => (message: Message) =>
  message._tag === "Exit" && message.requestId === requestId;
const chunkOf = (requestId: number) => (message: Message) =>
  message._tag === "Chunk" && message.requestId === requestId;

/** A chunk by its last value's ignition; an interrupt exit by its distinct cause tags. */
const describe = (message: Message): unknown => {
  if (message._tag === "Chunk") {
    const values = message.values as ReadonlyArray<{ readonly ignition?: unknown }>;
    return { _tag: "Chunk", requestId: message.requestId, ignition: values.at(-1)?.ignition };
  }
  const exit = message.exit as { _tag: string; cause?: Array<{ _tag: string }> } | undefined;
  if (exit?.cause?.some((reason) => reason._tag === "Interrupt")) {
    const tags = [...new Set(exit.cause.map((reason) => reason._tag))];
    return { ...message, exit: { _tag: exit._tag, causeTags: tags } };
  }
  return message;
};

const request = (socket: RawSocket, id: number | string, tag: string, payload?: unknown) =>
  socket.send({ _tag: "Request", id, tag, payload, headers: [] });

/** Raw frames, for what the Effect client never sends: protocol errors and manual acks. */
const rawProtocolChecks = async (wsUrl: string) => {
  const entries: Array<Entry> = [];
  const socket = await openRawSocket(wsUrl);
  const { send, next, drain } = socket;

  send({ _tag: "Ping" });
  entries.push({ step: "raw ping", result: await next() });
  send([{ _tag: "Ping" }, 5, { _tag: "Ping" }]);
  entries.push({ step: "raw batch", result: [await next(), await next(), await next()] });
  socket.sendText(new TextEncoder().encode(JSON.stringify({ _tag: "Ping" })));
  entries.push({ step: "raw ping in a binary frame", result: await next() });

  request(socket, 1, "emulator.nope", null);
  entries.push({ step: "raw unknown rpc tag", result: await next() });
  for (const [step, id, tag, payload] of [
    ["raw payload of the wrong type", "s-2", WS_METHODS.setIgnition, { on: "yes" }],
    ["raw missing payload", 3, WS_METHODS.listPorts, undefined],
    ["raw object payload for a void rpc", 3.5, WS_METHODS.disconnect, {}],
  ] as const) {
    request(socket, id, tag, payload);
    const exit = (await next()) as { exit?: { cause?: Array<{ defect?: unknown }> } };
    const defect = exit.exit?.cause?.[0]?.defect;
    entries.push({
      step,
      result: JSON.parse(
        JSON.stringify(exit, (key, value) => (key === "defect" ? typeof defect : value)),
      ),
    });
  }
  send({ _tag: "Bogus" });
  entries.push({ step: "raw unknown message tag", result: await next() });
  send({ _tag: "Request", tag: WS_METHODS.listPorts, payload: null, headers: [] });
  entries.push({ step: "raw request without an id", result: await next() });
  request(socket, {} as never, WS_METHODS.listPorts, null);
  entries.push({ step: "raw request with an object id", result: await next() });
  socket.sendText("{");
  const syntax = await next();
  const syntaxDefect = syntax.defect as { name: string; message: unknown };
  entries.push({
    step: "raw malformed JSON",
    result: { _tag: syntax._tag, name: syntaxDefect.name, message: typeof syntaxDefect.message },
  });
  send({ _tag: "Interrupt", requestId: 404 });
  entries.push({ step: "raw interrupt for an unknown request", result: await drain() });
  send({ _tag: "Ack", requestId: 404 });
  entries.push({ step: "raw ack for an unknown request", result: await drain() });
  send({ _tag: "Eof" });
  entries.push({ step: "raw eof with nothing running", result: await drain() });

  request(socket, 4, WS_METHODS.applyPreset, { id: "user:missing" });
  entries.push({ step: "raw typed failure", result: await next() });
  request(socket, 5, WS_METHODS.readerSetPolling, { paused: true, interval: 1000, extra: 1 });
  entries.push({ step: "raw void success, extra fields ignored", result: await next() });

  request(socket, 6, WS_METHODS.subscribeState, null);
  entries.push({ step: "raw stream first chunk", result: describe(await next()) });
  request(socket, 7, WS_METHODS.setIgnition, { on: false });
  entries.push({
    step: "raw stream holds the next chunk until acked",
    result: [...(await socket.until([exitOf(7)])), ...(await drain())].map(describe),
  });
  send({ _tag: "Ack", requestId: 6 });
  entries.push({ step: "raw stream chunk after ack", result: describe(await next()) });
  send({ _tag: "Ack", requestId: 6 });
  request(socket, 8, WS_METHODS.setIgnition, { on: true });
  const acked = (await socket.until([exitOf(8), chunkOf(6)])).map(describe);
  entries.push({
    step: "raw stream keeps streaming while acked",
    result: acked.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  send({ _tag: "Interrupt", requestId: 6 });
  entries.push({ step: "raw stream interrupted", result: describe(await next()) });
  request(socket, 6, WS_METHODS.readerSetPolling, { paused: true, interval: 1000 });
  entries.push({ step: "raw reuse of a finished request id", result: await next() });

  request(socket, 9, WS_METHODS.subscribeWireKey, null);
  entries.push({ step: "raw second stream", result: await next() });
  request(socket, 9, WS_METHODS.subscribeWireKey, null);
  entries.push({ step: "raw reuse of a running request id", result: await socket.closed() });

  const ended = await openRawSocket(wsUrl);
  request(ended, 1, WS_METHODS.subscribeWireKey, null);
  await ended.next();
  ended.send({ _tag: "Eof" });
  entries.push({ step: "raw eof while a stream runs", result: await ended.drain() });
  request(ended, 2, WS_METHODS.readerSetPolling, { paused: true, interval: 1000 });
  entries.push({ step: "raw request after eof", result: await ended.closed() });

  const crashed = await openRawSocket(wsUrl);
  crashed.send(null);
  entries.push({ step: "raw null message", result: await crashed.closed() });
  socket.close();
  return entries;
};

const drive = Effect.fn("Conformance.drive")(function* (baseUrl: string, dataDir: string) {
  const entries: Array<Entry> = [];
  const client = yield* RpcClient.make(WsRpcGroup, { flatten: true });
  const record = Effect.fn("Conformance.record")(function* <A, E>(
    step: string,
    effect: Effect.Effect<A, E>,
  ) {
    const exit = yield* Effect.exit(effect);
    entries.push({ step, result: summarize(exit) });
    return exit;
  });
  const head = <A, E>(stream: Stream.Stream<A, E>) =>
    stream.pipe(Stream.runHead, Effect.map(Option.getOrNull));
  /** The first value matching `predicate`, or `null` when none arrives in time. */
  const waitFor = <A, E>(stream: Stream.Stream<A, E>, predicate: (value: A) => boolean) =>
    stream.pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.timeoutOption(WAIT),
      Effect.map((found) => Option.getOrNull(Option.flatten(found))),
    );
  const emulatorState = () => head(client(WS_METHODS.subscribeState, undefined));
  const readerState = () => head(client(WS_METHODS.readerSubscribeState, undefined));
  const firmwareStates = () => client(WS_METHODS.subscribeFirmwareUpdate, undefined);
  const setPid = (pid: string, value: number) =>
    client(WS_METHODS.setPid, { pid: pid as PidId, value });
  const missingPort = NodePath.join(dataDir, "no-such-port");

  yield* record("initial emulator state", emulatorState());
  yield* record("initial reader state", readerState());
  yield* record("initial presets", head(client(WS_METHODS.subscribePresets, undefined)));
  yield* record("initial firmware update state", head(firmwareStates()));
  yield* record("initial wire key", head(client(WS_METHODS.subscribeWireKey, undefined)));
  yield* record(
    "initial firmware library",
    head(client(WS_METHODS.subscribeFirmwareLibrary, undefined)),
  );
  yield* record("list ports", client(WS_METHODS.listPorts, undefined));

  yield* record("sendRaw while disconnected", client(WS_METHODS.sendRaw, { command: "ATI" }));
  yield* record(
    "setIgnition off while disconnected",
    client(WS_METHODS.setIgnition, { on: false }),
  );
  yield* record("setPid while disconnected", setPid("010C", 1200));
  yield* record("state after offline edits", emulatorState());
  yield* record(
    "connect to a missing serial port",
    client(WS_METHODS.connect, { target: { _tag: "serial", path: missingPort } }),
  );
  yield* record("state after a failed connect", emulatorState());
  yield* record(
    "connect to the simulator",
    client(WS_METHODS.connect, { target: { _tag: "simulated" } }),
  );
  yield* record("state after connecting", emulatorState());

  yield* record("setIgnition on", client(WS_METHODS.setIgnition, { on: true }));
  yield* record("setProtocol", client(WS_METHODS.setProtocol, { protocol: "CAN_29B_500K" }));
  yield* record("setVinEnabled", client(WS_METHODS.setVinEnabled, { enabled: true }));
  yield* record("setVin", client(WS_METHODS.setVin, { vin: "WVWZZZ1JZXW000001" as Vin }));
  yield* record(
    "setCalibrationId",
    client(WS_METHODS.setCalibrationId, { calibrationId: "CONFORM1" as CalibrationId }),
  );
  yield* record("setPid RPM", setPid("010C", 2500));
  yield* record("setPid coolant below zero", setPid("0105", -10));
  yield* record("setPid voltage", setPid("0142", 13.8));
  yield* record(
    "setDtcs stored",
    client(WS_METHODS.setDtcs, { mode: "03", codes: ["P0105", "P0300"] as Array<DtcCode> }),
  );
  yield* record(
    "setDtcs pending",
    client(WS_METHODS.setDtcs, { mode: "07", codes: ["P0420"] as Array<DtcCode> }),
  );
  yield* record(
    "setReadiness",
    client(WS_METHODS.setReadiness, { monitor: "misfire", supported: true, complete: false }),
  );
  yield* record("sendRaw monitor status", client(WS_METHODS.sendRaw, { command: "ATGET 0101" }));
  yield* record("sendRaw an unknown command", client(WS_METHODS.sendRaw, { command: "ATBOGUS" }));
  yield* record("sendRaw VIN", client(WS_METHODS.sendRaw, { command: "ATGET VIN" }));
  yield* record("state after the setters", emulatorState());
  yield* record(
    "traffic up to the VIN read",
    client(WS_METHODS.subscribeTraffic, undefined).pipe(
      Stream.takeUntil((entry) => entry.direction === "tx" && entry.text === "ATGET VIN"),
      Stream.runCollect,
      Effect.timeoutOption(WAIT),
    ),
  );

  const stateUpdates = yield* client(WS_METHODS.subscribeState, undefined).pipe(
    Stream.filter((state) => state.pids["010D" as PidId] === 77),
    Stream.runHead,
    Effect.timeoutOption(WAIT),
    Effect.forkChild,
  );
  yield* record("setPid speed", setPid("010D", 77));
  const updated = yield* Fiber.join(stateUpdates);
  entries.push({
    step: "state stream delivers the speed change",
    result: Option.isSome(Option.flatten(updated)),
  });

  const saved = yield* record(
    "savePreset new",
    client(WS_METHODS.savePreset, {
      name: "Conformance",
      pids: { ["010C" as PidId]: 1500, ["010D" as PidId]: 40 },
    }),
  );
  const savedId = Exit.isSuccess(saved) ? saved.value.id : ("user:missing" as PresetId);
  yield* record(
    "savePreset rename",
    client(WS_METHODS.savePreset, {
      id: savedId,
      name: "Conformance 2",
      pids: { ["010D" as PidId]: 55 },
    }),
  );
  yield* record(
    "savePreset with an unknown id",
    client(WS_METHODS.savePreset, {
      id: "user:missing" as PresetId,
      name: "Ghost",
      pids: {},
    }),
  );
  const presets = yield* head(client(WS_METHODS.subscribePresets, undefined));
  const builtIn = presets?.find((preset) => preset.builtIn)?.id ?? ("builtin:missing" as PresetId);
  yield* record(
    "savePreset over a built-in",
    client(WS_METHODS.savePreset, { id: builtIn, name: "Mine", pids: {} }),
  );
  yield* record("applyPreset user", client(WS_METHODS.applyPreset, { id: savedId }));
  yield* record("state after the user preset", emulatorState());
  yield* record("applyPreset built-in", client(WS_METHODS.applyPreset, { id: builtIn }));
  yield* record("state after the built-in preset", emulatorState());
  yield* record(
    "applyPreset unknown",
    client(WS_METHODS.applyPreset, { id: "user:missing" as PresetId }),
  );
  yield* record("deletePreset built-in", client(WS_METHODS.deletePreset, { id: builtIn }));
  yield* record("deletePreset user", client(WS_METHODS.deletePreset, { id: savedId }));
  yield* record("deletePreset again", client(WS_METHODS.deletePreset, { id: savedId }));
  yield* record("presets after the changes", head(client(WS_METHODS.subscribePresets, undefined)));

  yield* record("reader readDtcs before connecting", client(WS_METHODS.readerReadDtcs, undefined));
  yield* record("reader readOnce before connecting", client(WS_METHODS.readerReadOnce, undefined));
  yield* record(
    "reader connect to a closed TCP port",
    client(WS_METHODS.readerConnect, { target: { _tag: "tcp", host: "127.0.0.1", port: 1 } }),
  );
  yield* record("reader state after a failed connect", readerState());
  yield* record(
    "reader pause polling",
    client(WS_METHODS.readerSetPolling, { paused: true, interval: 500 }),
  );
  yield* record(
    "reader connect to the simulator",
    client(WS_METHODS.readerConnect, { target: { _tag: "simulated" } }),
  );
  yield* record(
    "reader watch",
    client(WS_METHODS.readerWatch, { pids: ["010C", "010D", "0105", "0142"] as Array<PidId> }),
  );
  yield* record("reader readOnce", client(WS_METHODS.readerReadOnce, undefined));
  yield* record("reader state after readOnce", readerState());
  yield* record("reader readDtcs", client(WS_METHODS.readerReadDtcs, undefined));
  yield* record("reader readVin", client(WS_METHODS.readerReadVin, undefined));
  yield* record("reader state after reading codes and VIN", readerState());
  yield* record("reader clearDtcs", client(WS_METHODS.readerClearDtcs, undefined));
  yield* record("reader state after clearing codes", readerState());
  yield* record("emulator state after the reader cleared codes", emulatorState());
  const polled = yield* waitFor(
    client(WS_METHODS.readerSubscribeState, undefined).pipe(Stream.drop(1)),
    (state: ReaderState) => state.pollRate > 0,
  ).pipe(
    Effect.forkChild({ startImmediately: true }),
    Effect.tap(() => client(WS_METHODS.readerSetPolling, { paused: false, interval: 250 })),
    Effect.flatMap(Fiber.join),
  );
  entries.push({ step: "reader stream delivers polled readings", result: polled !== null });
  yield* record(
    "reader pause polling again",
    client(WS_METHODS.readerSetPolling, { paused: true, interval: 1000 }),
  );
  yield* record("reader disconnect", client(WS_METHODS.readerDisconnect, undefined));
  yield* record("reader state after disconnecting", readerState());

  yield* record("inspect a valid image", client(WS_METHODS.inspectFirmware, { image: IMAGE }));
  yield* record(
    "inspect text that isn't HEX",
    client(WS_METHODS.inspectFirmware, { image: "hello" }),
  );
  yield* record(
    "inspect a bad record",
    client(WS_METHODS.inspectFirmware, { image: `${IMAGE.slice(0, 40)}\n:zz` }),
  );
  yield* record(
    "inspect an image over the bootloader",
    client(WS_METHODS.inspectFirmware, { image: hexFile(FLASH_BASE, APPLICATION) }),
  );
  const update: FirmwareUpdateInput = {
    target: { _tag: "simulated" },
    image: { _tag: "file", text: IMAGE },
    wireKey: TEST_KEY,
  };
  yield* record(
    "update from a missing library image",
    client(WS_METHODS.updateFirmware, {
      target: { _tag: "simulated" },
      image: { _tag: "library", name: "Firmware_MK2_20990101.hex" },
    }),
  );
  yield* record(
    "update without a wire key",
    client(WS_METHODS.updateFirmware, { target: update.target, image: update.image }),
  );
  yield* record(
    "update a serial port with a key that isn't the vendor's",
    client(WS_METHODS.updateFirmware, {
      ...update,
      target: { _tag: "serial", path: missingPort },
    }),
  );
  yield* record(
    "import vendor files without a key",
    client(WS_METHODS.importVendorFiles, {
      files: [
        { name: "readme.txt", bytes: new TextEncoder().encode("not the vendor tool") },
        { name: "Firmware_MK2_20250311.hex", bytes: new TextEncoder().encode(IMAGE) },
      ],
    }),
  );
  yield* record("import no files", client(WS_METHODS.importVendorFiles, { files: [] }));
  yield* record("forget a wire key that isn't stored", client(WS_METHODS.forgetWireKey, undefined));
  yield* record("wire key after forgetting", head(client(WS_METHODS.subscribeWireKey, undefined)));
  yield* record(
    "library after the imports",
    head(client(WS_METHODS.subscribeFirmwareLibrary, undefined)),
  );

  const running = yield* waitFor(firmwareStates(), (state) => state._tag === "running").pipe(
    Effect.forkChild({ startImmediately: true }),
  );
  const flashing = yield* client(WS_METHODS.updateFirmware, update).pipe(
    Effect.forkChild({ startImmediately: true }),
  );
  const runningState = yield* Fiber.join(running);
  entries.push({
    step: "update reports progress",
    result: runningState?._tag ?? null,
  });
  yield* record("a second update while one runs", client(WS_METHODS.updateFirmware, update));
  yield* Fiber.interrupt(flashing);
  entries.push({
    step: "interrupted update call",
    result: summarize(yield* Fiber.await(flashing)),
  });
  const finished = yield* waitFor(
    firmwareStates(),
    (state: FirmwareUpdateState) => state._tag === "succeeded" || state._tag === "failed",
  );
  entries.push({ step: "update runs on after its caller leaves", result: finished });
  yield* record("emulator state after the update", emulatorState());
  yield* record(
    "reconnect after the update",
    client(WS_METHODS.connect, { target: { _tag: "simulated" } }),
  );
  yield* record("emulator state after reconnecting", emulatorState());
  yield* record("clearDtcs", client(WS_METHODS.clearDtcs, {}));
  yield* record("disconnect", client(WS_METHODS.disconnect, undefined));
  yield* record("emulator state after disconnecting", emulatorState());
  yield* record("presets on disk", Effect.succeed(readPresetFile(dataDir)));

  const normalize = makeNormalizer(dataDir);
  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;
  const raw = yield* Effect.promise(() => rawProtocolChecks(wsUrl));
  const http = yield* Effect.promise(() => httpChecks(baseUrl));
  return [...entries, ...raw, ...http].map(({ step, result }) => ({
    step,
    result: normalize(result),
  }));
});

const readPresetFile = (dataDir: string) => {
  const file = NodePath.join(dataDir, "presets.json");
  return NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : null;
};

const runDrive = (baseUrl: string, dataDir: string) =>
  drive(baseUrl, dataDir).pipe(
    Effect.scoped,
    Effect.provide(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
    Effect.runPromise,
  );

interface StartedServer {
  readonly url: string;
  readonly stop: () => void;
}

const startServer = (name: string, command: string, args: ReadonlyArray<string>) =>
  new Promise<StartedServer>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, FME_SERVER_PORT: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Array<string> = [];
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`${name} did not start:\n${output.join("")}`));
    }, 60_000);
    const collect = (chunk: Buffer) => {
      output.push(chunk.toString());
      const url = /Listening on (http:\/\/\S+)/.exec(output.join(""))?.[1];
      if (url !== undefined) {
        clearTimeout(timer);
        resolve({ url, stop });
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited with ${code}:\n${output.join("")}`));
    });
  });

const writeWebRoot = (dir: string) => {
  NodeFS.mkdirSync(NodePath.join(dir, "assets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "index.html"), "<!doctype html><title>fme</title>\n");
  NodeFS.writeFileSync(NodePath.join(dir, "assets", "app.js"), "export {};\n");
};

const conformance = async (
  name: string,
  command: string,
  args: ReadonlyArray<string>,
  work: string,
) => {
  const dataDir = NodePath.join(work, `${name}-data`);
  const server = await startServer(name, command, [
    ...args,
    "--port",
    "0",
    "--data-dir",
    dataDir,
    "--web-root",
    NodePath.join(work, "web"),
  ]);
  try {
    return await runDrive(server.url, dataDir);
  } finally {
    server.stop();
  }
};

const diff = (left: ReadonlyArray<Entry>, right: ReadonlyArray<Entry>) => {
  const differences: Array<string> = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = JSON.stringify(left[i], null, 2);
    const b = JSON.stringify(right[i], null, 2);
    if (a !== b) differences.push(`--- typescript\n${a}\n+++ rust\n${b}`);
  }
  return differences;
};

const { values } = NodeUtil.parseArgs({
  options: { url: { type: "string" }, "data-dir": { type: "string" } },
});

if (values.url !== undefined) {
  const transcript = await runDrive(values.url, values["data-dir"] ?? "");
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
} else {
  const build = NodeChildProcess.spawnSync("cargo", ["build", "-p", "fme-server", "--bin", "fme"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fme-conformance-"));
  writeWebRoot(NodePath.join(work, "web"));
  const typescript = await conformance(
    "typescript",
    process.execPath,
    [NodePath.join(ROOT, "apps/server/src/bin.ts")],
    work,
  );
  const rust = await conformance("rust", NodePath.join(ROOT, "target/debug/fme"), [], work);
  NodeFS.writeFileSync(NodePath.join(work, "typescript.json"), JSON.stringify(typescript, null, 2));
  NodeFS.writeFileSync(NodePath.join(work, "rust.json"), JSON.stringify(rust, null, 2));
  const differences = diff(typescript, rust);
  process.stdout.write(`Transcripts: ${work}/{typescript,rust}.json\n`);
  if (differences.length > 0) {
    process.stdout.write(`${differences.join("\n\n")}\n\n`);
    process.stdout.write(`${differences.length} of ${typescript.length} checks differ.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`All ${typescript.length} checks match.\n`);
  }
}
