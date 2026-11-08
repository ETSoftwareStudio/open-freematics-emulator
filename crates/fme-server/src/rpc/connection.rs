//! One WebSocket client: decodes its frames, runs each request as its own task, and writes the
//! responses back in the order they are produced.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, close_code};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::Instrument;

use super::handlers::{Call, Cause, Chunks, RpcHandlers};

/// A request id as the client sent it, a string or a number, kept apart by its JSON form.
type RequestKey = String;

struct Running {
    interrupt: Option<oneshot::Sender<()>>,
    /// Effect's per-stream latch: closed while a chunk awaits the client's `Ack`.
    latch: Arc<watch::Sender<bool>>,
}

enum End {
    Success(Value),
    Failed(Cause),
    Interrupted,
}

/// Why the connection must close, as the WebSocket close code Effect's server sends.
type Close = u16;

enum Outgoing {
    Message(Value),
    Close(Close),
}

#[derive(Default)]
struct State {
    requests: HashMap<RequestKey, Running>,
    /// Set by `Eof` while requests run; cleared once they all finish, as Effect forgets the client.
    ended: bool,
}

struct Connection {
    handlers: Arc<RpcHandlers>,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    state: Mutex<State>,
}

// How long a closing connection may take to flush its close frame.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// Serves one client until it disconnects, then interrupts everything it still has running.
pub async fn serve(socket: WebSocket, handlers: Arc<RpcHandlers>) {
    let (mut sink, mut incoming) = socket.split();
    let (outgoing, mut queue) = mpsc::unbounded_channel();
    let mut writer = tokio::spawn(async move {
        while let Some(outgoing) = queue.recv().await {
            let message = match outgoing {
                Outgoing::Message(message) => Message::Text(message.to_string().into()),
                Outgoing::Close(code) => Message::Close(Some(CloseFrame {
                    code,
                    reason: "".into(),
                })),
            };
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
    });
    let connection = Arc::new(Connection {
        handlers,
        outgoing,
        state: Mutex::new(State::default()),
    });
    let mut close = None;
    while let Some(Ok(message)) = incoming.next().await {
        let text = match message {
            Message::Text(text) => text.as_str().to_owned(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
        };
        if let ControlFlow::Break(code) = Arc::clone(&connection).receive(&text) {
            close = Some(code);
            break;
        }
    }
    connection.state().requests.clear();
    match close {
        Some(code) => {
            tracing::debug!(code, "Closing the connection");
            if connection.outgoing.send(Outgoing::Close(code)).is_ok()
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

fn exit(id: &Value, exit: Value) -> Value {
    json!({ "_tag": "Exit", "requestId": id, "exit": exit })
}

fn failure(reason: Value) -> Value {
    json!({ "_tag": "Failure", "cause": [reason] })
}

fn die(defect: Value) -> Value {
    failure(json!({ "_tag": "Die", "defect": defect }))
}

/// How JavaScript prints a value in a template string, for messages Effect builds that way.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "The handler panicked.".to_owned())
}

async fn opened(latch: &watch::Sender<bool>) {
    let mut open = latch.subscribe();
    // The caller holds the sender, so the wait can't fail.
    drop(open.wait_for(|open| *open).await);
}

impl Connection {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn send(&self, message: Value) {
        if self.outgoing.send(Outgoing::Message(message)).is_err() {
            tracing::debug!("Dropped a response for a closed connection");
        }
    }

    fn send_defect(&self, defect: Value) {
        self.send(json!({ "_tag": "Defect", "defect": defect }));
    }

    /// One frame: a message or an array of them. Breaks when the connection must close.
    fn receive(self: Arc<Self>, text: &str) -> ControlFlow<Close> {
        let decoded = match serde_json::from_str::<Value>(text) {
            Ok(decoded) => decoded,
            Err(error) => {
                self.send_defect(json!({ "name": "SyntaxError", "message": error.to_string() }));
                return ControlFlow::Continue(());
            }
        };
        let messages = match decoded {
            Value::Array(messages) => messages,
            message => vec![message],
        };
        for message in messages {
            Arc::clone(&self).handle(message)?;
        }
        ControlFlow::Continue(())
    }

    fn handle(self: Arc<Self>, message: Value) -> ControlFlow<Close> {
        // Effect's protocol loop crashes on a `null` message, which closes the socket.
        if message.is_null() {
            return ControlFlow::Break(close_code::ERROR);
        }
        let tag = message.get("_tag");
        let key = message.get("requestId").map(Value::to_string);
        match tag.and_then(Value::as_str) {
            Some("Request") => return self.request(&message),
            Some("Ping") => self.send(json!({ "_tag": "Pong" })),
            Some(tag @ ("Ack" | "Interrupt" | "Eof")) => {
                let mut state = self.state();
                let State { requests, ended } = &mut *state;
                let running_count = requests.len();
                let running = key.and_then(|key| requests.get_mut(&key));
                if *ended && (tag == "Eof" || running.is_none()) {
                    return ControlFlow::Break(close_code::AWAY);
                }
                match (tag, running) {
                    ("Ack", Some(running)) => {
                        running.latch.send_replace(true);
                    }
                    ("Interrupt", Some(running)) => {
                        if let Some(interrupt) = running.interrupt.take()
                            && interrupt.send(()).is_err()
                        {
                            tracing::debug!("The interrupted request had already finished");
                        }
                    }
                    ("Eof", _) => *ended = running_count > 0,
                    _ => {}
                }
            }
            _ => self.send_defect(Value::String(format!(
                "Unknown request tag: {}",
                js_string(tag)
            ))),
        }
        ControlFlow::Continue(())
    }

    fn request(self: Arc<Self>, message: &Value) -> ControlFlow<Close> {
        let id = match message.get("id") {
            Some(id @ (Value::String(_) | Value::Number(_))) => id.clone(),
            other => {
                self.send_defect(Value::String(format!(
                    "Invalid request id: {}",
                    js_string(other)
                )));
                return ControlFlow::Continue(());
            }
        };
        let tag = match message.get("tag") {
            None => String::new(),
            tag => js_string(tag),
        };
        let Some((tag, call)) = self.handlers.call(&tag, message.get("payload").cloned()) else {
            self.send(exit(
                &id,
                die(Value::String(format!("Unknown request tag: {tag}"))),
            ));
            return ControlFlow::Continue(());
        };
        let call = match call {
            Ok(call) => call,
            Err(issue) => {
                self.send(exit(&id, die(Value::String(issue))));
                return ControlFlow::Continue(());
            }
        };
        let key = id.to_string();
        let (interrupt, interrupted) = oneshot::channel();
        let latch = Arc::new(watch::Sender::new(false));
        {
            let mut state = self.state();
            // Effect's server interrupts the socket for a reused id or a request after `Eof`.
            if state.ended || state.requests.contains_key(&key) {
                return ControlFlow::Break(close_code::AWAY);
            }
            state.requests.insert(
                key.clone(),
                Running {
                    interrupt: Some(interrupt),
                    latch: Arc::clone(&latch),
                },
            );
        }
        let span = tracing::debug_span!("RpcServer.request", rpc = tag);
        drop(tokio::spawn(
            self.run(id, key, call, interrupted, latch).instrument(span),
        ));
        ControlFlow::Continue(())
    }

    async fn run(
        self: Arc<Self>,
        id: Value,
        key: RequestKey,
        call: Call,
        mut interrupted: oneshot::Receiver<()>,
        latch: Arc<watch::Sender<bool>>,
    ) {
        let work = async {
            match call {
                Call::Unary(reply) => tokio::select! {
                    biased;
                    _ = &mut interrupted => End::Interrupted,
                    result = reply => match result {
                        Ok(value) => End::Success(value),
                        Err(cause) => End::Failed(cause),
                    },
                },
                Call::Stream(chunks) => self.stream(&id, chunks, &mut interrupted, &latch).await,
            }
        };
        let end = AssertUnwindSafe(work)
            .catch_unwind()
            .await
            .unwrap_or_else(|panic| {
                End::Failed(Cause::Die(Value::String(panic_message(panic.as_ref()))))
            });
        {
            let mut state = self.state();
            state.requests.remove(&key);
            state.ended &= !state.requests.is_empty();
        }
        match end {
            End::Success(value) => {
                self.send(exit(&id, json!({ "_tag": "Success", "value": value })));
            }
            End::Failed(Cause::Fail(error)) => {
                tracing::debug!("The request failed");
                self.send(exit(
                    &id,
                    failure(json!({ "_tag": "Fail", "error": error })),
                ));
            }
            // Effect's server reports a defect to the whole connection, not as the exit.
            End::Failed(Cause::Die(defect)) => {
                tracing::error!("The request died with a defect");
                self.send_defect(defect);
            }
            End::Interrupted => self.send(exit(&id, failure(json!({ "_tag": "Interrupt" })))),
        }
    }

    async fn stream(
        &self,
        id: &Value,
        mut chunks: Chunks,
        interrupted: &mut oneshot::Receiver<()>,
        latch: &watch::Sender<bool>,
    ) -> End {
        loop {
            let values = tokio::select! {
                biased;
                _ = &mut *interrupted => return End::Interrupted,
                next = chunks.next() => match next {
                    Some(values) => values,
                    None => return End::Success(Value::Null),
                },
            };
            if values.is_empty() {
                continue;
            }
            latch.send_replace(false);
            self.send(json!({ "_tag": "Chunk", "requestId": id, "values": values }));
            tokio::select! {
                biased;
                _ = &mut *interrupted => return End::Interrupted,
                () = opened(latch) => {}
            }
        }
    }
}
