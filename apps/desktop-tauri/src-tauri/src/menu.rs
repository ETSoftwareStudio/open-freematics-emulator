#[cfg(any(debug_assertions, not(target_os = "macos")))]
use tauri::menu::MenuItem;
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuEvent, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

use crate::PRODUCT_NAME;
use crate::appearance::{self, Appearance};

const APPEARANCE_PREFIX: &str = "appearance:";
#[cfg(not(target_os = "macos"))]
const FULLSCREEN: &str = "fullscreen";
#[cfg(debug_assertions)]
const RELOAD: &str = "reload";
#[cfg(debug_assertions)]
const DEVTOOLS: &str = "devtools";

const CREDITS: &str = "An independent, unofficial app for the Freematics OBD-II Emulator MK2. \
                       Not affiliated with, endorsed by or supported by Freematics.";

/// The View → Appearance items. Menus have no radio items, so these checks are kept in sync.
pub struct AppearanceItems<R: Runtime>(Vec<(Appearance, CheckMenuItem<R>)>);

impl<R: Runtime> AppearanceItems<R> {
    pub fn check(&self, appearance: Appearance) {
        for (item_appearance, item) in &self.0 {
            if let Err(error) = item.set_checked(*item_appearance == appearance) {
                tracing::warn!(%error, "Could not update the Appearance menu");
            }
        }
    }
}

fn about<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PredefinedMenuItem<R>> {
    let metadata = AboutMetadata {
        name: Some(PRODUCT_NAME.to_owned()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("Developed by ET Software Studio Inc. · etsoftware.studio".to_owned()),
        credits: Some(CREDITS.to_owned()),
        comments: Some(CREDITS.to_owned()),
        website: Some("https://etsoftware.studio".to_owned()),
        icon: app.default_window_icon().cloned(),
        ..AboutMetadata::default()
    };
    PredefinedMenuItem::about(app, Some(&format!("About {PRODUCT_NAME}")), Some(metadata))
}

fn separator<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PredefinedMenuItem<R>> {
    PredefinedMenuItem::separator(app)
}

fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    if cfg!(target_os = "macos") {
        Submenu::with_items(
            app,
            PRODUCT_NAME,
            true,
            &[
                &about(app)?,
                &separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )
    } else {
        Submenu::with_items(app, "File", true, &[&PredefinedMenuItem::quit(app, None)?])
    }
}

fn edit_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &separator(app)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )
}

fn view_menu<R: Runtime>(
    app: &AppHandle<R>,
    current: Appearance,
) -> tauri::Result<(Submenu<R>, AppearanceItems<R>)> {
    let items = Appearance::ALL
        .into_iter()
        .map(|(appearance, label)| {
            let id = format!("{APPEARANCE_PREFIX}{}", appearance.id());
            CheckMenuItem::with_id(app, id, label, true, appearance == current, None::<&str>)
                .map(|item| (appearance, item))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let appearance_menu = Submenu::with_items(app, "Appearance", true, &[])?;
    for (_, item) in &items {
        appearance_menu.append(item)?;
    }
    let view = Submenu::with_items(app, "View", true, &[&appearance_menu, &separator(app)?])?;
    #[cfg(debug_assertions)]
    view.append_items(&[
        &MenuItem::with_id(app, RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?,
        &MenuItem::with_id(
            app,
            DEVTOOLS,
            "Toggle Developer Tools",
            true,
            Some(if cfg!(target_os = "macos") {
                "Alt+Cmd+I"
            } else {
                "Ctrl+Shift+I"
            }),
        )?,
        &separator(app)?,
    ])?;
    #[cfg(target_os = "macos")]
    view.append(&PredefinedMenuItem::fullscreen(app, None)?)?;
    #[cfg(not(target_os = "macos"))]
    view.append(&MenuItem::with_id(
        app,
        FULLSCREEN,
        "Toggle Full Screen",
        true,
        Some("F11"),
    )?)?;
    Ok((view, AppearanceItems(items)))
}

fn window_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?],
    )?;
    if cfg!(target_os = "macos") {
        window.append_items(&[
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ])?;
        #[cfg(target_os = "macos")]
        window.set_as_windows_menu_for_nsapp()?;
    } else {
        window.append(&PredefinedMenuItem::close_window(app, None)?)?;
    }
    Ok(window)
}

fn help_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let help = Submenu::with_items(app, "Help", true, &[])?;
    #[cfg(target_os = "macos")]
    help.set_as_help_menu_for_nsapp()?;
    #[cfg(not(target_os = "macos"))]
    help.append(&about(app)?)?;
    Ok(help)
}

/// Sets the app menu and keeps the Appearance items to check them as the appearance changes.
pub fn install<R: Runtime>(app: &AppHandle<R>, current: Appearance) -> tauri::Result<()> {
    let (view, appearance_items) = view_menu(app, current)?;
    let menu = Menu::with_items(
        app,
        &[
            &app_menu(app)?,
            &edit_menu(app)?,
            &view,
            &window_menu(app)?,
            &help_menu(app)?,
        ],
    )?;
    app.set_menu(menu)?;
    app.manage(appearance_items);
    Ok(())
}

#[cfg(any(debug_assertions, not(target_os = "macos")))]
fn main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    app.get_webview_window(crate::MAIN_WINDOW)
        .ok_or(tauri::Error::WindowNotFound)
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    let id = event.id().as_ref();
    if let Some(name) = id.strip_prefix(APPEARANCE_PREFIX) {
        if let Some(appearance) = Appearance::from_id(name) {
            appearance::apply(app, appearance);
            // A click toggles the item it hit, so restore the checks even when nothing changed.
            app.state::<AppearanceItems<R>>().check(appearance);
        }
        return;
    }
    let result: tauri::Result<()> = match id {
        #[cfg(not(target_os = "macos"))]
        FULLSCREEN => main_window(app).and_then(|window| {
            window
                .is_fullscreen()
                .and_then(|fullscreen| window.set_fullscreen(!fullscreen))
        }),
        #[cfg(debug_assertions)]
        RELOAD => main_window(app).and_then(|window| window.reload()),
        #[cfg(debug_assertions)]
        DEVTOOLS => main_window(app).map(|window| {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }),
        _ => Ok(()),
    };
    if let Err(error) = result {
        tracing::warn!(%error, menu = id, "Menu action failed");
    }
}
