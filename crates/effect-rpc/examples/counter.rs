//! A counter served to an Effect client at `ws://127.0.0.1:3000/rpc`.
//!
//! Run it with `cargo run -p effect-rpc --example counter --features axum`. The matching
//! `RpcGroup` is in the crate's README.

use std::sync::Arc;

use axum::Router;
use axum::extract::{State, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use effect_rpc::{Handlers, changes};
use tokio::net::TcpListener;
use tokio::sync::watch;

effect_rpc::tagged_struct! {
    #[derive(Debug)]
    pub struct StepTooLarge("StepTooLarge") {
        pub max_step: u32,
    }
}

effect_rpc::typed_errors!(StepTooLarge);

#[derive(serde::Deserialize)]
struct Increment {
    step: u32,
}

const MAX_STEP: u32 = 10;

fn handlers(count: &watch::Sender<u32>) -> Handlers {
    let mut handlers = Handlers::new();
    handlers
        .unary("Increment", count, |count, Increment { step }| async move {
            if step > MAX_STEP {
                return Err(StepTooLarge { max_step: MAX_STEP });
            }
            count.send_modify(|count| *count += step);
            Ok(*count.borrow())
        })
        .infallible("Reset", count, |count, (): ()| async move {
            count.send_replace(0);
        })
        .stream("Count", count, |count, (): ()| changes(count.subscribe()));
    handlers
}

async fn rpc(State(handlers): State<Arc<Handlers>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| effect_rpc::axum::serve(socket, handlers))
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (count, _) = watch::channel(0);
    let app = Router::new()
        .route("/rpc", get(rpc))
        .with_state(Arc::new(handlers(&count)));
    let listener = TcpListener::bind("127.0.0.1:3000").await?;
    axum::serve(listener, app).await
}
