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

  // Per-chunk work stays untraced; the read loop runs for the life of the connection.
  yield* link.chunks.pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (chunk: string) {
        buffer += chunk;
        let prompt = buffer.indexOf(">");
        while (prompt !== -1) {
          const lines = buffer
            .slice(0, prompt)
            .split(/[\r\n]+/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          buffer = buffer.slice(prompt + 1);
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
            if (!quiet) yield* options.onTraffic("tx", command);
            yield* link
              .write(`${command}\r`)
              .pipe(Effect.mapError(() => new ReaderCommandError({ command, reason: "link" })));
            const lines = yield* Queue.take(replies).pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () => Effect.fail(new ReaderCommandError({ command, reason: "timeout" })),
              }),
            );
            if (!quiet) for (const line of lines) yield* options.onTraffic("rx", line);
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

  return { request, query } satisfies ElmClient;
});
