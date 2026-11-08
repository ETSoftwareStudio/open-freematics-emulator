//! How a handler fails: typed errors and defects.

use serde::Serialize;
use serde_json::Value;

/// How a request failed.
#[derive(Debug, Clone, PartialEq)]
pub enum Cause {
    /// A typed error, encoded as the rpc's error schema expects. The client fails the request
    /// with it.
    Fail(Value),
    /// A defect. Like Effect's server, this is reported to the whole connection as a `Defect`
    /// message, which fails every request the client has in flight.
    Die(Value),
}

impl Cause {
    /// A typed error. An error that doesn't encode becomes a defect.
    pub fn fail(error: &impl Serialize) -> Self {
        match serde_json::to_value(error) {
            Ok(value) => Self::Fail(value),
            Err(error) => Self::Die(Value::String(format!("Failed to encode an error: {error}"))),
        }
    }

    /// A defect, such as a message or `{ "name": ..., "message": ... }` for an `Error`.
    pub fn die(defect: impl Into<Value>) -> Self {
        Self::Die(defect.into())
    }
}

/// The error type of a handler. Implement it with [`typed_errors!`](crate::typed_errors) for
/// errors that all encode as typed failures, or by hand to send some variants as defects.
pub trait RpcError {
    fn into_cause(self) -> Cause;
}

impl RpcError for Cause {
    fn into_cause(self) -> Cause {
        self
    }
}

/// The error of a handler that cannot fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Never {}

impl RpcError for Never {
    fn into_cause(self) -> Cause {
        match self {}
    }
}

/// Implements [`RpcError`] for error types that encode, with `serde`, as the rpc's error schema.
///
/// ```
/// #[derive(serde::Serialize)]
/// #[serde(tag = "_tag")]
/// struct NotFound {
///     id: String,
/// }
///
/// effect_rpc::typed_errors!(NotFound);
/// ```
#[macro_export]
macro_rules! typed_errors {
    ($($error:ty),+ $(,)?) => {
        $(impl $crate::RpcError for $error {
            fn into_cause(self) -> $crate::Cause {
                $crate::Cause::fail(&self)
            }
        })+
    };
}
