// @effect-diagnostics nodeBuiltinImport:off - serial ports need raw descriptors, termios via stty, and Node's TTY stream.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";
import { SerialPortListError, type SerialPortInfo } from "@fme/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { SerialPort } from "serialport";
import { DeviceLinkError, type DeviceLink } from "./DeviceLink.ts";

export const BAUD_RATE = 38400;

export class SerialPorts extends Context.Service<
  SerialPorts,
  {
    readonly list: Effect.Effect<ReadonlyArray<SerialPortInfo>, SerialPortListError>;
    readonly open: (path: string) => Effect.Effect<DeviceLink, DeviceLinkError, Scope.Scope>;
  }
>()("@fme/server/device/SerialPorts") {}

// CP2102 on current MK2 units, CH340 on older ones.
const EMULATOR_BRIDGES = new Set(["10c4:ea60", "1a86:7523"]);
const IGNORED_PORTS = /Bluetooth-Incoming-Port|debug-console|wlan-debug/i;

const toInfo = (port: Awaited<ReturnType<typeof SerialPort.list>>[number]): SerialPortInfo => {
  const vendorId = port.vendorId?.toLowerCase();
  const productId = port.productId?.toLowerCase();
  return {
    // `cu` devices don't block on carrier detect; `tty` ones do.
    path: process.platform === "darwin" ? port.path.replace("/dev/tty.", "/dev/cu.") : port.path,
    ...(port.manufacturer === undefined ? {} : { manufacturer: port.manufacturer }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(productId === undefined ? {} : { productId }),
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
      .map(toInfo)
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
  const write = (data: string) =>
    Effect.callback<void, DeviceLinkError>((resume) => {
      NodeFS.write(fd, data, (cause) =>
        resume(
          cause === null
            ? Effect.void
            : Effect.fail(new DeviceLinkError({ operation: "write", cause })),
        ),
      );
    });
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
  const write = (data: string) =>
    Effect.callback<void, DeviceLinkError>((resume) => {
      port.write(data, (cause) =>
        resume(
          cause === null || cause === undefined
            ? Effect.void
            : Effect.fail(new DeviceLinkError({ operation: "write", cause })),
        ),
      );
    });
  return { write, chunks: chunksFrom(port) } satisfies DeviceLink;
});

const open = Effect.fn("SerialPorts.open")(function* (path: string) {
  yield* Effect.annotateCurrentSpan("path", path);
  return yield* process.platform === "win32" ? openWindows(path) : openPosix(path);
});

export const layer = Layer.succeed(SerialPorts, SerialPorts.of({ list, open }));
