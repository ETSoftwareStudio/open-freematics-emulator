//! The table of RPC handlers by tag, and the adapters that decode a payload, run a service
//! method and encode its result for the wire.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use futures_util::FutureExt;
use futures_util::stream::{self, BoxStream, Stream, StreamExt};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

/// How a request failed: a typed error the client decodes with the RPC's error schema, or a
/// defect, which Effect's server reports to the whole connection.
#[derive(Debug, Clone, PartialEq)]
pub enum Cause {
    Fail(Value),
    Die(Value),
}

/// A handler error. Contract errors encode as `Fail`; a broken invariant is a `Die`.
pub trait RpcError {
    fn into_cause(self) -> Cause;
}

/// The error of a handler that cannot fail.
#[derive(Debug, Clone, Copy)]
pub enum Never {}

impl RpcError for Never {
    fn into_cause(self) -> Cause {
        match self {}
    }
}

/// Implements [`RpcError`] for contract errors, which all encode as typed failures.
#[macro_export]
macro_rules! typed_rpc_errors {
    ($($error:ty),+ $(,)?) => {
        $(impl $crate::rpc::RpcError for $error {
            fn into_cause(self) -> $crate::rpc::Cause {
                $crate::rpc::handlers::fail(&self)
            }
        })+
    };
}

#[doc(hidden)]
pub fn fail(error: &impl Serialize) -> Cause {
    match serde_json::to_value(error) {
        Ok(value) => Cause::Fail(value),
        Err(error) => Cause::Die(Value::String(format!("Failed to encode an error: {error}"))),
    }
}

pub type Reply = Pin<Box<dyn Future<Output = Result<Value, Cause>> + Send>>;
/// Batches of encoded stream values; each batch goes out as one `Chunk`.
pub type Chunks = BoxStream<'static, Vec<Value>>;

/// A decoded request, ready to run.
pub enum Call {
    Unary(Reply),
    Stream(Chunks),
}

type Handler = Box<dyn Fn(Option<Value>) -> Result<Call, String> + Send + Sync>;

#[derive(Default)]
pub struct RpcHandlers {
    handlers: HashMap<&'static str, Handler>,
}

impl std::fmt::Debug for RpcHandlers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RpcHandlers")
            .field("tags", &self.handlers.len())
            .finish()
    }
}

/// A missing payload never decodes: Effect decodes `undefined`, which no payload schema accepts.
fn decode<P: DeserializeOwned>(payload: Option<Value>) -> Result<P, String> {
    let payload = payload.ok_or_else(|| "The request has no payload.".to_owned())?;
    serde_json::from_value(payload).map_err(|error| error.to_string())
}

fn encode(value: &impl Serialize) -> Result<Value, Cause> {
    serde_json::to_value(value).map_err(|error| {
        Cause::Die(Value::String(format!(
            "Failed to encode a response: {error}"
        )))
    })
}

impl RpcHandlers {
    pub fn new() -> Self {
        Self::default()
    }

    /// A request answered by one value or one error. `context` (a service) is cloned into each
    /// call.
    pub fn unary<C, P, S, E, F, Fut>(
        &mut self,
        tag: &'static str,
        context: &C,
        handler: F,
    ) -> &mut Self
    where
        C: Clone + Send + Sync + 'static,
        P: DeserializeOwned,
        S: Serialize,
        E: RpcError,
        F: Fn(C, P) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<S, E>> + Send + 'static,
    {
        let context = context.clone();
        let handler = move |payload: Option<Value>| {
            let reply = handler(context.clone(), decode(payload)?);
            Ok(Call::Unary(Box::pin(async move {
                match reply.await {
                    Ok(value) => encode(&value),
                    Err(error) => Err(error.into_cause()),
                }
            })))
        };
        self.handlers.insert(tag, Box::new(handler));
        self
    }

    /// A request that always succeeds.
    pub fn infallible<C, P, S, F, Fut>(
        &mut self,
        tag: &'static str,
        context: &C,
        handler: F,
    ) -> &mut Self
    where
        C: Clone + Send + Sync + 'static,
        P: DeserializeOwned,
        S: Serialize + 'static,
        F: Fn(C, P) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = S> + Send + 'static,
    {
        self.unary(tag, context, move |context, payload| {
            handler(context, payload).map(Ok::<S, Never>)
        })
    }

    /// A request answered by a stream of values, sent in acknowledged chunks.
    pub fn stream<C, P, T, F, St>(
        &mut self,
        tag: &'static str,
        context: &C,
        handler: F,
    ) -> &mut Self
    where
        C: Clone + Send + Sync + 'static,
        P: DeserializeOwned,
        T: Serialize,
        F: Fn(C, P) -> St + Send + Sync + 'static,
        St: Stream<Item = Vec<T>> + Send + 'static,
    {
        let context = context.clone();
        let handler = move |payload: Option<Value>| {
            let chunks = handler(context.clone(), decode(payload)?).map(move |values| {
                values
                    .iter()
                    .filter_map(|value| match serde_json::to_value(value) {
                        Ok(value) => Some(value),
                        Err(error) => {
                            tracing::warn!(rpc = tag, %error, "Dropped a stream value that didn't encode");
                            None
                        }
                    })
                    .collect()
            });
            Ok(Call::Stream(chunks.boxed()))
        };
        self.handlers.insert(tag, Box::new(handler));
        self
    }

    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    pub fn contains(&self, tag: &str) -> bool {
        self.handlers.contains_key(tag)
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    /// The handler's own tag, which outlives the request, and the decoded call. `None` for an
    /// unknown tag; `Some(Err)` for a payload that doesn't decode.
    pub(crate) fn call(
        &self,
        tag: &str,
        payload: Option<Value>,
    ) -> Option<(&'static str, Result<Call, String>)> {
        let (tag, handler) = self.handlers.get_key_value(tag)?;
        Some((*tag, handler(payload)))
    }
}

/// A `SubscriptionRef`-style stream: the current value, then the latest value after each change.
/// Changes made while the client hasn't acknowledged the previous chunk coalesce into one.
pub fn changes<T>(receiver: watch::Receiver<T>) -> impl Stream<Item = Vec<T>> + Send + 'static
where
    T: Clone + Send + Sync + 'static,
{
    stream::unfold((receiver, true), |(mut receiver, first)| async move {
        if !first && receiver.changed().await.is_err() {
            return None;
        }
        let value = receiver.borrow_and_update().clone();
        Some((vec![value], (receiver, false)))
    })
}
