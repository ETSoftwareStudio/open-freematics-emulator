//! The RPC layer over a real loopback WebSocket, with a table of test handlers.

use std::future::pending;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::{Cause, Never, RpcError, RpcHandlers, changes};
use crate::http;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Debug, serde::Serialize)]
#[serde(tag = "_tag")]
struct TestError {
    reason: &'static str,
}

impl RpcError for TestError {
    fn into_cause(self) -> Cause {
        super::handlers::fail(&self)
    }
}

struct Broken;

impl RpcError for Broken {
    fn into_cause(self) -> Cause {
        Cause::Die(json!("a broken invariant"))
    }
}

/// Signals when dropped: the request's future was dropped, so its work stopped.
struct DropSignal(Option<oneshot::Sender<()>>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            sender.send(()).ok();
        }
    }
}

#[derive(serde::Deserialize)]
struct Echo {
    text: String,
}

async fn boom() -> Result<(), Never> {
    panic!("boom")
}

struct Fixture {
    url: String,
    values: watch::Sender<u32>,
    stopped: tokio::sync::Mutex<Option<oneshot::Receiver<()>>>,
    polls: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<()>>,
}

async fn fixture() -> Fixture {
    let (values, _) = watch::channel(1_u32);
    let (stopped_tx, stopped) = oneshot::channel();
    let stopped_tx = std::sync::Arc::new(std::sync::Mutex::new(Some(stopped_tx)));
    let (polls_tx, polls) = tokio::sync::mpsc::unbounded_channel();
    let mut handlers = RpcHandlers::new();
    handlers
        .unary("echo", &(), |(), payload: Echo| async move {
            Ok::<_, Never>(json!({ "text": payload.text }))
        })
        .unary("fail", &(), |(), (): ()| async move {
            Err::<(), _>(TestError { reason: "nope" })
        })
        .unary("die", &(), |(), (): ()| async move { Err::<(), _>(Broken) })
        .unary("panic", &(), |(), (): ()| boom())
        .infallible("forever", &stopped_tx, |stopped, (): ()| {
            let guard = DropSignal(stopped.lock().unwrap().take());
            async move {
                let _guard = guard;
                pending::<()>().await;
            }
        })
        .stream("values", &values, move |values, (): ()| {
            let polls = polls_tx.clone();
            changes(values.subscribe()).inspect(move |_| {
                polls.send(()).ok();
            })
        });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let app = http::router(handlers, None, None);
    drop(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap()
    }));
    Fixture {
        url,
        values,
        stopped: tokio::sync::Mutex::new(Some(stopped)),
        polls: tokio::sync::Mutex::new(polls),
    }
}

async fn connect(fixture: &Fixture) -> Socket {
    tokio_tungstenite::connect_async(&fixture.url)
        .await
        .unwrap()
        .0
}

async fn send(socket: &mut Socket, message: Value) {
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .unwrap();
}

async fn request(socket: &mut Socket, id: Value, tag: &str, payload: Value) {
    let message =
        json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] });
    send(socket, message).await;
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Close(frame) => {
                return json!({ "closed": frame.map(|frame| u16::from(frame.code)) });
            }
            _ => {}
        }
    }
}

fn exit(id: Value, exit: Value) -> Value {
    json!({ "_tag": "Exit", "requestId": id, "exit": exit })
}

fn die(defect: &str) -> Value {
    json!({ "_tag": "Failure", "cause": [{ "_tag": "Die", "defect": defect }] })
}

fn interrupted() -> Value {
    json!({ "_tag": "Failure", "cause": [{ "_tag": "Interrupt" }] })
}

fn chunk(id: u32, values: Value) -> Value {
    json!({ "_tag": "Chunk", "requestId": id, "values": values })
}

#[tokio::test]
async fn answers_with_an_exit_per_request() {
    let fixture = fixture().await;
    let mut socket = connect(&fixture).await;

    request(
        &mut socket,
        json!(0),
        "echo",
        json!({ "text": "hi", "extra": 1 }),
    )
    .await;
    assert_eq!(
        next(&mut socket).await,
        exit(
            json!(0),
            json!({ "_tag": "Success", "value": { "text": "hi" } })
        )
    );
    request(&mut socket, json!("s-1"), "fail", Value::Null).await;
    assert_eq!(
        next(&mut socket).await,
        exit(
            json!("s-1"),
            json!({ "_tag": "Failure", "cause": [
                { "_tag": "Fail", "error": { "_tag": "TestError", "reason": "nope" } }
            ] })
        )
    );
}

#[tokio::test]
async fn reports_defects_like_effect() {
    let fixture = fixture().await;
    let mut socket = connect(&fixture).await;

    request(&mut socket, json!(1), "nope", Value::Null).await;
    assert_eq!(
        next(&mut socket).await,
        exit(json!(1), die("Unknown request tag: nope"))
    );
    for (id, payload) in [(2, Some(json!({ "text": 5 }))), (3, None)] {
        let mut message = json!({ "_tag": "Request", "id": id, "tag": "echo", "headers": [] });
        if let Some(payload) = payload {
            message["payload"] = payload;
        }
        send(&mut socket, message).await;
        let response = next(&mut socket).await;
        assert_eq!(response["exit"]["cause"][0]["_tag"], "Die", "{response}");
    }
    request(&mut socket, json!(4), "die", Value::Null).await;
    assert_eq!(
        next(&mut socket).await,
        json!({ "_tag": "Defect", "defect": "a broken invariant" })
    );
    request(&mut socket, json!(5), "panic", Value::Null).await;
    assert_eq!(
        next(&mut socket).await,
        json!({ "_tag": "Defect", "defect": "boom" })
    );
    send(&mut socket, json!({ "_tag": "Bogus" })).await;
    assert_eq!(
        next(&mut socket).await,
        json!({ "_tag": "Defect", "defect": "Unknown request tag: Bogus" })
    );
    send(&mut socket, json!({ "_tag": "Request", "tag": "echo" })).await;
    assert_eq!(
        next(&mut socket).await,
        json!({ "_tag": "Defect", "defect": "Invalid request id: undefined" })
    );
    socket.send(Message::Text("{".into())).await.unwrap();
    let syntax = next(&mut socket).await;
    assert_eq!(syntax["_tag"], "Defect");
    assert_eq!(syntax["defect"]["name"], "SyntaxError");
}

#[tokio::test]
async fn reads_batches_binary_frames_and_pings() {
    let fixture = fixture().await;
    let mut socket = connect(&fixture).await;

    send(
        &mut socket,
        json!([{ "_tag": "Ping" }, 5, { "_tag": "Ping" }]),
    )
    .await;
    assert_eq!(next(&mut socket).await, json!({ "_tag": "Pong" }));
    assert_eq!(
        next(&mut socket).await,
        json!({ "_tag": "Defect", "defect": "Unknown request tag: undefined" })
    );
    assert_eq!(next(&mut socket).await, json!({ "_tag": "Pong" }));
    let ping = json!({ "_tag": "Ping" }).to_string().into_bytes();
    socket.send(Message::Binary(ping.into())).await.unwrap();
    assert_eq!(next(&mut socket).await, json!({ "_tag": "Pong" }));
}

#[tokio::test]
async fn sends_each_chunk_after_the_previous_ack() {
    let fixture = fixture().await;
    let mut socket = connect(&fixture).await;
    let mut polls = fixture.polls.lock().await;

    request(&mut socket, json!(7), "values", Value::Null).await;
    assert_eq!(next(&mut socket).await, chunk(7, json!([1])));
    fixture.values.send_replace(2);
    fixture.values.send_replace(3);
    send(&mut socket, json!({ "_tag": "Ping" })).await;
    assert_eq!(next(&mut socket).await, json!({ "_tag": "Pong" }));
    polls.recv().await.unwrap();
    assert!(
        polls.try_recv().is_err(),
        "polled the stream before the ack"
    );

    send(&mut socket, json!({ "_tag": "Ack", "requestId": 7 })).await;
    assert_eq!(next(&mut socket).await, chunk(7, json!([3])));
    send(&mut socket, json!({ "_tag": "Ack", "requestId": 7 })).await;
    fixture.values.send_replace(4);
    assert_eq!(next(&mut socket).await, chunk(7, json!([4])));

    send(&mut socket, json!({ "_tag": "Interrupt", "requestId": 7 })).await;
    assert_eq!(next(&mut socket).await, exit(json!(7), interrupted()));
}

#[tokio::test]
async fn an_interrupt_drops_the_running_handler() {
    let fixture = fixture().await;
    let mut socket = connect(&fixture).await;
    let stopped = fixture.stopped.lock().await.take().unwrap();

    request(&mut socket, json!(8), "forever", Value::Null).await;
    send(&mut socket, json!({ "_tag": "Interrupt", "requestId": 8 })).await;
    assert_eq!(next(&mut socket).await, exit(json!(8), interrupted()));
    stopped.await.unwrap();

    send(&mut socket, json!({ "_tag": "Interrupt", "requestId": 8 })).await;
    send(&mut socket, json!({ "_tag": "Ping" })).await;
    assert_eq!(next(&mut socket).await, json!({ "_tag": "Pong" }));
}

#[tokio::test]
async fn a_disconnect_drops_every_running_handler() {
    let fixture = fixture().await;
    let mut socket = connect(&fixture).await;
    let stopped = fixture.stopped.lock().await.take().unwrap();

    request(&mut socket, json!(9), "forever", Value::Null).await;
    send(&mut socket, json!({ "_tag": "Ping" })).await;
    assert_eq!(next(&mut socket).await, json!({ "_tag": "Pong" }));
    socket.close(None).await.unwrap();
    stopped.await.unwrap();
}

#[tokio::test]
async fn closes_the_socket_where_effect_interrupts_it() {
    let fixture = fixture().await;
    let away = json!({ "closed": u16::from(CloseCode::Away) });

    let mut reused = connect(&fixture).await;
    request(&mut reused, json!(1), "values", Value::Null).await;
    assert_eq!(next(&mut reused).await, chunk(1, json!([1])));
    request(&mut reused, json!(1), "values", Value::Null).await;
    assert_eq!(next(&mut reused).await, away);

    let mut ended = connect(&fixture).await;
    send(&mut ended, json!({ "_tag": "Eof" })).await;
    request(
        &mut ended,
        json!(1),
        "echo",
        json!({ "text": "still open" }),
    )
    .await;
    assert_eq!(next(&mut ended).await["exit"]["_tag"], "Success");
    request(&mut ended, json!(2), "values", Value::Null).await;
    assert_eq!(next(&mut ended).await, chunk(2, json!([1])));
    send(&mut ended, json!({ "_tag": "Eof" })).await;
    request(&mut ended, json!(3), "echo", json!({ "text": "too late" })).await;
    assert_eq!(next(&mut ended).await, away);

    let mut crashed = connect(&fixture).await;
    send(&mut crashed, Value::Null).await;
    assert_eq!(
        next(&mut crashed).await,
        json!({ "closed": u16::from(CloseCode::Error) })
    );
}
