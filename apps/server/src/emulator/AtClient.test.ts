import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { DeviceLink } from "../device/DeviceLink.ts";
import * as AtClient from "./AtClient.ts";

/** A link whose replies the test scripts: each written command pops the next canned reply. */
const scriptedLink = Effect.fn("scriptedLink")(function* (replies: Array<string | undefined>) {
  const incoming = yield* Queue.unbounded<string, Cause.Done>();
  const written: Array<string> = [];
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

const options = { onTraffic: () => Effect.void, onLinkLost: () => Effect.void };

describe("AtClient", () => {
  it.effect("resolves commands on OK and rejects on ERROR", () =>
    Effect.gen(function* () {
      const { link, written } = yield* scriptedLink(["O", "ERROR\r"]);
      const client = yield* AtClient.make(link, options);
      // "O" alone never completes a line, so the first command waits for the rest.
      const first = yield* client.command("ATE0").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(written).toEqual(["ATE0\r"]);
      yield* TestClock.adjust("1 second");
      expect(first.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      const timedOut = yield* Fiber.join(first).pipe(Effect.flip);
      expect(timedOut.reason).toBe("timeout");

      const rejected = yield* client.command("ATBOGUS").pipe(Effect.flip);
      expect(rejected.reason).toBe("rejected");
    }),
  );

  it.effect("drops stale lines before a new command", () =>
    Effect.gen(function* () {
      const { link, incoming } = yield* scriptedLink(["0105=82 \r"]);
      const client = yield* AtClient.make(link, options);
      Queue.offerUnsafe(incoming, "OK\r");
      yield* Effect.yieldNow;
      expect(yield* client.query("ATGET 0105")).toBe("0105=82");
    }),
  );

  it.effect("skips the echo when answering a query", () =>
    Effect.gen(function* () {
      const { link } = yield* scriptedLink(["ATGET VIN\r1HGCD5654VA061985\r\n"]);
      const client = yield* AtClient.make(link, options);
      expect(yield* client.query("ATGET VIN")).toBe("1HGCD5654VA061985");
    }),
  );

  it.effect("collects the reset banner through the info line", () =>
    Effect.gen(function* () {
      const { link } = yield* scriptedLink([
        "OBD-II EMULATOR V1.2\r\nOBD-II EMULATOR V1.2\r\n00.00.02,00.01.05,201910,X,VIN\r\n",
      ]);
      const client = yield* AtClient.make(link, options);
      expect(yield* client.reset).toEqual([
        "OBD-II EMULATOR V1.2",
        "OBD-II EMULATOR V1.2",
        "00.00.02,00.01.05,201910,X,VIN",
      ]);
    }),
  );

  it.effect("keeps replies paired with commands when a caller gives up mid-exchange", () =>
    Effect.gen(function* () {
      const { link, incoming } = yield* scriptedLink([]);
      const client = yield* AtClient.make(link, options);
      const first = yield* client.command("ATACC1").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const interrupting = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
      const second = yield* client.command("ATBOGUS").pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      // The first command's late OK must not be taken as the answer to the second.
      Queue.offerUnsafe(incoming, "OK\r");
      yield* Fiber.join(interrupting);
      yield* Effect.yieldNow;
      Queue.offerUnsafe(incoming, "ERROR\r");
      expect((yield* Fiber.join(second)).reason).toBe("rejected");
    }),
  );

  it.effect("reports a lost link", () =>
    Effect.gen(function* () {
      const { link, incoming } = yield* scriptedLink([]);
      let lost = 0;
      yield* AtClient.make(link, { ...options, onLinkLost: () => Effect.sync(() => lost++) });
      yield* Queue.end(incoming);
      yield* Effect.yieldNow;
      expect(lost).toBe(1);
    }),
  );
});
