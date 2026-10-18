// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Chrome starts native messaging hosts with the calling extension's
    // origin as the first argument; the host checks it. Host mode never
    // starts Tauri.
    let first = std::env::args_os().nth(1);
    if folio_desktop_lib::native_host::is_host_invocation(first.as_deref()) {
        std::process::exit(folio_desktop_lib::native_host::run_stdio(first.as_deref()));
    }
    folio_desktop_lib::run();
}
