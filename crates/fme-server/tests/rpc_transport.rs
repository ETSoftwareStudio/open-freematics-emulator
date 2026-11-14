//! The server over a real loopback socket: raw protocol frames the Effect client never sends,
//! stream acks and interrupts, close codes, and the HTTP routes behind the same-origin guard.
#![cfg(test)]

use std::net::SocketAddr;

use fme_server::server::{Server, ServerOptions};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

struct Running {
    address: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    _dirs: [tempfile::TempDir; 2],
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop.send(()).ok();
        }
    }
}

/// The server on a free loopback port, serving a two-file web app.
async fn start() -> Running {
    let web = tempfile::tempdir().unwrap();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(
        web.path().join("index.html"),
        "<!doctype html><title>fme</title>\n",
    )
    .unwrap();
    std::fs::write(web.path().join("assets/app.js"), "export {};\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let server = Server::bind(ServerOptions {
        host: "127.0.0.1".to_owned(),
        port: 0,
        web_root: Some(web.path().to_path_buf()),
        data_dir: data.path().to_path_buf(),
        app_origin: None,
    })
    .await
    .unwrap();
    let address = server.local_addr();
    let (stop, stopped) = oneshot::channel::<()>();
    tokio::spawn(server.serve(async {
        stopped.await.ok();
    }));
    Running {
        address,
        stop: Some(stop),
        _dirs: [web, data],
    }
}

struct Socket(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
);

impl Socket {
    async fn open(address: SocketAddr) -> Self {
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        Self(socket)
    }

    async fn send(&mut self, message: Value) {
        self.send_text(&message.to_string()).await;
    }

    async fn send_text(&mut self, text: &str) {
        self.0.send(Message::text(text)).await.unwrap();
    }

    async fn request(&mut self, id: Value, tag: &str, payload: Value) {
        self.send(
            json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] }),
        )
        .await;
    }

    /// The next message, or `{ "closed": code }` once the server closes the socket.
    async fn next(&mut self) -> Value {
        loop {
            match self.0.next().await {
                Some(Ok(Message::Text(text))) => return serde_json::from_str(&text).unwrap(),
                Some(Ok(Message::Close(frame))) => {
                    return json!({ "closed": frame.map(|frame| u16::from(frame.code)) });
                }
                Some(Ok(_)) => {}
                other => panic!("the socket ended without a close frame: {other:?}"),
            }
        }
    }

    /// Every message before the `Pong` that answers a fresh `Ping`, which the server sends last.
    async fn drain(&mut self) -> Vec<Value> {
        self.send(json!({ "_tag": "Ping" })).await;
        let mut messages = Vec::new();
        loop {
            let message = self.next().await;
            if message["_tag"] == "Pong" {
                return messages;
            }
            assert!(message.get("closed").is_none(), "{message}");
            messages.push(message);
        }
    }

    /// The close code once the server drops the connection, or `None` if it stays open.
    async fn closed(&mut self) -> Option<Value> {
        // The server may close before this arrives.
        self.0.send(Message::text(r#"{"_tag":"Ping"}"#)).await.ok();
        loop {
            let message = self.next().await;
            if message["_tag"] == "Pong" {
                return None;
            }
            if let Some(code) = message.get("closed") {
                return Some(code.clone());
            }
        }
    }
}

fn exit(id: Value, exit: Value) -> Value {
    json!({ "_tag": "Exit", "requestId": id, "exit": exit })
}

fn success_null(id: Value) -> Value {
    exit(id, json!({ "_tag": "Success", "value": null }))
}

fn die(id: Value, defect: &str) -> Value {
    exit(
        id,
        json!({ "_tag": "Failure", "cause": [{ "_tag": "Die", "defect": defect }] }),
    )
}

/// A `Die` exit whose defect is the decoder's message, whatever its wording.
fn assert_died(message: &Value, id: Value) {
    let defect = &message["exit"]["cause"][0]["defect"];
    assert!(defect.is_string(), "{message}");
    assert_eq!(*message, die(id, defect.as_str().unwrap()));
}

/// A chunk of `emulator.subscribeState` by its one value's ignition.
fn assert_state_chunk(message: &Value, id: u64, ignition: bool) {
    assert_eq!(message["_tag"], "Chunk", "{message}");
    assert_eq!(message["requestId"], id, "{message}");
    assert_eq!(
        message["values"].as_array().map(Vec::len),
        Some(1),
        "{message}"
    );
    assert_eq!(message["values"][0]["ignition"], ignition, "{message}");
}

#[tokio::test]
async fn answers_raw_frames_as_effect_rpc_does() {
    let server = start().await;
    let mut socket = Socket::open(server.address).await;
    let pong = json!({ "_tag": "Pong" });

    socket.send(json!({ "_tag": "Ping" })).await;
    assert_eq!(socket.next().await, pong);
    socket
        .send(json!([{ "_tag": "Ping" }, 5, { "_tag": "Ping" }]))
        .await;
    assert_eq!(
        [
            socket.next().await,
            socket.next().await,
            socket.next().await
        ],
        [
            pong.clone(),
            json!({ "_tag": "Defect", "defect": "Unknown request tag: undefined" }),
            pong.clone()
        ]
    );
    socket
        .0
        .send(Message::binary(br#"{"_tag":"Ping"}"#.to_vec()))
        .await
        .unwrap();
    assert_eq!(socket.next().await, pong);

    socket.request(json!(1), "emulator.nope", Value::Null).await;
    assert_eq!(
        socket.next().await,
        die(json!(1), "Unknown request tag: emulator.nope")
    );
    socket
        .request(json!("s-2"), "emulator.setIgnition", json!({ "on": "yes" }))
        .await;
    assert_died(&socket.next().await, json!("s-2"));
    socket
        .send(json!({ "_tag": "Request", "id": 3, "tag": "emulator.listPorts", "headers": [] }))
        .await;
    assert_died(&socket.next().await, json!(3));
    socket
        .request(json!(3.5), "emulator.disconnect", json!({}))
        .await;
    assert_died(&socket.next().await, json!(3.5));

    for (message, defect) in [
        (json!({ "_tag": "Bogus" }), "Unknown request tag: Bogus"),
        (
            json!({ "_tag": "Request", "tag": "emulator.listPorts", "payload": null, "headers": [] }),
            "Invalid request id: undefined",
        ),
        (
            json!({ "_tag": "Request", "id": {}, "tag": "emulator.listPorts", "payload": null, "headers": [] }),
            "Invalid request id: [object Object]",
        ),
    ] {
        socket.send(message).await;
        assert_eq!(
            socket.next().await,
            json!({ "_tag": "Defect", "defect": defect })
        );
    }
    socket.send_text("{").await;
    let syntax = socket.next().await;
    assert_eq!(syntax["_tag"], "Defect", "{syntax}");
    assert_eq!(syntax["defect"]["name"], "SyntaxError", "{syntax}");
    assert!(syntax["defect"]["message"].is_string(), "{syntax}");

    for message in [
        json!({ "_tag": "Interrupt", "requestId": 404 }),
        json!({ "_tag": "Ack", "requestId": 404 }),
        json!({ "_tag": "Eof" }),
    ] {
        socket.send(message.clone()).await;
        assert_eq!(socket.drain().await, Vec::<Value>::new(), "{message}");
    }

    socket
        .request(json!(4), "presets.apply", json!({ "id": "user:missing" }))
        .await;
    assert_eq!(
        socket.next().await,
        exit(
            json!(4),
            json!({
                "_tag": "Failure",
                "cause": [{
                    "_tag": "Fail",
                    "error": { "_tag": "PresetNotFoundError", "id": "user:missing" }
                }]
            })
        )
    );
    socket
        .request(
            json!(5),
            "reader.setPolling",
            json!({ "paused": true, "interval": 1000, "extra": 1 }),
        )
        .await;
    assert_eq!(socket.next().await, success_null(json!(5)));
}

#[tokio::test]
async fn holds_each_chunk_until_acked_and_stops_on_interrupt() {
    let server = start().await;
    let mut socket = Socket::open(server.address).await;

    socket
        .request(json!(6), "emulator.subscribeState", Value::Null)
        .await;
    assert_state_chunk(&socket.next().await, 6, true);
    socket
        .request(json!(7), "emulator.setIgnition", json!({ "on": false }))
        .await;
    assert_eq!(socket.next().await, success_null(json!(7)));
    assert_eq!(socket.drain().await, Vec::<Value>::new());
    socket.send(json!({ "_tag": "Ack", "requestId": 6 })).await;
    assert_state_chunk(&socket.next().await, 6, false);

    socket.send(json!({ "_tag": "Ack", "requestId": 6 })).await;
    socket
        .request(json!(8), "emulator.setIgnition", json!({ "on": true }))
        .await;
    let mut both = [socket.next().await, socket.next().await];
    both.sort_by_key(|message| message["_tag"] == "Exit");
    assert_state_chunk(&both[0], 6, true);
    assert_eq!(both[1], success_null(json!(8)));

    socket
        .send(json!({ "_tag": "Interrupt", "requestId": 6 }))
        .await;
    assert_eq!(
        socket.next().await,
        exit(
            json!(6),
            json!({ "_tag": "Failure", "cause": [{ "_tag": "Interrupt" }] })
        )
    );
    socket
        .request(
            json!(6),
            "reader.setPolling",
            json!({ "paused": true, "interval": 1000 }),
        )
        .await;
    assert_eq!(socket.next().await, success_null(json!(6)));
}

#[tokio::test]
async fn closes_the_socket_with_effects_codes() {
    let server = start().await;
    let absent =
        |id: u64| json!({ "_tag": "Chunk", "requestId": id, "values": [{ "_tag": "absent" }] });

    let mut reused = Socket::open(server.address).await;
    reused
        .request(json!(9), "firmware.subscribeWireKey", Value::Null)
        .await;
    assert_eq!(reused.next().await, absent(9));
    reused
        .request(json!(9), "firmware.subscribeWireKey", Value::Null)
        .await;
    assert_eq!(reused.closed().await, Some(json!(1001)));

    let mut ended = Socket::open(server.address).await;
    ended
        .request(json!(1), "firmware.subscribeWireKey", Value::Null)
        .await;
    assert_eq!(ended.next().await, absent(1));
    ended.send(json!({ "_tag": "Eof" })).await;
    assert_eq!(ended.drain().await, Vec::<Value>::new());
    ended
        .request(
            json!(2),
            "reader.setPolling",
            json!({ "paused": true, "interval": 1000 }),
        )
        .await;
    assert_eq!(ended.closed().await, Some(json!(1001)));

    let mut crashed = Socket::open(server.address).await;
    crashed.send_text("null").await;
    assert_eq!(crashed.closed().await, Some(json!(1011)));

    let mut open = Socket::open(server.address).await;
    assert_eq!(open.closed().await, None);
}

struct HttpResponse {
    status: u16,
    content_type: Option<String>,
    content_security_policy: Option<String>,
    content_type_options: Option<String>,
    body: String,
}

async fn http(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> HttpResponse {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    if !headers.iter().any(|(name, _)| *name == "Host") {
        request.push_str(&format!("Host: {address}\r\n"));
    }
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let mut lines = head.lines();
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let mut content_type = None;
    let mut content_security_policy = None;
    let mut content_type_options = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(": ").unwrap();
        match name.to_ascii_lowercase().as_str() {
            "content-type" => content_type = Some(value.to_owned()),
            "content-security-policy" => content_security_policy = Some(value.to_owned()),
            "x-content-type-options" => content_type_options = Some(value.to_owned()),
            "transfer-encoding" => chunked = value == "chunked",
            _ => {}
        }
    }
    assert!(!chunked, "{response}");
    HttpResponse {
        status,
        content_type,
        content_security_policy,
        content_type_options,
        body: body.to_owned(),
    }
}

#[tokio::test]
async fn serves_health_and_the_web_app_to_its_own_pages_only() {
    let server = start().await;
    let address = server.address;
    let own_origin = format!("http://{address}");
    let health = (200, Some("application/json"), r#"{"ok":true}"#);
    let refused = (403, None, "");
    let missing = (404, None, "");
    for (path, headers, (status, content_type, body)) in [
        ("/api/health", vec![], health),
        (
            "/",
            vec![],
            (
                200,
                Some("text/html; charset=utf-8"),
                "<!doctype html><title>fme</title>\n",
            ),
        ),
        (
            "/assets/app.js",
            vec![],
            (200, Some("text/javascript; charset=utf-8"), "export {};\n"),
        ),
        ("/assets", vec![], missing),
        ("/missing.js", vec![], missing),
        ("/%2e%2e/package.json", vec![], missing),
        (
            "/api/health",
            vec![("Origin", "https://evil.example")],
            refused,
        ),
        ("/api/health", vec![("Origin", own_origin.as_str())], health),
        ("/api/health", vec![("Host", "evil.example")], refused),
    ] {
        let response = http(address, "GET", path, &headers).await;
        assert_eq!(response.status, status, "{path} {headers:?}");
        assert_eq!(
            response.content_type.as_deref(),
            content_type,
            "{path} {headers:?}"
        );
        assert_eq!(response.body, body, "{path} {headers:?}");
        assert_eq!(
            response.content_security_policy.as_deref(),
            Some("frame-ancestors 'none'"),
            "{path} {headers:?}"
        );
        assert_eq!(
            response.content_type_options.as_deref(),
            Some("nosniff"),
            "{path} {headers:?}"
        );
    }
    assert_eq!(http(address, "POST", "/api/health", &[]).await.status, 404);
    let foreign_upgrade = http(
        address,
        "GET",
        "/ws",
        &[
            ("Upgrade", "websocket"),
            ("Connection", "Upgrade"),
            ("Sec-WebSocket-Version", "13"),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("Origin", "https://evil.example"),
        ],
    )
    .await;
    assert_eq!(foreign_upgrade.status, 403);
}
