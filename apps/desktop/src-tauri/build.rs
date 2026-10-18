fn main() {
    // Declaring the app's commands makes Tauri generate `allow-*`/`deny-*`
    // permissions for them, so the webview can only call what the capability
    // file grants.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_pdf_files",
            "read_granted_file",
            "release_file",
            "take_pending_files",
            "save_pdf_as",
            "app_info",
        ]),
    ))
    .expect("failed to run tauri-build");
}
