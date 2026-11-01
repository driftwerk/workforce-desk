include!("src/commands.rs");

fn main() {
    // Declaring the app's commands makes Tauri check every one of them
    // against the calling window's capabilities.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Desk's build failed");
}
