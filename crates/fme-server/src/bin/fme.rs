//! `fme`: the server on its own, as the npm package and `vp run dev` run it.

use std::io::IsTerminal;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use fme_server::server::{self, ServerOptions};

#[derive(Debug, Default)]
struct Args {
    host: Option<String>,
    port: Option<String>,
    dev: bool,
    // The desktop app ships the built web app next to the server.
    web_root: Option<String>,
    // The desktop app passes its own data directory.
    data_dir: Option<String>,
    // The desktop app loads the web app from its own origin and connects to `/ws` from there.
    app_origin: Option<String>,
}

/// `util.parseArgs` in strict mode: `--name value` or `--name=value`, the last one wins.
fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut parsed = Args::default();
    while let Some(arg) = args.next() {
        let Some(option) = arg.strip_prefix("--") else {
            return Err(format!("Unexpected argument '{arg}'"));
        };
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (option, None),
        };
        if name == "dev" {
            if inline.is_some() {
                return Err("Option '--dev' does not take an argument".to_owned());
            }
            parsed.dev = true;
            continue;
        }
        let slot = match name {
            "host" => &mut parsed.host,
            "port" => &mut parsed.port,
            "web-root" => &mut parsed.web_root,
            "data-dir" => &mut parsed.data_dir,
            "app-origin" => &mut parsed.app_origin,
            _ => return Err(format!("Unknown option '--{name}'")),
        };
        let value = match inline {
            Some(value) => value,
            None => args
                .next()
                .ok_or_else(|| format!("Option '--{name} <value>' argument missing"))?,
        };
        *slot = Some(value);
    }
    Ok(parsed)
}

fn non_empty_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn default_data_dir() -> PathBuf {
    let home = std::env::home_dir().unwrap_or_default();
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Open Freematics Emulator")
    } else if cfg!(windows) {
        non_empty_env("APPDATA")
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Open Freematics Emulator")
    } else {
        non_empty_env("XDG_CONFIG_HOME")
            .unwrap_or_else(|| home.join(".config"))
            .join("open-freematics-emulator")
    }
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

fn options(args: Args) -> Result<ServerOptions, String> {
    let port = args
        .port
        .or_else(|| std::env::var("FME_SERVER_PORT").ok())
        .unwrap_or_else(|| "3738".to_owned());
    let port = port
        .parse()
        .map_err(|_| format!("'{port}' isn't a port number"))?;
    let web_root = args.web_root.map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist"),
        PathBuf::from,
    );
    let host = args.host.unwrap_or_else(|| "127.0.0.1".to_owned());
    if !host
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
    {
        return Err(format!(
            "'{host}' isn't a loopback address; the server only serves this machine (use 127.0.0.1 or ::1)"
        ));
    }
    Ok(ServerOptions {
        host,
        port,
        web_root: (!args.dev).then(|| absolute(&web_root)),
        data_dir: absolute(&args.data_dir.map_or_else(default_data_dir, PathBuf::from)),
        app_origin: args.app_origin,
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_target(false)
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    let options = match parse_args(std::env::args().skip(1)).and_then(options) {
        Ok(options) => options,
        Err(message) => {
            tracing::error!("{message}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "Couldn't start the async runtime");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(server::run(options, shutdown_signal())) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let source = std::error::Error::source(&error).map(ToString::to_string);
            tracing::error!(source, "{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, String> {
        parse_args(args.iter().map(|arg| (*arg).to_owned()))
    }

    #[test]
    fn parses_flags_like_node_parse_args() {
        let args = parse(&[
            "--port=0",
            "--dev",
            "--data-dir",
            "/tmp/fme",
            "--app-origin=fme://app",
            "--host",
            "::1",
            "--port",
            "3740",
        ])
        .unwrap();
        assert_eq!(args.port.as_deref(), Some("3740"));
        assert!(args.dev);
        assert_eq!(args.data_dir.as_deref(), Some("/tmp/fme"));
        assert_eq!(args.app_origin.as_deref(), Some("fme://app"));
        assert_eq!(args.host.as_deref(), Some("::1"));
        assert!(args.web_root.is_none());
    }

    #[test]
    fn rejects_what_strict_parse_args_rejects() {
        for args in [&["--verbose"][..], &["--dev=yes"], &["--port"], &["serve"]] {
            assert!(parse(args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn dev_mode_serves_no_web_app() {
        let dev = options(parse(&["--dev", "--port", "0", "--data-dir", "data"]).unwrap()).unwrap();
        assert!(dev.web_root.is_none());
        assert!(dev.data_dir.is_absolute());
        assert_eq!(dev.host, "127.0.0.1");
        assert!(options(parse(&["--port", "http"]).unwrap()).is_err());
    }

    #[test]
    fn listens_on_loopback_addresses_only() {
        for (host, allowed) in [
            ("127.0.0.1", true),
            ("::1", true),
            ("0.0.0.0", false),
            ("::", false),
            ("192.168.1.20", false),
            ("localhost", false),
            ("example.com", false),
        ] {
            let parsed = options(parse(&["--host", host, "--data-dir", "data"]).unwrap());
            assert_eq!(parsed.is_ok(), allowed, "{host}");
        }
    }
}
