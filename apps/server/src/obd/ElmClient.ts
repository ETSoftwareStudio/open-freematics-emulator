import { ReaderCommandError } from "@fme/contracts";
import { isNoAnswer } from "@fme/shared/elm327";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { DeviceLink, DeviceLinkError } from "../device/DeviceLink.ts";

export const REQUEST_TIMEOUT = Duration.seconds(3);
/** A cold Bluetooth link takes seconds to come up before the adapter even sees the reset. */
export const RESET_TIMEOUT = Duration.seconds(8);
/** The first request after reset makes the adapter search every protocol. */
export const SEARCH_TIMEOUT = Duration.seconds(12);

export interface ElmClient {
  /** Sends one command and returns the reply lines before the `>` prompt. */
  readonly request: (
    command: string,
    options?: RequestOptions,
  ) => Effect.Effect<ReadonlyArray<string>, ReaderCommandError>;
  /** Like `request`, but fails with `no-answer` when the vehicle side stays silent. */
  readonly query: (
    command: string,
    options?: RequestOptions,
  ) => Effect.Effect<ReadonlyArray<string>, ReaderCommandError>;
  /** Whether any byte at all has arrived since the client started. */
  readonly received: Effect.Effect<boolean>;
}

export interface RequestOptions {
  readonly timeout?: Duration.Duration;
  /** Keeps routine polls out of the traffic log; their results show up in the reader state. */
  readonly quiet?: boolean;
}

export interface ElmClientOptions {
  readonly onTraffic: (direction: "tx" | "rx", text: string) => Effect.Effect<void>;
  readonly onLinkLost: (cause: DeviceLinkError | undefined) => Effect.Effect<void>;
}

/** ELM327 replies end with a `>` prompt instead of OK/ERROR, and may span several lines. */
export const make = Effect.fn("ElmClient.make")(function* (
  link: DeviceLink,
  options: ElmClientOptions,
): Effect.fn.Return<ElmClient, never, Scope.Scope> {
  const replies = yield* Queue.unbounded<ReadonlyArray<string>>();
  const lock = yield* Semaphore.make(1);
  let buffer = "";
  let received = false;
  // Replies are logged as they arrive, so one that comes after its request timed out still shows.
  let logReplies = true;

  const linesOf = (text: string) =>
    text
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  // Per-line work stays untraced, like the read loop that calls it.
  const logReply = Effect.fnUntraced(function* (lines: ReadonlyArray<string>) {
    if (!logReplies) return;
    for (const line of lines) yield* options.onTraffic("rx", line);
  });

  // Per-chunk work stays untraced; the read loop runs for the life of the connection.
  yield* link.chunks.pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (chunk: string) {
        received ||= chunk.length > 0;
        buffer += chunk;
        let prompt = buffer.indexOf(">");
        while (prompt !== -1) {
          const lines = linesOf(buffer.slice(0, prompt));
          buffer = buffer.slice(prompt + 1);
          yield* logReply(lines);
          yield* Queue.offer(replies, lines);
          prompt = buffer.indexOf(">");
        }
      }),
    ),
    Effect.matchEffect({
      onFailure: (cause) => options.onLinkLost(cause),
      onSuccess: () => options.onLinkLost(undefined),
    }),
    Effect.forkScoped,
  );

  const request = (
    command: string,
    { timeout = REQUEST_TIMEOUT, quiet = false }: RequestOptions = {},
  ) =>
    lock
      .withPermit(
        // A written command's reply is coming; abandoning it would hand it to the next command.
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Queue.clear(replies);
            buffer = "";
            logReplies = !quiet;
            if (!quiet) yield* options.onTraffic("tx", command);
            yield* link
              .write(`${command}\r`)
              .pipe(Effect.mapError(() => new ReaderCommandError({ command, reason: "link" })));
            const lines = yield* Queue.take(replies).pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.suspend(() => {
                    const partial = linesOf(buffer);
                    buffer = "";
                    return Effect.andThen(
                      logReply(partial),
                      Effect.fail(new ReaderCommandError({ command, reason: "timeout" })),
                    );
                  }),
              }),
            );
            return lines.filter((line) => line.replaceAll(" ", "") !== command.replaceAll(" ", ""));
          }),
        ),
      )
      .pipe(Effect.withSpan("ElmClient.request", { attributes: { command } }));

  const query = (command: string, requestOptions?: RequestOptions) =>
    request(command, requestOptions).pipe(
      Effect.filterOrFail(
        (lines) => !isNoAnswer(lines),
        () => new ReaderCommandError({ command, reason: "no-answer" }),
      ),
    );

  return { request, query, received: Effect.sync(() => received) } satisfies ElmClient;
});
