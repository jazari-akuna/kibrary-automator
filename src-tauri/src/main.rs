#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod protocol;
mod sidecar;
mod commands;

use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // P1: rely on the user's `python3` on PATH. Bundling a frozen sidecar
    // binary is a P3 concern (signed installers).
    //
    // Dev-time override: set KIBRARY_SIDECAR_PYTHON to a venv interpreter, e.g.:
    //   export KIBRARY_SIDECAR_PYTHON=/path/to/.venv/bin/python3
    // This is needed when kibrary_sidecar is installed in a virtualenv that
    // is not the system python3.
    let python_path = std::env::var("KIBRARY_SIDECAR_PYTHON")
        .unwrap_or_else(|_| "python3".to_string());

    let sc = Arc::new(sidecar::Sidecar::spawn(&python_path, "kibrary_sidecar").await?);

    tauri::Builder::default()
        .manage(sc)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_ping,
            commands::sidecar_version,
            commands::workspace_open,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
