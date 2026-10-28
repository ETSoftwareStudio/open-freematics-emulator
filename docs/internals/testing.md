# Testing

Rules for writing tests and for asking for them in review.

## What to test

- Test behavior that can break: AT command formatting and response parsing, line framing, PID and
  readiness encoding, the session's connect/command/disconnect flows, timeouts, and the logic a bug
  fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke
  runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an
  assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails before the fix. Do not repeat the case in a wrapper
  test or at each call site.
- Server behavior runs against `SimulatedDevice`, the in-memory MK2 firmware model. When real
  hardware shows the simulator is wrong, fix the simulator and add the case that caught it.
- Bug fixes for logic, data, state, and protocol get a failing test first, then the fix. Purely
  visual bugs get before/after captures and no test.

## Waiting for work

Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.

- Effect code is tested with `it.effect` from `@effect/vitest`, which runs on a `TestClock`;
  `Effect.sleep` and command timeouts only advance through `TestClock.adjust`. `it.live` is
  wall-clock and only for real serial or socket fixtures.
- No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or read the
  `SubscriptionRef` change you are waiting for.
- No per-test timeout argument or `retry`. Flaky tests are fixed, not retried.
- No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
- `it.skip` and friends need a reason on the line above: `// quarantine: <why>`.
- Lint enforces this: `fme/no-test-timeout-or-unreasoned-skip`, `fme/no-wall-clock-in-tests`,
  `fme/no-real-time-wait-in-tests`, `fme/no-polling-loop-in-tests`,
  `fme/no-manual-effect-runtime-in-tests`.
