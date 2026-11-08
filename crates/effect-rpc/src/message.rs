//! The messages of Effect RPC's socket protocol, as `RpcSerialization.json` puts them on the wire.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A request id as the client sent it. Effect's client sends numbers, but any JSON string or
/// number is accepted, and `1` and `"1"` are different ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RequestId(Value);

impl RequestId {
    /// The id as JSON.
    pub fn as_value(&self) -> &Value {
        &self.0
    }

    /// A key that tells ids apart by their JSON form.
    #[cfg(feature = "server")]
    pub(crate) fn key(&self) -> String {
        self.0.to_string()
    }
}

impl From<Value> for RequestId {
    fn from(value: Value) -> Self {
        Self(value)
    }
}

/// A call from the client.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: RequestId,
    /// The rpc's tag, as the client's `Rpc.make(tag)` names it.
    pub tag: String,
    /// `None` when the client sent no `payload` key, which no payload schema accepts.
    pub payload: Option<Value>,
}

/// A message from the client. Request `headers`, tracing fields and `interruptors` are accepted
/// and ignored.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMessage {
    Request(Request),
    /// The client queued the last `Chunk` of a stream and wants the next one.
    Ack {
        request_id: RequestId,
    },
    Interrupt {
        request_id: RequestId,
    },
    Ping,
    /// The client sends no more requests.
    Eof,
}

/// Why a message from the client was rejected, with the reaction Effect's server has to it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    /// A `null` message, which crashes Effect's protocol loop and closes the socket.
    #[error("The message is null.")]
    Null,
    /// Answered with a `Defect` to the whole connection.
    #[error("Unknown request tag: {0}")]
    UnknownTag(String),
    /// Answered with a `Defect` to the whole connection.
    #[error("Invalid request id: {0}")]
    InvalidRequestId(String),
}

impl ClientMessage {
    /// Decodes one message of a frame. Ids and tags are not checked against any handler here.
    pub fn from_value(message: &Value) -> Result<Self, ProtocolError> {
        if message.is_null() {
            return Err(ProtocolError::Null);
        }
        let request_id = || RequestId(message.get("requestId").cloned().unwrap_or(Value::Null));
        let tag = message.get("_tag");
        Ok(match tag.and_then(Value::as_str) {
            Some("Request") => {
                let id = match message.get("id") {
                    Some(id @ (Value::String(_) | Value::Number(_))) => RequestId(id.clone()),
                    other => return Err(ProtocolError::InvalidRequestId(js_string(other))),
                };
                let tag = match message.get("tag") {
                    None => String::new(),
                    tag => js_string(tag),
                };
                Self::Request(Request {
                    id,
                    tag,
                    payload: message.get("payload").cloned(),
                })
            }
            Some("Ack") => Self::Ack {
                request_id: request_id(),
            },
            Some("Interrupt") => Self::Interrupt {
                request_id: request_id(),
            },
            Some("Ping") => Self::Ping,
            Some("Eof") => Self::Eof,
            _ => return Err(ProtocolError::UnknownTag(js_string(tag))),
        })
    }
}

/// How JavaScript prints a value in a template string, which Effect uses for its messages.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.as_f64().map_or_else(
            || number.to_string(),
            |number| ryu_js::Buffer::new().format(number).to_owned(),
        ),
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

/// A message from the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ServerMessage {
    /// Values of a stream; the next `Chunk` waits for the client's `Ack`.
    Chunk {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        values: Vec<Value>,
    },
    /// How a request ended.
    Exit {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        exit: Exit,
    },
    /// A defect for the whole connection: the client fails every request in flight.
    Defect {
        defect: Value,
    },
    Pong,
}

/// An encoded `Exit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Exit {
    /// The encoded success value; `null` for `Schema.Void` and for a finished stream.
    Success {
        value: Value,
    },
    Failure {
        cause: Vec<Reason>,
    },
}

/// One reason of an encoded `Cause`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Reason {
    /// A typed error, encoded with the rpc's error schema.
    Fail {
        error: Value,
    },
    Die {
        defect: Value,
    },
    Interrupt,
}

impl Exit {
    pub fn success(value: Value) -> Self {
        Self::Success { value }
    }

    pub fn fail(error: Value) -> Self {
        Self::Failure {
            cause: vec![Reason::Fail { error }],
        }
    }

    pub fn die(defect: Value) -> Self {
        Self::Failure {
            cause: vec![Reason::Die { defect }],
        }
    }

    pub fn interrupt() -> Self {
        Self::Failure {
            cause: vec![Reason::Interrupt],
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_client_messages() {
        let request = json!({ "_tag": "Request", "id": 3, "tag": "Echo", "payload": { "a": 1 }, "headers": [] });
        assert_eq!(
            ClientMessage::from_value(&request),
            Ok(ClientMessage::Request(Request {
                id: RequestId(json!(3)),
                tag: "Echo".to_owned(),
                payload: Some(json!({ "a": 1 })),
            }))
        );
        assert_eq!(
            ClientMessage::from_value(&json!({ "_tag": "Ack", "requestId": "3" })),
            Ok(ClientMessage::Ack {
                request_id: RequestId(json!("3"))
            })
        );
        assert_ne!(RequestId(json!(3)), RequestId(json!("3")));
        assert_eq!(
            ClientMessage::from_value(&Value::Null),
            Err(ProtocolError::Null)
        );
    }

    #[test]
    fn prints_bad_values_like_a_template_string() {
        for (tag, printed) in [
            (json!(1e21), "1e+21"),
            (json!(2.0), "2"),
            (json!([1, null, "a", [true]]), "1,,a,true"),
            (json!({}), "[object Object]"),
            (Value::Null, "null"),
        ] {
            assert_eq!(
                ClientMessage::from_value(&json!({ "_tag": tag })),
                Err(ProtocolError::UnknownTag(printed.to_owned()))
            );
        }
        assert_eq!(
            ClientMessage::from_value(&json!({ "_tag": "Request", "id": [], "tag": "Echo" })),
            Err(ProtocolError::InvalidRequestId(String::new()))
        );
    }

    #[test]
    fn encodes_server_messages() {
        let exit = ServerMessage::Exit {
            request_id: RequestId(json!(1)),
            exit: Exit::fail(json!({ "_tag": "Oops" })),
        };
        assert_eq!(
            serde_json::to_string(&exit).ok().as_deref(),
            Some(
                r#"{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"Oops"}}]}}"#
            )
        );
        assert_eq!(
            serde_json::to_value(ServerMessage::Pong).ok(),
            Some(json!({ "_tag": "Pong" }))
        );
        assert_eq!(
            serde_json::to_value(Exit::interrupt()).ok(),
            Some(json!({ "_tag": "Failure", "cause": [{ "_tag": "Interrupt" }] }))
        );
    }
}
