import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { resubscribing } from "./resubscribing.ts";

it.effect("marks a dropped subscription, then subscribes again", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const subscription = Stream.unwrap(
      Ref.updateAndGet(attempts, (n) => n + 1).pipe(
        Effect.map((attempt) =>
          attempt === 1
            ? Stream.concat(Stream.succeed("before"), Stream.fail("socket closed"))
            : Stream.succeed("after"),
        ),
      ),
    );
    const collected = yield* resubscribing(subscription).pipe(Stream.runCollect, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(collected)).toEqual([
      Option.some("before"),
      Option.none(),
      Option.some("after"),
    ]);
  }),
);
