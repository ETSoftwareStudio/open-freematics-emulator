fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let commands = tauri_build::AppManifest::new().commands(&["appearance_get", "appearance_set"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))?;
    Ok(())
}
