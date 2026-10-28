import type { TrafficEntry } from "@fme/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

const HISTORY = 500;

export class TrafficLog extends Context.Service<
  TrafficLog,
  {
    readonly record: (
      channel: TrafficEntry["channel"],
      direction: TrafficEntry["direction"],
      text: string,
    ) => Effect.Effect<void>;
    /** Recent history first, then live entries. */
    readonly stream: Stream.Stream<TrafficEntry>;
  }
>()("@fme/server/traffic/TrafficLog") {}

const make = Effect.gen(function* () {
  const hub = yield* PubSub.unbounded<TrafficEntry>({ replay: HISTORY });
  const sequence = yield* Ref.make(0);
  // Called once per serial line; tracing each would drown the spans around it.
  const record = Effect.fnUntraced(function* (
    channel: TrafficEntry["channel"],
    direction: TrafficEntry["direction"],
    text: string,
  ) {
    const at = yield* Clock.currentTimeMillis;
    const next = yield* Ref.updateAndGet(sequence, (n) => n + 1);
    yield* PubSub.publish(hub, { sequence: next, at, channel, direction, text });
  });
  return TrafficLog.of({ record, stream: Stream.fromPubSub(hub) });
});

export const layer = Layer.effect(TrafficLog, make);
