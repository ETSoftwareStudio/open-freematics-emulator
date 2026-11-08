import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { DeviceLink } from "./DeviceLink.ts";

/** A link whose replies the test scripts: each written command pops the next canned reply. */
export const scriptedLink = Effect.fn("scriptedLink")(function* (
  replies: Array<string | undefined>,
) {
  const incoming = yield* Queue.unbounded<string, Cause.Done>();
  const written: Array<string | Uint8Array> = [];
  const link: DeviceLink = {
    write: (data) =>
      Effect.sync(() => {
        written.push(data);
        const reply = replies.shift();
        if (reply !== undefined) Queue.offerUnsafe(incoming, reply);
      }),
    chunks: Stream.fromQueue(incoming),
  };
  return { link, written, incoming };
});
