//! Builds the services over a data dir and serves them over HTTP.

use std::future::{Future, IntoFuture};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
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
        Self::with_serial_ports(data_dir, http, SerialPorts::default()).await
    }

    /// [`Services::new`] over the given serial ports, which tests replace with a fake system.
    pub async fn with_serial_ports(
        data_dir: &Path,
        http: Arc<dyn HttpClient>,
        serial_ports: SerialPorts,
    ) -> Self {
        let simulated = SimulatedDevice::default();
        let traffic = TrafficLog::new();
        let session =
            EmulatorSession::new(serial_ports.clone(), simulated.clone(), traffic.clone());
        let reader = ObdReader::new(
            serial_ports.clone(),
            TcpSockets,
            simulated.clone(),
            traffic.clone(),
        );
        let presets = Arc::new(PresetStore::new(data_dir, session.clone()).await);
        let firmware = FirmwareServices::new(
            data_dir,
            serial_ports.clone(),
            simulated,
            session.clone(),
            traffic.clone(),
            http,
        )
        .await;
        Self {
            serial_ports,
            session,
            traffic,
            reader,
            presets,
            firmware,
        }
    }
}

/// How long a quitting server waits for a device exchange in flight before it lets go anyway.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

/// The services behind a bound listener, so the address is known before serving.
#[derive(Debug)]
pub struct Server {
    services: Services,
    app: Router,
    listener: TcpListener,
    local: SocketAddr,
}

impl Server {
    /// Builds the services, binds, and logs "Listening on http://…" (the desktop shells, the dev
    /// runner and the smoke tests wait for it).
    pub async fn bind(options: ServerOptions) -> Result<Self, ServerError> {
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
        let local = listener.local_addr().map_err(ServerError::Serve)?;
        tracing::info!("Listening on http://{local}");
        Ok(Self {
            services,
            app,
            listener,
            local,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// Serves until `shutdown` resolves, then closes the device links so the ports are free.
    /// Open sockets are dropped, not drained.
    pub async fn serve(self, shutdown: impl Future<Output = ()> + Send) -> Result<(), ServerError> {
        let result = tokio::select! {
            result = axum::serve(self.listener, self.app).into_future() => result.map_err(ServerError::Serve),
            () = shutdown => Ok(()),
        };
        let close = async {
            tokio::join!(
                self.services.session.disconnect(),
                self.services.reader.disconnect()
            );
            self.services.serial_ports.close_held().await;
        };
        if tokio::time::timeout(CLOSE_TIMEOUT, close).await.is_err() {
            tracing::warn!("A device exchange was still running at shutdown");
        }
        result
    }
}

/// [`Server::bind`], then [`Server::serve`] until `shutdown` resolves.
pub async fn run(
    options: ServerOptions,
    shutdown: impl Future<Output = ()> + Send,
) -> Result<(), ServerError> {
    Server::bind(options).await?.serve(shutdown).await
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::sync::oneshot;

    use super::*;

    async fn health_status(address: SocketAddr, origin: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        let request = format!(
            "GET /api/health HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response.lines().next().unwrap_or_default().to_owned()
    }

    #[tokio::test]
    async fn binds_a_free_port_lets_the_app_origin_in_and_stops_on_shutdown() {
        let data_dir = tempfile::tempdir().unwrap();
        let server = Server::bind(ServerOptions {
            host: "127.0.0.1".to_owned(),
            port: 0,
            web_root: None,
            data_dir: data_dir.path().to_path_buf(),
            app_origin: Some("tauri://localhost".to_owned()),
        })
        .await
        .unwrap();
        let address = server.local_addr();
        assert_ne!(address.port(), 0);
        let (stop, stopped) = oneshot::channel::<()>();
        let serving = tokio::spawn(server.serve(async {
            stopped.await.ok();
        }));

        assert_eq!(
            health_status(address, "tauri://localhost").await,
            "HTTP/1.1 200 OK"
        );
        assert_eq!(
            health_status(address, "http://example.com").await,
            "HTTP/1.1 403 Forbidden"
        );

        stop.send(()).unwrap();
        serving.await.unwrap().unwrap();
        assert!(TcpStream::connect(address).await.is_err());
    }
}
