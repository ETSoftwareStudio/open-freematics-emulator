import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Subscribes again a second after a subscription fails, forever. A dropped socket fails every
 * subscription, so `None` goes out first: the last value is no longer live.
 */
export const resubscribing = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.map(Option.some),
    Stream.catchCause((cause) =>
      Stream.concat(Stream.succeed(Option.none<A>()), Stream.failCause(cause)),
    ),
    Stream.retry(Schedule.spaced("1 second")),
  );
