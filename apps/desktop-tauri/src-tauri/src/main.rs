//! The Tauri desktop app: the Rust server runs in this process on a free loopback port, and the
//! window loads the web app from Tauri's own origin, which stays the same across launches.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod menu;
mod server;

use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::ExitCode;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    App, AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::appearance::Settings;
use crate::server::EmbeddedServer;

pub const PRODUCT_NAME: &str = "Open Freematics Emulator";
pub const MAIN_WINDOW: &str = "main";

const BRIDGE_SCRIPT: &str = include_str!("bridge.js");
#[cfg(target_os = "macos")]
const DRAG_SCRIPT: &str = include_str!("drag.js");

/// The origin the page loads from, which the server lets talk to `/ws`. Built apps use Tauri's
/// asset protocol, which WebView2 serves over http; `tauri dev` loads Vite's dev server.
fn app_origin<R: Runtime>(app: &AppHandle<R>) -> String {
    let dev_url = app.config().build.dev_url.as_ref().filter(|_| cfg!(dev));
    match dev_url {
        Some(url) => origin_of(url),
        None if cfg!(windows) => "http://tauri.localhost".to_owned(),
        None => "tauri://localhost".to_owned(),
    }
}

/// JavaScript's `URL.origin`, which the url crate leaves opaque for custom schemes.
fn origin_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

/// The old Electron app's `userData` directory, so its presets, firmware and settings carry over.
fn data_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    match std::env::var_os("FME_DATA_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(app.path().config_dir()?.join(PRODUCT_NAME)),
    }
}

fn open_externally<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        tracing::warn!(%error, "Could not open a link in the browser");
    }
}

fn open_window<R: Runtime>(
    app: &AppHandle<R>,
    origin: String,
    server_url: &str,
) -> tauri::Result<()> {
    let bridge = BRIDGE_SCRIPT
        .replace("__FME_SERVER_URL__", &serde_json::to_string(server_url)?)
        .replace("__FME_APPEARANCE_EVENT__", appearance::CHANGED_EVENT);
    let links = app.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title(PRODUCT_NAME)
        .inner_size(1320.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .visible(false)
        .theme(app.state::<Settings>().appearance().theme())
        .initialization_script(bridge)
        // Only the app's own pages load in the window; links leave for the system browser.
        .on_navigation(move |url| origin_of(url) == origin)
        .on_new_window(move |url, _| {
            open_externally(&links, &url);
            NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                tracing::info!(url = %payload.url(), "Loaded the window");
                if let Err(error) = window.show() {
                    tracing::warn!(%error, "Could not show the window");
                }
            }
        });
    // The web toolbar is the title bar; it leaves room for the window buttons.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 19.0))
        .initialization_script(DRAG_SCRIPT);
    let window = builder.build()?;
    if let Ok(theme) = window.theme() {
        appearance::paint(&window, theme);
    }
    let painted = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::ThemeChanged(theme) = event {
            appearance::paint(&painted, *theme);
        }
    });
    Ok(())
}

fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = data_dir(&handle)?;
    let settings = Settings::load(&data_dir);
    let current = settings.appearance();
    app.manage(settings);
    handle.set_theme(current.theme());
    menu::install(&handle, current)?;
    if handle.config().plugins.0.contains_key("updater") {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())?;
    }
    let origin = app_origin(&handle);
    let server = EmbeddedServer::start(&handle, data_dir, origin.clone())?;
    open_window(&handle, origin, &server.url)?;
    app.manage(server);
    tauri::async_runtime::spawn(async move {
        shutdown_signal().await;
        handle.exit(0);
    });
    Ok(())
}

/// Ctrl+C or SIGTERM quit the app the way the menu does, so the server stops cleanly.
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
    let app = tauri::Builder::default()
        // A second instance would fight the first over the serial port; it focuses the first.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                window.unminimize().ok();
                window.set_focus().ok();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            appearance::appearance_get,
            appearance::appearance_set
        ])
        .on_menu_event(|app, event| menu::handle(app, &event))
        .setup(setup)
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            tracing::error!(%error, "Couldn't start the app");
            return ExitCode::FAILURE;
        }
    };
    let code = app.run_return(|app, event| {
        if let RunEvent::Exit = event
            && let Some(server) = app.try_state::<EmbeddedServer>()
        {
            server.stop();
        }
    });
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
