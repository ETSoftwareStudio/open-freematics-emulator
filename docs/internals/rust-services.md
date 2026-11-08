# Rust services

The Rust server (`crates/`) ports the Effect server one service at a time and keeps its rules.
Read [Effect services](effect-services.md) first; this page says how each rule is written in
Rust. Clippy lints in the workspace `Cargo.toml` enforce the mechanical parts.

## Crates

- `fme-core`: pure helpers and wire types, the counterpart of `packages/shared` and
  `packages/contracts`. No I/O, no async, no tokio.
- `fme-server`: services, the WebSocket RPC transport, HTTP and the binary.

## Effect to Rust

| Effect                                | Rust                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Context.Service` + `layer`           | A struct with its dependencies as fields, built by `new` (or `spawn` for an actor). A swappable dependency is a trait (`DeviceLink`); the simulator implements the same trait.       |
| `Schema.TaggedError`                  | One `thiserror` enum per service, variants with structured fields. `#[error]` text is fixed or built from those fields, never from the source error. Keep the source as `#[source]`. |
| `Effect.catchTags`                    | `match` on the variants you handle; pass the rest through with `?`.                                                                                                                  |
| `Effect.fn("Service.operation")`      | `#[tracing::instrument(name = "Service.operation", skip_all, fields(...))]` with only safe, bounded fields.                                                                          |
| `SubscriptionRef` streamed to clients | `tokio::sync::watch`.                                                                                                                                                                |
| Uninterruptible device exchange       | An actor: one task owns the link, callers send requests over `mpsc` and wait on a `oneshot`. Dropping a caller never stops an exchange halfway.                                      |
| `Schema` decode and encode            | `serde` types in `fme-core`, with newtypes for branded values. Their JSON must match what the TypeScript schemas encode.                                                             |
| `TestClock`                           | `#[tokio::test(start_paused = true)]` and `tokio::time::advance`.                                                                                                                    |

## Rules

- Transports stay thin: decode, call one service method, map errors.
- No `unwrap`, `expect`, `panic!`, `todo!` or printing outside tests. Log with `tracing`.
- Default to no comment, as in TypeScript.
- Tests run against the simulated device and follow [Testing](testing.md): no sleeps, no wall
  clock, no polling. Port a service's TypeScript tests with it, case for case.
- Nothing may address flash below `0x08003800`, and the wire key never enters the repo.

## Checking

`vp run rs:check` runs `cargo fmt --check`, clippy with warnings denied, and the tests.
`vp run check` includes it.
