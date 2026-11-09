//! Serving Effect RPC over an axum WebSocket, as `RpcServer.layerHttp({ protocol: "websocket" })`
//! does.
//!
//! ```no_run
//! use std::sync::Arc;
//!
//! use axum::Router;
//! use axum::extract::{State, WebSocketUpgrade};
//! use axum::response::Response;
//! use axum::routing::get;
//! use effect_rpc::Handlers;
//!
//! async fn rpc(State(handlers): State<Arc<Handlers>>, upgrade: WebSocketUpgrade) -> Response {
//!     upgrade.on_upgrade(move |socket| effect_rpc::axum::serve(socket, handlers))
//! }
//!
//! let app: Router = Router::new()
//!     .route("/rpc", get(rpc))
//!     .with_state(Arc::new(Handlers::new()));
//! ```

use std::ops::ControlFlow;
use std::sync::Arc;
use std::time::Duration;

use ::axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::connection::{Close, Connection};
use crate::handlers::Handlers;
use crate::message::ServerMessage;

enum Outgoing {
    Message(ServerMessage),
    Close(Close),
}

// How long a closing connection may take to flush its close frame.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// Serves one client until it disconnects or breaks the protocol, then interrupts everything it
/// still has running. Text and binary frames are both read as JSON; responses go out one message
/// per text frame.
pub async fn serve(socket: WebSocket, handlers: Arc<Handlers>) {
    let (mut sink, mut incoming) = socket.split();
    let (outgoing, mut queue) = mpsc::unbounded_channel();
    let mut writer = tokio::spawn(async move {
        while let Some(outgoing) = queue.recv().await {
            let message = match outgoing {
                Outgoing::Message(message) => match serde_json::to_string(&message) {
                    Ok(text) => Message::Text(text.into()),
                    Err(error) => {
                        tracing::error!(%error, "Dropped a response that didn't encode");
                        continue;
                    }
                },
                Outgoing::Close(close) => Message::Close(Some(CloseFrame {
                    code: close.code(),
                    reason: "".into(),
                })),
            };
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
    });
    let responses = outgoing.clone();
    let connection = Connection::new(handlers, move |message| {
        if responses.send(Outgoing::Message(message)).is_err() {
            tracing::debug!("Dropped a response for a closed connection");
        }
    });
    let mut close = None;
    while let Some(Ok(message)) = incoming.next().await {
        let frame = match message {
            Message::Text(text) => text.as_str().to_owned(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
        };
        if let ControlFlow::Break(reason) = connection.receive(&frame) {
            close = Some(reason);
            break;
        }
    }
    drop(connection);
    match close {
        Some(close) => {
            tracing::debug!(code = close.code(), "Closing the connection");
            if outgoing.send(Outgoing::Close(close)).is_ok()
                && tokio::time::timeout(CLOSE_TIMEOUT, &mut writer)
                    .await
                    .is_err()
            {
                writer.abort();
            }
        }
        None => writer.abort(),
    }
}
