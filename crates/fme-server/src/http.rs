//! The HTTP side: the health route, the built web app, the RPC socket at `/ws`, and the guard
//! that keeps other origins out of all of them.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use effect_rpc::Handlers;
use serde_json::json;
use url::Url;

const LOOPBACK_HOSTNAMES: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
// Firmware images and vendor files travel inside RPC payloads.
const MAX_MESSAGE_SIZE: usize = 1 << 30;

/// `URL.host` in JavaScript: the hostname, then the port unless it is the scheme's default.
fn url_host(url: &Url) -> Option<String> {
    let hostname = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname.to_owned(),
    })
}

/// Browsers let any web page open a WebSocket to this server, so a browser request must come from
/// a page this server served: same origin, on a loopback host (which also defeats DNS rebinding).
/// The desktop window is the one other page allowed: it names its own origin as `app_origin`.
/// No `Origin` means a local non-browser client such as `hardware:check`.
pub fn is_local_request(
    host: Option<&str>,
    origin: Option<&str>,
    app_origin: Option<&str>,
) -> bool {
    let Some(host) = host.and_then(|host| Url::parse(&format!("http://{host}")).ok()) else {
        return false;
    };
    if !host
        .host_str()
        .is_some_and(|hostname| LOOPBACK_HOSTNAMES.contains(&hostname))
    {
        return false;
    }
    let Some(origin) = origin else {
        return true;
    };
    if app_origin.is_some_and(|app_origin| app_origin == origin) {
        return true;
    }
    Url::parse(origin).is_ok_and(|origin| {
        origin.scheme() == "http"
            && url_host(&origin).is_some()
            && url_host(&origin) == url_host(&host)
    })
}

async fn local_only(
    State(app_origin): State<Option<Arc<str>>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let host = headers.get(header::HOST).map(|value| value.to_str());
    let origin = headers.get(header::ORIGIN).map(|value| value.to_str());
    let allowed = match (host, origin) {
        (Some(Ok(host)), None) => is_local_request(Some(host), None, app_origin.as_deref()),
        (Some(Ok(host)), Some(Ok(origin))) => {
            is_local_request(Some(host), Some(origin), app_origin.as_deref())
        }
        _ => false,
    };
    if allowed {
        return next.run(request).await;
    }
    tracing::warn!(
        host = ?headers.get(header::HOST),
        origin = ?headers.get(header::ORIGIN),
        "Rejected a request from another origin"
    );
    StatusCode::FORBIDDEN.into_response()
}

async fn socket(State(handlers): State<Arc<Handlers>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .max_message_size(MAX_MESSAGE_SIZE)
        .max_frame_size(MAX_MESSAGE_SIZE)
        .on_upgrade(move |socket| effect_rpc::axum::serve(socket, handlers))
}

/// Effect's `HttpStaticServer` types; anything else is `application/octet-stream`.
fn mime_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("xml") => "application/xml; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("md") => "text/markdown; charset=utf-8",
        Some("yaml" | "yml") => "text/yaml; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml; charset=utf-8",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        Some("mp3") => "audio/mpeg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("aac") => "audio/aac",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("gz") => "application/gzip",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

/// The file a URL path names inside `root`, or `None` when it would leave it.
fn resolve_within(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(url_path)
        .decode_utf8()
        .ok()?;
    if decoded.contains('\0') {
        return None;
    }
    let mut resolved = root.to_path_buf();
    let mut depth = 0_usize;
    for component in Path::new(decoded.trim_start_matches('/')).components() {
        match component {
            Component::Normal(part) => {
                resolved.push(part);
                depth += 1;
            }
            Component::ParentDir => {
                depth = depth.checked_sub(1)?;
                resolved.pop();
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(resolved)
}

async fn file_response(path: &Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime_type(path)),
                (header::ACCEPT_RANGES, "bytes"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Serves the built web app like Effect's static server: files by path, a directory's
/// `index.html`, and 404 for anything else.
async fn web_app(State(root): State<Arc<Path>>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(path) = resolve_within(&root, uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => file_response(&path).await,
        Ok(metadata) if metadata.is_dir() => file_response(&path.join("index.html")).await,
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

/// Every route, behind the local-only guard. `web_root` is the built web app, `None` in dev,
/// where Vite serves it and proxies `/ws` here instead.
pub fn router(handlers: Handlers, web_root: Option<&Path>, app_origin: Option<String>) -> Router {
    let mut router = Router::new()
        .route("/ws", get(socket).fallback(not_found))
        .with_state(Arc::new(handlers))
        .route(
            "/api/health",
            get(|| async { axum::Json(json!({ "ok": true })) }).fallback(not_found),
        );
    match web_root {
        Some(root) if root.is_dir() => {
            let web_app = Router::new().fallback(web_app).with_state(Arc::from(root));
            router = router.fallback_service(web_app);
        }
        Some(root) => {
            tracing::warn!(root = %root.display(), "Web assets unavailable; serving the API only");
        }
        None => {}
    }
    router.layer(middleware::from_fn_with_state(
        app_origin.map(Arc::from),
        local_only,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_static_paths_inside_the_web_root() {
        let root = Path::new("/srv/web");
        let cases = [
            ("/", Some("/srv/web")),
            ("/assets/app.js", Some("/srv/web/assets/app.js")),
            ("//assets/./app%20x.js", Some("/srv/web/assets/app x.js")),
            ("/assets/../index.html", Some("/srv/web/index.html")),
            ("/../package.json", None),
            ("/%2e%2e/package.json", None),
            ("/assets/%00", None),
            ("/%ff", None),
        ];
        for (url_path, expected) in cases {
            assert_eq!(
                resolve_within(root, url_path),
                expected.map(PathBuf::from),
                "{url_path}"
            );
        }
    }

    #[test]
    fn allows_only_same_origin_loopback_requests() {
        let cases = [
            (
                "the desktop window",
                Some("127.0.0.1:52731"),
                Some("http://127.0.0.1:52731"),
                true,
            ),
            (
                "the dev server through Vite",
                Some("localhost:5738"),
                Some("http://localhost:5738"),
                true,
            ),
            (
                "an IPv6 loopback page",
                Some("[::1]:3738"),
                Some("http://[::1]:3738"),
                true,
            ),
            (
                "a local script without an Origin",
                Some("127.0.0.1:3738"),
                None,
                true,
            ),
            (
                "another website",
                Some("127.0.0.1:3738"),
                Some("https://evil.example"),
                false,
            ),
            (
                "another local port",
                Some("127.0.0.1:3738"),
                Some("http://127.0.0.1:8080"),
                false,
            ),
            (
                "localhost against 127.0.0.1",
                Some("127.0.0.1:3738"),
                Some("http://localhost:3738"),
                false,
            ),
            (
                "a sandboxed or file:// page",
                Some("127.0.0.1:3738"),
                Some("null"),
                false,
            ),
            (
                "DNS rebinding",
                Some("evil.example:3738"),
                Some("http://evil.example:3738"),
                false,
            ),
            (
                "a LAN address",
                Some("192.168.1.20:3738"),
                Some("http://192.168.1.20:3738"),
                false,
            ),
            ("a missing Host", None, None, false),
        ];
        for (case, host, origin, allowed) in cases {
            assert_eq!(is_local_request(host, origin, None), allowed, "{case}");
        }
    }

    #[test]
    fn allows_the_desktop_app_origin_only_on_loopback() {
        let cases = [
            (
                "the desktop window",
                "127.0.0.1:52731",
                "fme://app",
                Some("fme://app"),
                true,
            ),
            (
                "the desktop origin without the flag",
                "127.0.0.1:52731",
                "fme://app",
                None,
                false,
            ),
            (
                "another custom scheme",
                "127.0.0.1:52731",
                "evil://app",
                Some("fme://app"),
                false,
            ),
            (
                "a lookalike host",
                "127.0.0.1:52731",
                "fme://app.evil",
                Some("fme://app"),
                false,
            ),
            (
                "the desktop origin on a rebound host",
                "evil.example:52731",
                "fme://app",
                Some("fme://app"),
                false,
            ),
            (
                "its own served page",
                "127.0.0.1:52731",
                "http://127.0.0.1:52731",
                Some("fme://app"),
                true,
            ),
        ];
        for (case, host, origin, app_origin, allowed) in cases {
            assert_eq!(
                is_local_request(Some(host), Some(origin), app_origin),
                allowed,
                "{case}"
            );
        }
    }
}
