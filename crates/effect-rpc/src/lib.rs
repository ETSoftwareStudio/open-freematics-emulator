//! An [Effect](https://effect.website) RPC server for Rust.
//!
//! It speaks the protocol of Effect v4's `RpcServer.layerHttp({ protocol: "websocket" })` with
//! `RpcSerialization.layerJson`, so an unchanged Effect `RpcClient` (built from your `RpcGroup`
//! with `RpcClient.layerProtocolSocket` and `RpcSerialization.layerJson`) can call handlers
//! written in Rust.
//!
//! - [`Handlers`] registers a handler per rpc tag: unary, infallible or streaming.
//! - [`Connection`] runs one client's protocol over any transport: requests as tokio tasks,
//!   chunked streams with acks, interrupts, `Eof`, `Ping`, and Effect's close codes.
//! - [`axum::serve`] (feature `axum`) serves a connection over an axum WebSocket.
//! - [`schema`], [`tagged_struct!`] and [`string_enum!`] encode Rust types the way
//!   `Schema.toCodecJson` does.
//!
//! Feature `server` (default) brings the handler registry and connection, on tokio. Without it
//! the crate is just the wire types and serde helpers.
//!
//! ```
//! # #[cfg(feature = "server")] {
//! use effect_rpc::{Handlers, changes};
//! use tokio::sync::watch;
//!
//! effect_rpc::tagged_struct! {
//!     #[derive(Debug)]
//!     pub struct TooBig("TooBig") {
//!         pub limit: u32,
//!     }
//! }
//! effect_rpc::typed_errors!(TooBig);
//!
//! #[derive(serde::Deserialize)]
//! struct Add {
//!     by: u32,
//! }
//!
//! let (count, _) = watch::channel(0_u32);
//! let mut handlers = Handlers::new();
//! handlers
//!     .unary("Add", &count, |count, Add { by }| async move {
//!         if by > 10 {
//!             return Err(TooBig { limit: 10 });
//!         }
//!         count.send_modify(|count| *count += by);
//!         Ok(*count.borrow())
//!     })
//!     .stream("Watch", &count, |count, (): ()| changes(count.subscribe()));
//! # }
//! ```

mod cause;
mod macros;
pub mod message;
pub mod schema;

#[cfg(feature = "server")]
mod connection;
#[cfg(feature = "server")]
mod handlers;

#[cfg(feature = "axum")]
pub mod axum;

pub use cause::{Cause, Never, RpcError};
#[cfg(feature = "server")]
pub use connection::{Close, Connection};
#[cfg(feature = "server")]
pub use handlers::{Handlers, changes};
pub use message::{ClientMessage, Exit, Reason, Request, RequestId, ServerMessage};
