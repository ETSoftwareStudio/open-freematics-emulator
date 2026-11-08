import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { scriptedLink } from "../device/scriptedLink.ts";
import * as ElmClient from "./ElmClient.ts";

const options = { onTraffic: () => Effect.void, onLinkLost: () => Effect.void };

describe("ElmClient", () => {
  it.effect("drops what a timed-out reply left behind before the next request", () =>
    Effect.gen(function* () {
      const { link } = yield* scriptedLink(["SEARCHING...\r41 00", "12.6V\r\r>"]);
      const client = yield* ElmClient.make(link, options);
      const first = yield* client.request("0100").pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(ElmClient.REQUEST_TIMEOUT);
      expect((yield* Fiber.join(first)).reason).toBe("timeout");
      expect(yield* client.request("ATRV")).toEqual(["12.6V"]);
    }),
  );
});
