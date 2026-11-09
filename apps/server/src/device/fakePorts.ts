import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { DeviceLinkError, type DeviceLink } from "./DeviceLink.ts";

/**
 * A system port opener the test drives. Each open makes a new link that answers what is written
 * with `answer`; `events` records every open and close of a descriptor.
 */
export const fakePorts = (answer: (written: string) => string | undefined = () => undefined) => {
  const state = {
    answer,
    failWrites: false,
    events: [] as Array<"open" | "close">,
    incoming: undefined as Queue.Queue<string, DeviceLinkError | Cause.Done> | undefined,
  };
  const openPort = (_path: string) =>
    Effect.acquireRelease(
      Effect.map(Queue.unbounded<string, DeviceLinkError | Cause.Done>(), (incoming) => {
        state.incoming = incoming;
        state.events.push("open");
        const link: DeviceLink = {
          write: (data) =>
            state.failWrites
              ? Effect.fail(new DeviceLinkError({ operation: "write", cause: new Error("gone") }))
              : Effect.sync(() => {
                  const reply = state.answer(typeof data === "string" ? data : "");
                  if (reply !== undefined) Queue.offerUnsafe(incoming, reply);
                }),
          chunks: Stream.fromQueue(incoming),
        };
        return link;
      }),
      () =>
        Effect.sync(() => {
          state.events.push("close");
        }),
    );
  return { state, openPort };
};
