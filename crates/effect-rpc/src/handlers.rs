//! The registry of handlers by rpc tag, and the adapters that decode a payload, run the handler
//! and encode its result.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use futures_util::FutureExt;
use futures_util::stream::{self, BoxStream, Stream, StreamExt};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;

use crate::cause::{Cause, Never, RpcError};

pub(crate) type Reply = Pin<Box<dyn Future<Output = Result<Value, Cause>> + Send>>;
pub(crate) type Chunks = BoxStream<'static, Result<Vec<Value>, Cause>>;

/// A decoded request, ready to run.
pub(crate) enum Call {
    Unary(Reply),
    Stream(Chunks),
}

type Handler = Box<dyn Fn(Option<Value>) -> Result<Call, String> + Send + Sync>;

/// The handlers of an `RpcGroup`, by tag.
///
/// Each handler takes a context, cloned into every call (a service handle, an `Arc`, or `()`),
/// and the decoded payload. Payloads decode with `serde`; one that doesn't decode answers the
/// request with a `Die`, as Effect does. Successes and stream values encode with `serde`.
///
/// ```
/// use effect_rpc::{Handlers, Never};
///
/// #[derive(serde::Deserialize)]
/// struct Greet {
///     name: String,
/// }
///
/// let mut handlers = Handlers::new();
/// handlers.unary("Greet", &(), |(), payload: Greet| async move {
///     Ok::<_, Never>(format!("Hello, {}!", payload.name))
/// });
/// assert!(handlers.contains("Greet"));
/// ```
#[derive(Default)]
pub struct Handlers {
    handlers: HashMap<&'static str, Handler>,
}

impl fmt::Debug for Handlers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Handlers")
            .field("tags", &self.handlers.keys())
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

fn encode_values<T: Serialize>(tag: &'static str, values: &[T]) -> Vec<Value> {
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
}

impl Handlers {
    pub fn new() -> Self {
        Self::default()
    }

    /// An rpc answered by one value or one error: `Rpc.make(tag, { payload, success, error })`.
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

    /// An rpc that always succeeds.
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

    /// A streaming rpc (`Rpc.make(tag, { stream: true })`) that cannot fail. Each item of the
    /// stream is sent as one `Chunk`, after the client acknowledged the previous one; empty
    /// items are skipped. The request succeeds when the stream ends.
    pub fn stream<C, P, T, F, St>(
        &mut self,
        tag: &'static str,
        context: &C,
        handler: F,
    ) -> &mut Self
    where
        C: Clone + Send + Sync + 'static,
        P: DeserializeOwned,
        T: Serialize + 'static,
        F: Fn(C, P) -> St + Send + Sync + 'static,
        St: Stream<Item = Vec<T>> + Send + 'static,
    {
        self.try_stream(tag, context, move |context, payload| {
            handler(context, payload).map(Ok::<_, Never>)
        })
    }

    /// A streaming rpc that can fail: the first error ends the request with it.
    pub fn try_stream<C, P, T, E, F, St>(
        &mut self,
        tag: &'static str,
        context: &C,
        handler: F,
    ) -> &mut Self
    where
        C: Clone + Send + Sync + 'static,
        P: DeserializeOwned,
        T: Serialize + 'static,
        E: RpcError + 'static,
        F: Fn(C, P) -> St + Send + Sync + 'static,
        St: Stream<Item = Result<Vec<T>, E>> + Send + 'static,
    {
        let context = context.clone();
        let handler = move |payload: Option<Value>| {
            let chunks = handler(context.clone(), decode(payload)?).map(move |values| {
                values
                    .map(|values| encode_values(tag, &values))
                    .map_err(RpcError::into_cause)
            });
            Ok(Call::Stream(chunks.boxed()))
        };
        self.handlers.insert(tag, Box::new(handler));
        self
    }

    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    pub fn contains(&self, tag: &str) -> bool {
        self.handlers.contains_key(tag)
    }

    /// The registered tags, in no particular order.
    pub fn tags(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.handlers.keys().copied()
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

/// A `SubscriptionRef.changes`-style stream over a `watch` channel: the current value, then the
/// latest value after each change. Changes made while the client hasn't acknowledged the previous
/// chunk coalesce into one.
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
