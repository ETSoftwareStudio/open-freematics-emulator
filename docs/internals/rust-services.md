# Rust services

The server lives in `crates/`. It started as a port of an Effect server and keeps its design:
features are services, transports are thin, errors are structured. The table below gives the Rust
form of each Effect idiom the contracts and the web client still use. Clippy lints in the
workspace `Cargo.toml` enforce the mechanical parts.

## Crates

- `effect-rpc`: Effect RPC's WebSocket protocol and JSON codec, with nothing of this app in it,
  so it can be published on its own. Its `schema` helpers and `tagged_struct!`/`string_enum!`
  build the wire types; the `server` and `axum` features add the handler registry and the
  socket.
- `fme-core`: pure helpers and wire types, the counterpart of `packages/shared` and
  `packages/contracts`. No I/O, no async, no tokio.
- `fme-server`: services, the RPC handler table, HTTP and the binary.

## Services

- A server capability is a method on the service that owns its domain (`device/`, `emulator/`,
  `firmware/`, `obd/`, `presets/`, `traffic/`). Extend that service before adding a new one.
- A transport handler decodes the request, calls one service method, and maps the service's
  errors. Multi-step work, retries, persistence and rollback belong in the service, so the RPC
  table, the binary and the Tauri shell all get them and tests need no socket.
- Error fields stay bounded: no raw payloads, command output, credentials or arbitrary error
  text; the exact value lives only in the `#[source]`. Construct the error where the failure
  happens and map it to a contract error only in the transport. Don't encode one distinction
  twice, as a variant and a single-value `reason`.

## Effect to Rust

| Effect idiom                          | Rust                                                                                                                                                                                 |
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
- Default to no comment.
- Tests run against the simulated device and follow [Testing](testing.md): no sleeps, no wall
  clock, no polling.
- Nothing may address flash below `0x08003800`, and the wire key never enters the repo.

## Transport

`effect-rpc` speaks Effect RPC over a WebSocket exactly as `RpcServer.layerHttp({ protocol:
"websocket" })` with `RpcSerialization.layerJson` does, so the web client's Effect `RpcClient`
drives it unchanged. `fme-server/src/ws.rs` is the table: one service call per method. Contract
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
MIME types) behind the loopback same-origin guard. The guard refuses a request unless the
connection comes from a loopback address, the `Host` header names a loopback host, and the
`Origin`, when there is one, is the server's own or the desktop window's. `Server::serve` gives
the guard the peer address; a router served any other way refuses everything. Every response
carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`,
so no other page can frame the web app. The `fme` binary takes `--host` (a loopback address only:
`127.0.0.1` or `::1`), `--port`, `--data-dir`, `--web-root`, `--app-origin` and `--dev` (no web
app; Vite serves it).
`server::Server` binds first (port 0 picks a free one) and serves until a shutdown future
resolves, then closes the device links and the macOS Bluetooth ports `SerialPorts` holds open
(macOS serves those only until their first close); the Tauri app (`apps/desktop-tauri`) runs it
in-process that way.

## Checking

`vp run rs:check` runs `cargo fmt --check`, clippy with warnings denied, and the tests, the last
two with `--locked`, so a stale `Cargo.lock` fails the check. `rust-toolchain.toml` pins the
compiler for rustup, which CI and releases use. `vp run check` includes it. `vp run dev` builds `fme` and runs it with `--dev` next to Vite.

The wire itself is pinned by `crates/fme-server/tests`. `rpc_methods.rs` drives every RPC through
one `effect_rpc::Connection` on the simulated device and paused time, as the web client's
`RpcClient` would (acks, interrupts), and asserts each `Exit` and `Chunk` frame exactly; only
timestamps, the measured poll rate, random preset ids and the temp data dir are normalized.
`rpc_transport.rs` runs the server on a loopback port for the raw protocol cases, the close codes
and the HTTP routes behind the guard. Error messages come from the contract classes on the client,
so the tests cover each error's tag and fields, not its text. After an intended change to what goes
over the wire, update the expected frames there and check the web client still decodes them.
