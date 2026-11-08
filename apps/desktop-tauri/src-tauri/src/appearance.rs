//! The appearance the user picked, kept in `settings.json` in the data dir as Electron keeps it,
//! and applied to the native window so the page only follows `prefers-color-scheme`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Theme, WebviewWindow};

use crate::menu::AppearanceItems;

pub const CHANGED_EVENT: &str = "fme:appearance-changed";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    pub const ALL: [(Self, &str); 3] = [
        (Self::System, "System"),
        (Self::Light, "Light"),
        (Self::Dark, "Dark"),
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .map(|(appearance, _)| appearance)
            .find(|appearance| appearance.id() == id)
    }

    pub fn theme(self) -> Option<Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(Theme::Light),
            Self::Dark => Some(Theme::Dark),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    appearance: Appearance,
}

#[derive(Debug)]
pub struct Settings {
    file: PathBuf,
    appearance: Mutex<Appearance>,
}

impl Settings {
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("settings.json");
        let appearance = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<SettingsFile>(&text).ok())
            .unwrap_or_default()
            .appearance;
        Self {
            file,
            appearance: Mutex::new(appearance),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Appearance> {
        self.appearance
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn appearance(&self) -> Appearance {
        *self.lock()
    }

    /// Stores `appearance` and reports whether it changed.
    fn replace(&self, appearance: Appearance) -> bool {
        let mut current = self.lock();
        if *current == appearance {
            return false;
        }
        *current = appearance;
        drop(current);
        if let Err(error) = self.save(appearance) {
            tracing::error!(%error, "Could not save settings");
        }
        true
    }

    fn save(&self, appearance: Appearance) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(&SettingsFile { appearance })?;
        std::fs::write(&self.file, format!("{text}\n"))
    }
}

/// The web app's `--window` token per theme, so the window never flashes the other color.
pub fn window_color(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(0x15, 0x12, 0x11, 0xff),
        _ => Color(0xf4, 0xf1, 0xef, 0xff),
    }
}

pub fn paint<R: Runtime>(window: &WebviewWindow<R>, theme: Theme) {
    if let Err(error) = window.set_background_color(Some(window_color(theme))) {
        tracing::warn!(%error, "Could not set the window color");
    }
}

pub fn apply<R: Runtime>(app: &AppHandle<R>, appearance: Appearance) {
    app.set_theme(appearance.theme());
    if !app.state::<Settings>().replace(appearance) {
        return;
    }
    app.state::<AppearanceItems<R>>().check(appearance);
    if let Err(error) = app.emit(CHANGED_EVENT, appearance) {
        tracing::warn!(%error, "Could not announce the appearance");
    }
}

#[tauri::command]
pub fn appearance_get(settings: State<'_, Settings>) -> Appearance {
    settings.appearance()
}

#[tauri::command]
pub fn appearance_set<R: Runtime>(app: AppHandle<R>, appearance: Appearance) {
    apply(&app, appearance);
}
