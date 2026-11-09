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
- Server behavior runs against `SimulatedDevice` (`crates/fme-server/src/device`), the in-memory
  MK2 firmware model. When real hardware shows the simulator is wrong, fix the simulator and add
  the case that caught it.
- Bug fixes for logic, data, state, and protocol get a failing test first, then the fix. Purely
  visual bugs get before/after captures and no test.

## Waiting for work

Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.

- Rust tests run on paused time, `#[tokio::test(start_paused = true)]`; command timeouts only
  pass through `tokio::time::advance` or when every task is waiting.
- Effect code is tested with `it.effect` from `@effect/vitest`, which runs on a `TestClock`;
  `Effect.sleep` only advances through `TestClock.adjust`.
- No `yield_now`, `yieldNow` or `sleep` polling loops. Await the `oneshot` or `Deferred`, take from
  the channel or `Queue`, or wait for the `watch` change you need.
- No per-test timeout argument or `retry`. Flaky tests are fixed, not retried.
- No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
- `it.skip` and friends need a reason on the line above: `// quarantine: <why>`.
- Lint enforces this for TypeScript: `fme/no-test-timeout-or-unreasoned-skip`,
  `fme/no-wall-clock-in-tests`, `fme/no-real-time-wait-in-tests`, `fme/no-polling-loop-in-tests`,
  `fme/no-manual-effect-runtime-in-tests`.
