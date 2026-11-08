//! Builds the services over a data dir and serves them over HTTP, as `server.ts` does.

use std::future::{Future, IntoFuture};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::device::serial_ports::SerialPorts;
use crate::device::simulated_device::SimulatedDevice;
use crate::device::tcp_sockets::TcpSockets;
use crate::emulator::emulator_session::EmulatorSession;
use crate::firmware::FirmwareServices;
use crate::firmware::vendor_package::{HttpClient, HttpError, ReqwestClient};
use crate::http;
use crate::obd::obd_reader::ObdReader;
use crate::presets::preset_store::PresetStore;
use crate::traffic::traffic_log::TrafficLog;
use crate::ws::{self, Services};

#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub host: String,
    pub port: u16,
    /// Built web app to serve; `None` in dev, where Vite serves it.
    pub web_root: Option<PathBuf>,
    /// Where user presets, the wire key and firmware images are kept.
    pub data_dir: PathBuf,
    /// The desktop window's origin, which serves the web app itself and only talks to `/ws` here.
    pub app_origin: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("Couldn't set up the HTTP client.")]
    HttpClient(#[source] HttpError),
    #[error("Couldn't listen on {address}.")]
    Bind {
        address: String,
        #[source]
        source: std::io::Error,
    },
    #[error("The HTTP server stopped.")]
    Serve(#[source] std::io::Error),
}

impl Services {
    /// Every service over `data_dir`, with the simulated MK2 alongside the real ports.
    pub async fn new(data_dir: &Path, http: Arc<dyn HttpClient>) -> Self {
        let serial_ports = SerialPorts;
        let simulated = SimulatedDevice::default();
        let traffic = TrafficLog::new();
        let session = EmulatorSession::new(serial_ports, simulated.clone(), traffic.clone());
        let reader = ObdReader::new(serial_ports, TcpSockets, simulated.clone(), traffic.clone());
        let presets = Arc::new(PresetStore::new(data_dir, session.clone()).await);
        let firmware = FirmwareServices::new(
            data_dir,
            serial_ports,
            simulated,
            session.clone(),
            traffic.clone(),
            http,
        )
        .await;
        Self {
            session,
            traffic,
            reader,
            presets,
            firmware,
        }
    }
}

/// Binds, logs "Listening on http://…" (the desktop shell and the dev runner wait for it), and
/// serves until `shutdown` resolves. Open sockets are dropped then, not drained.
pub async fn run(
    options: ServerOptions,
    shutdown: impl Future<Output = ()> + Send,
) -> Result<(), ServerError> {
    let client = ReqwestClient::new().map_err(ServerError::HttpClient)?;
    let services = Services::new(&options.data_dir, Arc::new(client)).await;
    let app = http::router(
        ws::handlers(&services),
        options.web_root.as_deref(),
        options.app_origin,
    );
    let listener = TcpListener::bind((options.host.as_str(), options.port))
        .await
        .map_err(|source| ServerError::Bind {
            address: format!("{}:{}", options.host, options.port),
            source,
        })?;
    let local: SocketAddr = listener.local_addr().map_err(ServerError::Serve)?;
    tracing::info!("Listening on http://{local}");
    tokio::select! {
        result = axum::serve(listener, app).into_future() => result.map_err(ServerError::Serve),
        () = shutdown => Ok(()),
    }
}
