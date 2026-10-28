import { EmulatorCommandError } from "@fme/contracts";
import { isErrorLine, isOkLine } from "@fme/shared/atCommands";
import { makeLineFramer } from "@fme/shared/lineFramer";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { DeviceLink, DeviceLinkError } from "../device/DeviceLink.ts";

export const COMMAND_TIMEOUT = Duration.millis(1500);
export const RESET_TIMEOUT = Duration.seconds(3);

export interface AtClient {
  /** Sends a command that answers `OK` or `ERROR`. */
  readonly command: (command: string) => Effect.Effect<void, EmulatorCommandError>;
  /** Sends an `ATGET` query and returns its value line. */
  readonly query: (command: string) => Effect.Effect<string, EmulatorCommandError>;
  /** Sends `ATZ` and returns the banner and info lines it prints. */
  readonly reset: Effect.Effect<ReadonlyArray<string>, EmulatorCommandError>;
  /** Sends anything and returns whatever lines come back. */
  readonly raw: (command: string) => Effect.Effect<ReadonlyArray<string>, EmulatorCommandError>;
}

export interface AtClientOptions {
  readonly onTraffic: (direction: "tx" | "rx", text: string) => Effect.Effect<void>;
  /** Runs once if the link fails or closes underneath the client. */
  readonly onLinkLost: (cause: DeviceLinkError | undefined) => Effect.Effect<void>;
}

/**
 * Wraps a link for one connection. Commands run one at a time; lines left over from an earlier
 * command (late replies, debug output) are discarded before each send.
 */
export const make = Effect.fn("AtClient.make")(function* (
  link: DeviceLink,
  options: AtClientOptions,
): Effect.fn.Return<AtClient, never, Scope.Scope> {
  const lines = yield* Queue.unbounded<string>();
  const lock = yield* Semaphore.make(1);
  const frame = makeLineFramer();

  // Per-chunk work stays untraced; the read loop runs for the life of the connection.
  yield* link.chunks.pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (chunk: string) {
        for (const line of frame(chunk)) {
          yield* options.onTraffic("rx", line);
          yield* Queue.offer(lines, line);
        }
      }),
    ),
    Effect.matchEffect({
      onFailure: (cause) => options.onLinkLost(cause),
      onSuccess: () => options.onLinkLost(undefined),
    }),
    Effect.forkScoped,
  );

  const exchange = <A>(
    command: string,
    timeout: Duration.Duration,
    collect: Effect.Effect<A, EmulatorCommandError>,
  ) =>
    lock.withPermit(
      // Once a command is written its reply is coming; abandoning the wait would hand that
      // reply to the next command. Callers can still give up while queued for the lock.
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Queue.clear(lines);
          yield* options.onTraffic("tx", command);
          yield* link
            .write(`${command}\r`)
            .pipe(Effect.mapError(() => new EmulatorCommandError({ command, reason: "link" })));
          return yield* collect.pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new EmulatorCommandError({ command, reason: "timeout" })),
            }),
          );
        }),
      ),
    );

  const isEcho = (command: string, line: string) =>
    line.replaceAll(" ", "").toUpperCase() === command.replaceAll(" ", "").toUpperCase();

  const command = (command: string) =>
    exchange(
      command,
      COMMAND_TIMEOUT,
      Effect.gen(function* () {
        while (true) {
          const line = yield* Queue.take(lines);
          if (isOkLine(line)) return;
          if (isErrorLine(line)) {
            return yield* new EmulatorCommandError({ command, reason: "rejected" });
          }
        }
      }),
    ).pipe(Effect.withSpan("AtClient.command", { attributes: { command } }));

  const query = (command: string) =>
    exchange(
      command,
      COMMAND_TIMEOUT,
      Effect.gen(function* () {
        while (true) {
          const line = yield* Queue.take(lines);
          if (isEcho(command, line) || isOkLine(line)) continue;
          if (isErrorLine(line)) {
            return yield* new EmulatorCommandError({ command, reason: "rejected" });
          }
          return line;
        }
      }),
    ).pipe(Effect.withSpan("AtClient.query", { attributes: { command } }));

  // The info line (comma-separated) is the last thing the firmware prints after a reset.
  const reset = exchange(
    "ATZ",
    RESET_TIMEOUT,
    Effect.gen(function* () {
      const received: Array<string> = [];
      while (true) {
        const line = yield* Queue.take(lines);
        if (isEcho("ATZ", line)) continue;
        received.push(line);
        if (line.includes(",")) return received;
      }
    }),
  ).pipe(Effect.withSpan("AtClient.reset"));

  const isComplete = (command: string, received: ReadonlyArray<string>) => {
    const last = received.at(-1);
    if (last === undefined) return false;
    if (isErrorLine(last)) return true;
    const normalized = command.replaceAll(" ", "").toUpperCase();
    if (normalized.startsWith("ATGET")) return !isEcho(command, last);
    if (normalized === "ATZ" || normalized === "ATR") return last.includes(",");
    return isOkLine(last);
  };

  // Stops on the reply shape the firmware uses for each command; on timeout, keeps what arrived.
  const raw = (command: string) =>
    Effect.suspend(() => {
      const received: Array<string> = [];
      const collect = Effect.gen(function* () {
        while (!isComplete(command, received)) received.push(yield* Queue.take(lines));
        return received;
      });
      return exchange(command, RESET_TIMEOUT, collect).pipe(
        Effect.catchIf(
          (error) => error.reason === "timeout" && received.length > 0,
          () => Effect.succeed(received),
        ),
      );
    }).pipe(Effect.withSpan("AtClient.raw", { attributes: { command } }));

  return { command, query, reset, raw } satisfies AtClient;
});
