// @effect-diagnostics nodeBuiltinImport:off - Wi-Fi OBD adapters speak raw TCP; Node's net socket is the link.
import * as NodeNet from "node:net";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { DeviceLinkError, type DeviceLink } from "./DeviceLink.ts";

const CONNECT_TIMEOUT_MS = 5000;

export class TcpSockets extends Context.Service<
  TcpSockets,
  {
    readonly open: (
      host: string,
      port: number,
    ) => Effect.Effect<DeviceLink, DeviceLinkError, Scope.Scope>;
  }
>()("@fme/server/device/TcpSockets") {}

const open = Effect.fn("TcpSockets.open")(function* (host: string, port: number) {
  const socket = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Socket, DeviceLinkError>((resume) => {
      const connecting = NodeNet.connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
      const fail = (cause: unknown) => {
        connecting.destroy();
        resume(Effect.fail(new DeviceLinkError({ operation: "open", cause })));
      };
      connecting.once("connect", () => {
        connecting.setTimeout(0);
        connecting.off("error", fail);
        resume(Effect.succeed(connecting));
      });
      connecting.once("timeout", () => fail(new Error("connect timeout")));
      connecting.once("error", fail);
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  const write = (data: string) =>
    Effect.callback<void, DeviceLinkError>((resume) => {
      socket.write(data, (cause) =>
        resume(
          cause === undefined || cause === null
            ? Effect.void
            : Effect.fail(new DeviceLinkError({ operation: "write", cause })),
        ),
      );
    });
  const chunks = Stream.callback<string, DeviceLinkError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onData = (data: Buffer) => Queue.offerUnsafe(queue, data.toString("latin1"));
        const onError = (cause: unknown) =>
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(new DeviceLinkError({ operation: "read", cause })),
          );
        const onClose = () => Queue.endUnsafe(queue);
        socket.on("data", onData).on("error", onError).on("close", onClose);
        return () => {
          socket.off("data", onData).off("error", onError).off("close", onClose);
        };
      }),
      (detach) => Effect.sync(detach),
    ),
  );
  return { write, chunks } satisfies DeviceLink;
});

export const layer = Layer.succeed(TcpSockets, TcpSockets.of({ open }));
