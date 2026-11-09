// @effect-diagnostics nodeBuiltinImport:off - serial ports need raw descriptors, termios via stty, and Node's TTY stream.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";
import { SerialPortListError, type SerialPortInfo } from "@fme/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { SerialPort } from "serialport";
import { DeviceLinkError, type DeviceLink } from "./DeviceLink.ts";

export const BAUD_RATE = 38400;

export interface SerialLink extends DeviceLink {
  /** A real open of a held macOS Bluetooth port: silence here means macOS stopped serving it. */
  readonly silentMeansStale: boolean;
}

export class SerialPorts extends Context.Service<
  SerialPorts,
  {
    readonly list: Effect.Effect<ReadonlyArray<SerialPortInfo>, SerialPortListError>;
    /**
     * Opens the port for the scope. macOS Bluetooth ports stay open for the server's lifetime:
     * closing the scope only detaches, and the next open reuses the descriptor.
     */
    readonly open: (path: string) => Effect.Effect<SerialLink, DeviceLinkError, Scope.Scope>;
  }
>()("@fme/server/device/SerialPorts") {}

export interface SerialPortsOptions {
  readonly platform: NodeJS.Platform;
  readonly isBluetooth: (path: string) => Effect.Effect<boolean>;
  readonly openPort: (path: string) => Effect.Effect<DeviceLink, DeviceLinkError, Scope.Scope>;
}

// CP2102 on current MK2 units, CH340 on older ones.
const EMULATOR_BRIDGES = new Set(["10c4:ea60", "1a86:7523"]);
const IGNORED_PORTS = /Bluetooth-Incoming-Port|debug-console|wlan-debug/i;

type ListedPort = Awaited<ReturnType<typeof SerialPort.list>>[number];

// Windows tags Bluetooth SPP ports BTHENUM and Linux binds them to rfcomm; macOS lists them
// without USB IDs, and its other ID-less ports are in IGNORED_PORTS.
const transportOf = (port: ListedPort, platform: NodeJS.Platform): SerialPortInfo["transport"] => {
  if (/BTHENUM/i.test(port.pnpId ?? "") || /rfcomm/.test(port.path)) return "bluetooth";
  if (port.vendorId !== undefined) return "usb";
  return platform === "darwin" ? "bluetooth" : "other";
};

export const toInfo = (
  port: ListedPort,
  platform: NodeJS.Platform = process.platform,
): SerialPortInfo => {
  const vendorId = port.vendorId?.toLowerCase();
  const productId = port.productId?.toLowerCase();
  return {
    // `cu` devices don't block on carrier detect; `tty` ones do.
    path: platform === "darwin" ? port.path.replace("/dev/tty.", "/dev/cu.") : port.path,
    ...(port.manufacturer === undefined ? {} : { manufacturer: port.manufacturer }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(productId === undefined ? {} : { productId }),
    transport: transportOf(port, platform),
    likelyEmulator: EMULATOR_BRIDGES.has(`${vendorId}:${productId}`),
  };
};

const list = Effect.tryPromise({
  try: () => SerialPort.list(),
  catch: () => new SerialPortListError(),
}).pipe(
  Effect.map((ports) =>
    ports
      .filter((port) => !IGNORED_PORTS.test(port.path))
      .map((port) => toInfo(port))
      .toSorted((a, b) => Number(b.likelyEmulator) - Number(a.likelyEmulator)),
  ),
  Effect.withSpan("SerialPorts.list"),
);

const chunksFrom = (source: NodeJS.EventEmitter): Stream.Stream<string, DeviceLinkError> =>
  Stream.callback<string, DeviceLinkError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onData = (data: Buffer) => Queue.offerUnsafe(queue, data.toString("latin1"));
        const onError = (cause: unknown) =>
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(new DeviceLinkError({ operation: "read", cause })),
          );
        const onClose = () => Queue.endUnsafe(queue);
        source.on("data", onData).on("error", onError).on("close", onClose);
        return () => {
          source.off("data", onData).off("error", onError).off("close", onClose);
        };
      }),
      (detach) => Effect.sync(detach),
    ),
  );

const configureTty = (path: string) =>
  NodeChildProcess.execFileSync("stty", [
    process.platform === "darwin" ? "-f" : "-F",
    path,
    String(BAUD_RATE),
    "cs8",
    "-cstopb",
    "-parenb",
    "clocal",
    "cread",
    "raw",
    "-echo",
    "-ixon",
    "-ixoff",
    "-crtscts",
  ]);

/**
 * POSIX ports are read through Node's TTY stream. `serialport` waits on a kqueue poller that
 * macOS's CP210x driver never signals, so replies sat unread until the next write.
 */
const openPosix = Effect.fn("SerialPorts.openPosix")(function* (path: string) {
  const { stream, fd } = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const fd = NodeFS.openSync(
          path,
          NodeFS.constants.O_RDWR | NodeFS.constants.O_NOCTTY | NodeFS.constants.O_NONBLOCK,
        );
        try {
          // Settings only stick while a descriptor holds the device open.
          configureTty(path);
          return { stream: new NodeTty.ReadStream(fd), fd };
        } catch (cause) {
          NodeFS.closeSync(fd);
          throw cause;
        }
      },
      catch: (cause) => new DeviceLinkError({ operation: "open", cause }),
    }),
    // macOS keeps the descriptor open after the TTY stream closes, which holds the port busy.
    ({ stream, fd }) =>
      Effect.callback<void>((resume) => {
        if (stream.closed) return resume(Effect.void);
        stream.once("close", () => resume(Effect.void)).destroy();
      }).pipe(Effect.andThen(Effect.try(() => NodeFS.closeSync(fd))), Effect.ignore),
  );
  // The descriptor is non-blocking, so a long bootloader frame can go out in pieces.
  const writeAll = (bytes: Uint8Array): Effect.Effect<void, DeviceLinkError> =>
    Effect.callback<number, NodeJS.ErrnoException>((resume) => {
      NodeFS.write(fd, bytes, (cause, written) =>
        resume(cause === null ? Effect.succeed(written) : Effect.fail(cause)),
      );
    }).pipe(
      Effect.catchIf(
        (cause) => cause.code === "EAGAIN",
        () => Effect.as(Effect.sleep("5 millis"), 0),
      ),
      Effect.mapError((cause) => new DeviceLinkError({ operation: "write", cause })),
      Effect.flatMap((written) =>
        written < bytes.length ? writeAll(bytes.subarray(written)) : Effect.void,
      ),
    );
  const write = (data: string | Uint8Array) =>
    writeAll(typeof data === "string" ? Buffer.from(data) : data);
  return { write, chunks: chunksFrom(stream) } satisfies DeviceLink;
});

const openWindows = Effect.fn("SerialPorts.openWindows")(function* (path: string) {
  const port = yield* Effect.acquireRelease(
    Effect.callback<SerialPort, DeviceLinkError>((resume) => {
      const opened: SerialPort = new SerialPort({ path, baudRate: BAUD_RATE }, (cause) =>
        resume(
          cause === null
            ? Effect.succeed(opened)
            : Effect.fail(new DeviceLinkError({ operation: "open", cause })),
        ),
      );
    }),
    (port) => Effect.sync(() => port.isOpen && port.close()),
  );
  const write = (data: string | Uint8Array) =>
    Effect.callback<void, DeviceLinkError>((resume) => {
      port.write(typeof data === "string" ? data : Buffer.from(data), (cause) =>
        resume(
          cause === null || cause === undefined
            ? Effect.void
            : Effect.fail(new DeviceLinkError({ operation: "write", cause })),
        ),
      );
    });
  return { write, chunks: chunksFrom(port) } satisfies DeviceLink;
});

const openPort = Effect.fn("SerialPorts.openPort")(function* (path: string) {
  return yield* process.platform === "win32" ? openWindows(path) : openPosix(path);
});

const isBluetooth = (path: string) =>
  list.pipe(
    Effect.map((ports) =>
      ports.some((port) => port.path === path && port.transport === "bluetooth"),
    ),
    Effect.orElseSucceed(() => false),
  );

interface HeldPort {
  readonly link: DeviceLink;
  readonly scope: Scope.Closeable;
  lease: Queue.Queue<string, DeviceLinkError | Cause.Done> | undefined;
  dropped: boolean;
}

const ended = Cause.fail(Cause.Done());

/**
 * macOS (27.2) serves a Bluetooth SPP port once per pairing: after its first close, later opens
 * succeed but nothing ever answers until the adapter is paired again. So those ports are held.
 */
const make = Effect.fn("SerialPorts.make")(function* (options: SerialPortsOptions) {
  const serverScope = yield* Effect.scope;
  const held = new Map<string, HeldPort>();
  const opening = yield* Semaphore.make(1);

  const drop = Effect.fnUntraced(function* (
    path: string,
    port: HeldPort,
    cause: Cause.Cause<DeviceLinkError | Cause.Done>,
  ) {
    if (port.dropped) return;
    port.dropped = true;
    if (held.get(path) === port) held.delete(path);
    yield* Scope.close(port.scope, Exit.void);
    if (port.lease !== undefined) Queue.failCauseUnsafe(port.lease, cause);
    port.lease = undefined;
  });

  // Whatever arrives while no lease is attached is dropped, so each lease starts clean.
  const pump = (path: string, port: HeldPort) =>
    port.link.chunks.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => port.lease !== undefined && Queue.offerUnsafe(port.lease, chunk)),
      ),
      Effect.exit,
      Effect.flatMap((exit) => drop(path, port, Exit.isSuccess(exit) ? ended : exit.cause)),
      Effect.forkIn(serverScope),
    );

  const lease = Effect.fnUntraced(function* (
    path: string,
    port: HeldPort,
    silentMeansStale: boolean,
  ) {
    const queue = yield* Queue.unbounded<string, DeviceLinkError | Cause.Done>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        port.lease = queue;
      }),
      () =>
        Effect.sync(() => {
          if (port.lease === queue) port.lease = undefined;
        }),
    );
    const write = (data: string | Uint8Array) =>
      port.link.write(data).pipe(Effect.tapError((error) => drop(path, port, Cause.fail(error))));
    return { write, chunks: Stream.fromQueue(queue), silentMeansStale } satisfies SerialLink;
  });

  const openHeld = Effect.fnUntraced(function* (path: string) {
    const current = held.get(path);
    if (current !== undefined) {
      if (current.lease !== undefined) {
        return yield* new DeviceLinkError({ operation: "open", cause: new Error("port busy") });
      }
      return yield* lease(path, current, false);
    }
    const scope = yield* Scope.make();
    const link = yield* options.openPort(path).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const port: HeldPort = { link, scope, lease: undefined, dropped: false };
    held.set(path, port);
    const leased = yield* lease(path, port, true);
    yield* pump(path, port);
    return leased;
  });

  const open = Effect.fn("SerialPorts.open")(function* (path: string) {
    yield* Effect.annotateCurrentSpan("path", path);
    if (options.platform === "darwin" && (yield* options.isBluetooth(path))) {
      return yield* opening.withPermit(openHeld(path));
    }
    const link = yield* options.openPort(path);
    return { ...link, silentMeansStale: false } satisfies SerialLink;
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...held], ([path, port]) => drop(path, port, ended), { discard: true }),
  );

  return SerialPorts.of({ list, open });
});

export const layerWith = (options: SerialPortsOptions) => Layer.effect(SerialPorts, make(options));

export const layer = layerWith({ platform: process.platform, isBluetooth, openPort });
