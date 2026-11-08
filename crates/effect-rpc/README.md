# effect-rpc

An [Effect](https://effect.website) RPC server for Rust. Write the handlers of an `RpcGroup` in
Rust and call them from an unchanged Effect `RpcClient`.

It speaks the protocol of Effect v4's `RpcServer.layerHttp({ protocol: "websocket" })` with
`RpcSerialization.layerJson`: the client connects with `RpcClient.layerProtocolSocket()` over a
WebSocket and JSON serialization, exactly as it would to a TypeScript server.

Tested against `effect` **4.0.5**. Not yet published to crates.io.

## Example

The Effect side, as usual:

```ts
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

class StepTooLarge extends Schema.TaggedError<StepTooLarge>()("StepTooLarge", {
  maxStep: Schema.Number,
}) {}

export const CounterRpcs = RpcGroup.make(
  Rpc.make("Increment", {
    payload: { step: Schema.Int },
    success: Schema.Number,
    error: StepTooLarge,
  }),
  Rpc.make("Reset"),
  Rpc.make("Count", { success: Schema.Number, stream: true }),
);
```

The Rust side ([`examples/counter.rs`](examples/counter.rs), run it with
`cargo run --example counter --features axum`):

```rust,ignore
use effect_rpc::{Handlers, changes};

effect_rpc::tagged_struct! {
    #[derive(Debug)]
    pub struct StepTooLarge("StepTooLarge") {
        pub max_step: u32,
    }
}
effect_rpc::typed_errors!(StepTooLarge);

#[derive(serde::Deserialize)]
struct Increment {
    step: u32,
}

let (count, _) = tokio::sync::watch::channel(0_u32);
let mut handlers = Handlers::new();
handlers
    .unary("Increment", &count, |count, Increment { step }| async move {
        if step > 10 {
            return Err(StepTooLarge { max_step: 10 });
        }
        count.send_modify(|count| *count += step);
        Ok(*count.borrow())
    })
    .infallible("Reset", &count, |count, (): ()| async move {
        count.send_replace(0);
    })
    .stream("Count", &count, |count, (): ()| changes(count.subscribe()));

// In an axum route: upgrade.on_upgrade(|socket| effect_rpc::axum::serve(socket, handlers))
```

Each handler gets a context (cloned into every call; pass `&()` when there is none) and its
payload, decoded with serde. `Schema.Void` payloads and successes are `()`.

## Supported

- **Unary rpcs**: `Handlers::unary` (typed errors) and `Handlers::infallible`.
- **Streaming rpcs** (`stream: true`): `Handlers::stream` and `Handlers::try_stream`. Each item
  goes out as one `Chunk`, and the next waits for the client's `Ack`, so a slow client applies
  backpressure. `changes` streams a `tokio::sync::watch` like `SubscriptionRef.changes`.
- **Typed errors**: a handler's error implements `RpcError`; `typed_errors!` covers errors that
  encode as the rpc's error schema. They reach the client as `Fail`.
- **Defects**: `Cause::Die` and handler panics are reported the way Effect's server reports
  them, as a connection-wide `Defect` message. Unknown tags and payloads that don't decode answer
  the request with `Die`.
- **Interrupts**: an `Interrupt` drops the handler's future and answers with an interrupted
  `Exit`; a disconnect drops every running handler.
- `Ping`/`Pong`, `Eof`, batched frames (a JSON array of messages), binary frames, and Effect's
  close codes: 1001 for a reused request id or a request after `Eof`, 1011 for a `null` message.
- **Schema JSON codec helpers** (`effect_rpc::schema`): `Schema.Number` with `NaN` and the
  infinities as strings, `Schema.Finite`, `Schema.NullOr`, records in insertion order,
  `Schema.Uint8Array` as Base64, `Schema.NonEmptyString`, filters. `tagged_struct!` encodes
  `Schema.TaggedError`/`TaggedStruct` and rejects other `_tag`s on decode; `string_enum!` encodes
  `Schema.Literals`. Messages Effect builds from template strings print numbers as JavaScript
  does.

## Not supported

- Other serializations: `RpcSerialization.layerNdjson`, `layerJsonRpc`, `layerNdJsonRpc` and
  `layerSchemaBinary` (MessagePack).
- Other protocols: `RpcServer.layerProtocolHttp` (HTTP request/response), the raw socket server
  (`layerProtocolSocketServer`), `layerProtocolStdio` and `layerProtocolWorkerRunner`.
- Request headers, `RpcMiddleware`, and trace propagation (`traceId`, `spanId`): accepted on the
  wire, not passed to handlers.
- Server options: `concurrency` (every request runs concurrently, Effect's default `"unbounded"`),
  `disableFatalDefects`, `spanPrefix`, and the `fork`/`uninterruptible` handler wrappers.
- A client, and code generation from schemas: the Rust types are written by hand with serde.
- An interrupted request's `Exit` has no `fiberId`; Effect's client ignores it.

## Features

- `server` (default): `Handlers`, `Connection` and `changes`, on tokio. Without it the crate is
  the wire messages and the schema helpers only.
- `axum`: `effect_rpc::axum::serve`, which runs a `Connection` over an axum WebSocket. Other
  transports drive `Connection` directly: feed it frames with `receive`, and it hands each
  response to the callback it was built with.

## How compatibility is checked

- This crate's tests drive the protocol over a real loopback WebSocket with raw frames, covering
  each rule above.
- It was extracted from a server whose conformance suite runs the TypeScript server
  (`RpcServer.layerHttp` with `RpcSerialization.layerJson`) and the Rust server built on this
  crate side by side, drives both with the real Effect `RpcClient` and with raw protocol frames,
  and diffs the transcripts: 131 checks, all identical, on `effect` 4.0.5.
- The protocol source of truth is `effect/src/rpc/RpcServer.ts`, `RpcMessage.ts` and
  `RpcSerialization.ts` in Effect's repository.

## License

MIT
