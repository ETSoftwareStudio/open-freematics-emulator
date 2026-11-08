//! The Rust server, run in this process on a free loopback port.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use fme_server::server::{Server, ServerError, ServerOptions};
use tauri::async_runtime::{self, JoinHandle};
use tauri::{AppHandle, Runtime};
use tokio::sync::oneshot;

/// Longer than the server's own wait for a device exchange in flight.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct EmbeddedServer {
    /// What the page connects to; the port is new each launch.
    pub url: String,
    running: Mutex<Option<(oneshot::Sender<()>, JoinHandle<()>)>>,
}

impl EmbeddedServer {
    /// Binds before the window opens, so the page gets a working URL. A server that fails later
    /// quits the app, as the Electron app does when its server process exits.
    pub fn start<R: Runtime>(
        app: &AppHandle<R>,
        data_dir: PathBuf,
        app_origin: String,
    ) -> Result<Self, ServerError> {
        let server = async_runtime::block_on(Server::bind(ServerOptions {
            host: "127.0.0.1".to_owned(),
            port: 0,
            web_root: None,
            data_dir,
            app_origin: Some(app_origin),
        }))?;
        let url = format!("ws://{}/ws", server.local_addr());
        let (stop, stopped) = oneshot::channel::<()>();
        let app = app.clone();
        let task = async_runtime::spawn(async move {
            let quitting = async {
                stopped.await.ok();
            };
            if let Err(error) = server.serve(quitting).await {
                let source = std::error::Error::source(&error).map(ToString::to_string);
                tracing::error!(source, "{error}");
                app.exit(1);
            }
        });
        Ok(Self {
            url,
            running: Mutex::new(Some((stop, task))),
        })
    }

    /// Stops serving and waits for the device links to close, so the serial port is free.
    pub fn stop(&self) {
        let running = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some((stop, task)) = running else {
            return;
        };
        stop.send(()).ok();
        match async_runtime::block_on(async { tokio::time::timeout(STOP_TIMEOUT, task).await }) {
            Ok(Ok(())) => tracing::info!("Server stopped"),
            Ok(Err(error)) => tracing::error!(%error, "The server task failed"),
            Err(_) => tracing::warn!("The server did not stop in time"),
        }
    }
}
