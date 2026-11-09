//! One client's protocol state, independent of the transport: decodes its frames, runs each
//! request as its own task, and hands the responses to the transport in the order they are
//! produced.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_util::{FutureExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};
use tracing::Instrument;

use crate::cause::Cause;
use crate::handlers::{Call, Chunks, Handlers};
use crate::message::{ClientMessage, Exit, ProtocolError, Request, RequestId, ServerMessage};

/// Why the transport must close the connection, as the WebSocket close code Effect's server
/// sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Close {
    /// 1001: a request reused a running id, or came after `Eof` while others still ran.
    GoingAway,
    /// 1011: a `null` message, which crashes Effect's protocol loop.
    InternalError,
}

impl Close {
    pub fn code(self) -> u16 {
        match self {
            Self::GoingAway => 1001,
            Self::InternalError => 1011,
        }
    }
}

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

#[derive(Default)]
struct State {
    requests: HashMap<String, Running>,
    /// Set by `Eof` while requests run; cleared once they all finish, as Effect forgets the client.
    ended: bool,
}

type Respond = Box<dyn Fn(ServerMessage) + Send + Sync>;

struct Inner {
    handlers: Arc<Handlers>,
    send: Respond,
    state: Mutex<State>,
}

/// One client of the server. Feed it the client's frames with [`receive`](Self::receive); it
/// passes every response to the `send` callback given to [`new`](Self::new), from any task.
///
/// Dropping it interrupts every request still running. Requests run as tokio tasks, so it must
/// be used inside a tokio runtime.
pub struct Connection {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("running", &self.inner.state().requests.len())
            .finish()
    }
}

impl Connection {
    /// A connection whose responses go to `send`, which should queue them for the transport
    /// without blocking.
    pub fn new(
        handlers: Arc<Handlers>,
        send: impl Fn(ServerMessage) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                handlers,
                send: Box::new(send),
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Handles one frame: a JSON message or an array of them. Breaks when the transport must
    /// close the connection; the messages after that one are not read.
    pub fn receive(&self, frame: &str) -> ControlFlow<Close> {
        let decoded = match serde_json::from_str::<Value>(frame) {
            Ok(decoded) => decoded,
            Err(error) => {
                self.inner
                    .send_defect(json!({ "name": "SyntaxError", "message": error.to_string() }));
                return ControlFlow::Continue(());
            }
        };
        let messages = match decoded {
            Value::Array(messages) => messages,
            message => vec![message],
        };
        for message in &messages {
            match ClientMessage::from_value(message) {
                Ok(message) => Arc::clone(&self.inner).handle(message)?,
                Err(ProtocolError::Null) => return ControlFlow::Break(Close::InternalError),
                Err(error) => self.inner.send_defect(Value::String(error.to_string())),
            }
        }
        ControlFlow::Continue(())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.inner.state().requests.clear();
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

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn send_defect(&self, defect: Value) {
        (self.send)(ServerMessage::Defect { defect });
    }

    fn send_exit(&self, request_id: RequestId, exit: Exit) {
        (self.send)(ServerMessage::Exit { request_id, exit });
    }

    fn handle(self: Arc<Self>, message: ClientMessage) -> ControlFlow<Close> {
        let request_id = match message {
            ClientMessage::Request(request) => return self.request(request),
            ClientMessage::Ping => {
                (self.send)(ServerMessage::Pong);
                return ControlFlow::Continue(());
            }
            ClientMessage::Ack { ref request_id } | ClientMessage::Interrupt { ref request_id } => {
                Some(request_id.key())
            }
            ClientMessage::Eof => None,
        };
        let mut state = self.state();
        let State { requests, ended } = &mut *state;
        let running_count = requests.len();
        let running = request_id.and_then(|key| requests.get_mut(&key));
        let eof = matches!(message, ClientMessage::Eof);
        if *ended && (eof || running.is_none()) {
            return ControlFlow::Break(Close::GoingAway);
        }
        match (message, running) {
            (ClientMessage::Ack { .. }, Some(running)) => {
                running.latch.send_replace(true);
            }
            (ClientMessage::Interrupt { .. }, Some(running)) => {
                if let Some(interrupt) = running.interrupt.take()
                    && interrupt.send(()).is_err()
                {
                    tracing::debug!("The interrupted request had already finished");
                }
            }
            (ClientMessage::Eof, _) => *ended = running_count > 0,
            _ => {}
        }
        ControlFlow::Continue(())
    }

    fn request(self: Arc<Self>, request: Request) -> ControlFlow<Close> {
        let Request { id, tag, payload } = request;
        let Some((tag, call)) = self.handlers.call(&tag, payload) else {
            self.send_exit(
                id,
                Exit::die(Value::String(format!("Unknown request tag: {tag}"))),
            );
            return ControlFlow::Continue(());
        };
        let call = match call {
            Ok(call) => call,
            Err(issue) => {
                self.send_exit(id, Exit::die(Value::String(issue)));
                return ControlFlow::Continue(());
            }
        };
        let key = id.key();
        let (interrupt, interrupted) = oneshot::channel();
        let latch = Arc::new(watch::Sender::new(false));
        {
            let mut state = self.state();
            // Effect's server interrupts the socket for a reused id or a request after `Eof`.
            if state.ended || state.requests.contains_key(&key) {
                return ControlFlow::Break(Close::GoingAway);
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
        id: RequestId,
        key: String,
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
            End::Success(value) => self.send_exit(id, Exit::success(value)),
            End::Failed(Cause::Fail(error)) => {
                tracing::debug!("The request failed");
                self.send_exit(id, Exit::fail(error));
            }
            // Effect's server reports a defect to the whole connection, not as the exit.
            End::Failed(Cause::Die(defect)) => {
                tracing::error!("The request died with a defect");
                self.send_defect(defect);
            }
            End::Interrupted => self.send_exit(id, Exit::interrupt()),
        }
    }

    async fn stream(
        &self,
        id: &RequestId,
        mut chunks: Chunks,
        interrupted: &mut oneshot::Receiver<()>,
        latch: &watch::Sender<bool>,
    ) -> End {
        loop {
            let values = tokio::select! {
                biased;
                _ = &mut *interrupted => return End::Interrupted,
                next = chunks.next() => match next {
                    Some(Ok(values)) => values,
                    Some(Err(cause)) => return End::Failed(cause),
                    None => return End::Success(Value::Null),
                },
            };
            if values.is_empty() {
                continue;
            }
            latch.send_replace(false);
            (self.send)(ServerMessage::Chunk {
                request_id: id.clone(),
                values,
            });
            tokio::select! {
                biased;
                _ = &mut *interrupted => return End::Interrupted,
                () = opened(latch) => {}
            }
        }
    }
}
