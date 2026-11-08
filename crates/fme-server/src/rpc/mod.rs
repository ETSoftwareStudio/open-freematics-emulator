//! Effect RPC over a WebSocket, wire-compatible with `RpcServer.layerHttp({ protocol:
//! "websocket" })` and `RpcSerialization.layerJson`, so the web app's Effect client talks to this
//! server unchanged.
//!
//! Each text frame holds one JSON message or an array of them. From the client: `Request`,
//! `Ack`, `Interrupt`, `Ping` and `Eof`. From the server: `Chunk`, `Exit`, `Defect` and `Pong`.
//! A stream sends one `Chunk` at a time and waits for the client's `Ack` before the next. An
//! `Interrupt` drops the request's task; device exchanges run in actors, so none stops halfway.

pub mod connection;
pub mod handlers;

pub use handlers::{Cause, Never, RpcError, RpcHandlers, changes};

#[cfg(test)]
mod tests;
