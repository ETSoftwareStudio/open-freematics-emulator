# Rust services

The Rust server (`crates/`) ports the Effect server one service at a time and keeps its rules.
Read [Effect services](effect-services.md) first; this page says how each rule is written in
Rust. Clippy lints in the workspace `Cargo.toml` enforce the mechanical parts.

## Crates

- `effect-rpc`: Effect RPC's WebSocket protocol and JSON codec, with nothing of this app in it,
  so it can be published on its own. Its `schema` helpers and `tagged_struct!`/`string_enum!`
  build the wire types; the `server` and `axum` features add the handler registry and the
  socket.
- `fme-core`: pure helpers and wire types, the counterpart of `packages/shared` and
  `packages/contracts`. No I/O, no async, no tokio.
- `fme-server`: services, the RPC handler table, HTTP and the binary.

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

## Transport

`effect-rpc` speaks Effect RPC over a WebSocket exactly as `RpcServer.layerHttp({ protocol:
"websocket" })` with `RpcSerialization.layerJson` does, so the unchanged web client drives either
server. `fme-server/src/ws.rs` is the table: one service call per method, as in `ws.ts`. Contract
errors implement `RpcError` in `fme-core` with `typed_errors!`. Wire rules:

- A frame holds one JSON message or an array of them. Responses go out one per frame.
- Each request runs as its own task. A typed error is an `Exit` with a `Fail` cause; a handler
  defect (`Cause::Die`, or a panic) is a connection-wide `Defect` message, as Effect sends it.
  An unknown tag or a payload that doesn't decode is an `Exit` with a `Die` cause.
- A stream sends one `Chunk`, then waits for the client's `Ack`. `changes` streams a `watch`:
  the current value, then the latest after each change, so unacked changes coalesce.
- `Interrupt` drops the request's future and answers with an interrupt `Exit`; a disconnect drops
  them all. Device exchanges run in actors, so none stops halfway.
- Effect's quirks are kept: a reused running id, or a request after `Eof` while others run,
  closes the socket (1001); a `null` message closes it (1011).

`http.rs` serves `/ws`, `/api/health` and the built web app (Effect's static server rules and
MIME types) behind the loopback same-origin guard. The `fme` binary takes `bin.ts`'s flags.
`server::Server` binds first (port 0 picks a free one) and serves until a shutdown future
resolves, then closes the device links and the macOS Bluetooth ports `SerialPorts` holds open
(macOS serves those only until their first close); the Tauri app (`apps/desktop-tauri`) runs it
in-process that way.

## Checking

`vp run rs:check` runs `cargo fmt --check`, clippy with warnings denied, and the tests.
`vp run check` includes it.

`vp run conformance` starts both servers on free ports with fresh temp data dirs, drives each
through the real Effect client on the simulated device (plus raw protocol frames and HTTP probes),
and diffs the normalized transcripts. Only timestamps, the measured poll rate, random preset ids
and the temp data dir are normalized. `vp run dev:rs` is `vp run dev` with the Rust server.
