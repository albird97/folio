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
            "save_file_as",
            "write_granted_file",
            "print_window",
            "print_pdf",
            "app_info",
            "recovery_list",
            "recovery_save_snapshot",
            "recovery_save_file",
            "recovery_has_file",
            "recovery_load_snapshot",
            "recovery_load_file",
            "recovery_file_keys",
            "recovery_remove",
            "recent_list",
            "recent_open",
            "recent_remove",
            "recent_clear",
            "set_close_guard",
            "confirm_close",
            "cancel_close",
            "take_pending_transfers",
            "answer_transfer",
            "native_messaging_status",
            "ai_key_status",
            "ai_set_key",
            "ai_forget_key",
            "ai_request",
            "ai_cancel",
        ]),
    ))
    .expect("failed to run tauri-build");
}
